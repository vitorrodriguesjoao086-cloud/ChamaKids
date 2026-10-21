// Servidor do ChamaKids — sem dependências externas.
// Rotas:
//   GET  /            app das professoras (PWA)
//   GET  /painel      página aberta no computador da comunicação
//   GET  /events      fluxo em tempo real (SSE) para o painel
//   POST /chamar      recebe { numero } e repassa ao painel
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_NUMERO = 100;

// Limites de proteção (o uso real é muito pequeno, então são folgados)
const MAX_CHAMADOS_POR_MIN = 30;      // por origem de rede
const MAX_PAINEIS_TOTAL = 40;         // conexões abertas ao mesmo tempo
const MAX_PAINEIS_POR_ORIGEM = 10;

const painéis = new Set();
const conexoesPorOrigem = new Map();
const janelas = new Map();

const tipos = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// ---------- Utilidades de segurança ----------
function origemDeRede(req) {
  // Atrás do Render, o último endereço de X-Forwarded-For é o que o proxy viu.
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const partes = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (partes.length) return partes[partes.length - 1];
  }
  return req.socket.remoteAddress || 'desconhecida';
}

function dentroDoLimite(chave, max, ms) {
  const agora = Date.now();
  const lista = (janelas.get(chave) || []).filter((t) => agora - t < ms);
  if (lista.length >= max) { janelas.set(chave, lista); return false; }
  lista.push(agora);
  janelas.set(chave, lista);
  return true;
}
setInterval(() => {
  const agora = Date.now();
  for (const [chave, lista] of janelas) {
    if (!lista.some((t) => agora - t < 60000)) janelas.delete(chave);
  }
}, 60000);

// Só aceita pedidos que partem do próprio site (bloqueia outros sites de dispararem chamados).
function pedidoDoMesmoSite(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') return false;
  const origem = req.headers.origin;
  if (origem) {
    try { return new URL(origem).host === req.headers.host; } catch { return false; }
  }
  return true;
}

function cabecalhosDeSeguranca(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
}

// Política de conteúdo: só scripts do próprio site e os blocos <script> que existem nos nossos arquivos.
function politicaDeConteudo(html) {
  const hashes = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    hashes.push(`'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  }
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function enviarJSON(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', (c) => {
      dados += c;
      if (dados.length > 1024) { reject(new Error('corpo grande demais')); req.destroy(); }
    });
    req.on('end', () => resolve(dados));
    req.on('error', reject);
  });
}

function servirArquivo(req, res, urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/painel') urlPath = '/painel.html';
  if (/[\0\\]/.test(urlPath) || urlPath.split('/').some((p) => p.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Não encontrado');
  }
  const arquivo = path.normalize(path.join(PUBLIC, urlPath));
  if (!arquivo.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(arquivo, (err, conteudo) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    const ext = path.extname(arquivo);
    const cabecalhos = {
      'Content-Type': tipos[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || urlPath === '/sw.js' ? 'no-cache' : 'public, max-age=3600',
    };
    if (ext === '.html') cabecalhos['Content-Security-Policy'] = politicaDeConteudo(conteudo.toString('utf8'));
    res.writeHead(200, cabecalhos);
    res.end(conteudo);
  });
}

const servidor = http.createServer(async (req, res) => {
  cabecalhosDeSeguranca(req, res);
  const { pathname } = new URL(req.url, 'http://localhost');
  const origemRede = origemDeRede(req);

  if (req.method === 'GET' && pathname === '/events') {
    const daOrigem = conexoesPorOrigem.get(origemRede) || 0;
    if (painéis.size >= MAX_PAINEIS_TOTAL || daOrigem >= MAX_PAINEIS_POR_ORIGEM) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '30' });
      return res.end('Muitas conexões abertas');
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    painéis.add(res);
    conexoesPorOrigem.set(origemRede, daOrigem + 1);
    req.on('close', () => {
      painéis.delete(res);
      const restante = (conexoesPorOrigem.get(origemRede) || 1) - 1;
      if (restante <= 0) conexoesPorOrigem.delete(origemRede); else conexoesPorOrigem.set(origemRede, restante);
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/chamar') {
    if (!pedidoDoMesmoSite(req)) return enviarJSON(res, 403, { ok: false, erro: 'Origem não permitida' });
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return enviarJSON(res, 415, { ok: false, erro: 'Tipo de conteúdo não aceito' });
    }
    if (!dentroDoLimite(`chamar:${origemRede}`, MAX_CHAMADOS_POR_MIN, 60000)) {
      res.setHeader('Retry-After', '30');
      return enviarJSON(res, 429, { ok: false, erro: 'Muitos chamados em pouco tempo' });
    }
    try {
      const { numero } = JSON.parse(await lerCorpo(req));
      if (!Number.isInteger(numero) || numero < 0 || numero > MAX_NUMERO) {
        return enviarJSON(res, 400, { ok: false, erro: 'Número inválido' });
      }
      const msg = `data: ${JSON.stringify({ numero, em: Date.now() })}\n\n`;
      for (const painel of painéis) painel.write(msg);
      console.log(`[${new Date().toLocaleTimeString('pt-BR')}] Chamado: ${numero} (painéis conectados: ${painéis.size})`);
      return enviarJSON(res, 200, { ok: true, ouvintes: painéis.size });
    } catch {
      return enviarJSON(res, 400, { ok: false, erro: 'Pedido inválido' });
    }
  }

  if (req.method === 'GET') return servirArquivo(req, res, pathname);
  res.writeHead(405); res.end();
});

// Derruba pedidos que ficam "pendurados" (ataques de conexão lenta)
servidor.headersTimeout = 10000;
servidor.requestTimeout = 15000;

// Mantém a conexão viva atrás de proxies (ex.: Render)
setInterval(() => { for (const p of painéis) p.write(': ping\n\n'); }, 20000);

servidor.listen(PORT, () => console.log(`ChamaKids rodando na porta ${PORT}`));
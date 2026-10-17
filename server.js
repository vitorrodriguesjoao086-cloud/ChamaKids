// Servidor do ChamaKids — sem dependências externas.
// Rotas:
//   GET  /            app das professoras (PWA)
//   GET  /painel      página aberta no computador da comunicação
//   GET  /events      fluxo em tempo real (SSE) para o painel
//   POST /chamar      recebe { numero } e repassa ao painel
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_NUMERO = 100;

const painéis = new Set();

const tipos = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

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
  const arquivo = path.normalize(path.join(PUBLIC, urlPath));
  if (!arquivo.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(arquivo, (err, conteudo) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); }
    const ext = path.extname(arquivo);
    res.writeHead(200, {
      'Content-Type': tipos[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || urlPath === '/sw.js' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(conteudo);
  });
}

const servidor = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    painéis.add(res);
    req.on('close', () => painéis.delete(res));
    return;
  }

  if (req.method === 'POST' && pathname === '/chamar') {
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

// Mantém a conexão viva atrás de proxies (ex.: Render)
setInterval(() => { for (const p of painéis) p.write(': ping\n\n'); }, 20000);

servidor.listen(PORT, () => console.log(`ChamaKids rodando na porta ${PORT}`));

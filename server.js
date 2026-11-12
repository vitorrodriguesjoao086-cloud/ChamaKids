// Servidor do ChamaKids — sem dependências externas.
//
// Rotas principais:
//   GET  /                   app das professoras (PWA)
//   GET  /painel              página da comunicação
//   GET  /admin               painel de aprovação
//   GET  /events              fluxo em tempo real para a comunicação
//   GET  /api/eu              estado da sessão atual
//   POST /api/acesso/solicitar cria uma solicitação de acesso
//   POST /api/entrar           autentica uma conta aprovada
//   POST /api/sair             encerra a sessão
//   GET  /api/admin/usuarios   lista solicitações e contas (só administrador)
//   POST /api/admin/usuarios/:id/:acao aprova, recusa ou revoga acesso
//   POST /chamar               envia um chamado (só conta aprovada)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_NUMERO = 100;
const MAX_CONTAS = 500;
const SESSAO_CURTA_MS = 12 * 60 * 60 * 1000;
const SESSAO_LEMBRADA_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_NAME = String(process.env.ADMIN_NAME || '').trim().replace(/\s+/g, ' ');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ARQUIVO_BANCO = path.join(DATA_DIR, 'acessos.json');
const ARQUIVO_SEGREDO = path.join(DATA_DIR, 'session-secret');
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/$/, '');
const REDIS_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const USA_REDIS = REDIS_URL !== '' && REDIS_TOKEN !== '';
const CHAVE_BANCO = 'chamakids:acessos';
const CHAVE_SEGREDO = 'chamakids:session-secret';
const scrypt = promisify(crypto.scrypt);

if (ADMIN_NAME.length < 3 || ADMIN_NAME.length > 80 || ADMIN_PASSWORD.length < 12) {
  throw new Error('Configure ADMIN_NAME e ADMIN_PASSWORD (mínimo de 12 caracteres) para iniciar o servidor.');
}

const tipos = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const painéis = new Set();
const conexoesPorOrigem = new Map();
const janelas = new Map();
const MAX_PAINEIS_TOTAL = 40;
const MAX_PAINEIS_POR_ORIGEM = 10;

function nomeNormalizado(nome) {
  return String(nome || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

function chaveNome(nome) {
  return nomeNormalizado(nome);
}

function clonar(valor) {
  return JSON.parse(JSON.stringify(valor));
}

async function redis(comando) {
  const resposta = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(comando),
    signal: AbortSignal.timeout(5000),
  });
  const dados = await resposta.json();
  if (!resposta.ok || dados.error) throw new Error(dados.error || `Redis ${resposta.status}`);
  return dados.result;
}

function gravarArquivoSeguro(arquivo, conteudo) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const temporario = `${arquivo}.${process.pid}.tmp`;
  fs.writeFileSync(temporario, conteudo, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporario, arquivo);
}

async function carregarSegredo() {
  if (process.env.SESSION_SECRET) {
    if (process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET deve ter pelo menos 32 caracteres.');
    return process.env.SESSION_SECRET;
  }
  if (USA_REDIS) {
    let segredo = await redis(['GET', CHAVE_SEGREDO]);
    if (!segredo) {
      segredo = crypto.randomBytes(48).toString('base64url');
      await redis(['SET', CHAVE_SEGREDO, segredo]);
    }
    return String(segredo);
  }
  try {
    return fs.readFileSync(ARQUIVO_SEGREDO, 'utf8');
  } catch (erro) {
    if (erro.code !== 'ENOENT') throw erro;
    const segredo = crypto.randomBytes(48).toString('base64url');
    gravarArquivoSeguro(ARQUIVO_SEGREDO, segredo);
    return segredo;
  }
}

async function carregarBanco() {
  if (USA_REDIS) {
    const salvo = await redis(['GET', CHAVE_BANCO]);
    if (!salvo) return { users: [] };
    const banco = JSON.parse(salvo);
    if (!banco || !Array.isArray(banco.users)) throw new Error('Banco de acessos inválido no Redis.');
    return banco;
  }
  try {
    const banco = JSON.parse(fs.readFileSync(ARQUIVO_BANCO, 'utf8'));
    if (!banco || !Array.isArray(banco.users)) throw new Error('Banco de acessos inválido.');
    return banco;
  } catch (erro) {
    if (erro.code !== 'ENOENT') throw erro;
    return { users: [] };
  }
}

let banco = { users: [] };
let segredoSessao = '';
let filaGravacao = Promise.resolve();

function salvarBanco(novoBanco) {
  if (USA_REDIS) return redis(['SET', CHAVE_BANCO, JSON.stringify(novoBanco)]).then(() => undefined);
  gravarArquivoSeguro(ARQUIVO_BANCO, JSON.stringify(novoBanco));
  return Promise.resolve();
}

function alterarBanco(alterar) {
  const operacao = filaGravacao.then(async () => {
    const copia = clonar(banco);
    const resultado = alterar(copia);
    await salvarBanco(copia);
    banco = copia;
    return resultado;
  });
  filaGravacao = operacao.catch(() => {});
  return operacao;
}

function gerarId() {
  return crypto.randomUUID();
}

async function criarHash(senha) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(senha, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt: salt.toString('base64url'), hash: Buffer.from(hash).toString('base64url') };
}

async function senhaCorreta(senha, conta) {
  const salt = Buffer.from(conta.salt, 'base64url');
  const hash = await scrypt(senha, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const esperado = Buffer.from(conta.hash, 'base64url');
  return esperado.length === hash.length && crypto.timingSafeEqual(esperado, hash);
}

async function prepararAdministrador() {
  const identificador = chaveNome(ADMIN_NAME);
  const contaAtual = banco.users.find((u) => u.key === identificador && u.admin);
  const senhaAtualCorreta = Boolean(contaAtual && await senhaCorreta(ADMIN_PASSWORD, contaAtual));
  const outrosAdministradores = banco.users.some((u) => u.admin && u.key !== identificador);
  if (senhaAtualCorreta && !outrosAdministradores) return;
  const credencial = senhaAtualCorreta ? null : await criarHash(ADMIN_PASSWORD);
  await alterarBanco((dados) => {
    for (const usuario of dados.users) {
      if (usuario.admin && usuario.key !== identificador) {
        usuario.admin = false;
        usuario.status = 'revoked';
        usuario.sessionVersion = (usuario.sessionVersion || 0) + 1;
        usuario.updatedAt = new Date().toISOString();
      }
    }
    let conta = dados.users.find((u) => u.key === identificador);
    if (!conta) {
      conta = { id: gerarId(), name: ADMIN_NAME, key: identificador, createdAt: new Date().toISOString(), sessionVersion: 0 };
      dados.users.push(conta);
    }
    const alterouPermissao = !conta.admin || conta.status !== 'approved';
    conta.name = ADMIN_NAME;
    conta.admin = true;
    conta.status = 'approved';
    if (credencial) {
      conta.salt = credencial.salt;
      conta.hash = credencial.hash;
    }
    if (credencial || alterouPermissao) conta.sessionVersion = (conta.sessionVersion || 0) + 1;
    if (credencial || alterouPermissao) conta.updatedAt = new Date().toISOString();
  });
}

function assinar(texto) {
  return crypto.createHmac('sha256', segredoSessao).update(texto).digest('base64url');
}

function criarSessao(conta, lembrar) {
  const duracao = lembrar ? SESSAO_LEMBRADA_MS : SESSAO_CURTA_MS;
  const corpo = Buffer.from(JSON.stringify({
    id: conta.id,
    v: conta.sessionVersion || 0,
    x: Date.now() + duracao,
  })).toString('base64url');
  return { valor: `${corpo}.${assinar(corpo)}`, duracao };
}

function lerCookies(req) {
  const saida = {};
  for (const par of (req.headers.cookie || '').split(';')) {
    const i = par.indexOf('=');
    if (i > 0) saida[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  }
  return saida;
}

function lerSessao(req) {
  const valor = lerCookies(req).ck_sessao;
  if (!valor) return null;
  const [corpo, assinatura] = valor.split('.');
  if (!corpo || !assinatura) return null;
  const esperado = Buffer.from(assinar(corpo));
  const recebido = Buffer.from(assinatura);
  if (esperado.length !== recebido.length || !crypto.timingSafeEqual(esperado, recebido)) return null;
  try {
    const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
    if (!dados.id || !(dados.x > Date.now())) return null;
    const conta = banco.users.find((u) => u.id === dados.id);
    if (!conta || conta.status !== 'approved' || (conta.sessionVersion || 0) !== dados.v) return null;
    return conta;
  } catch {
    return null;
  }
}

function cookieSessao(req, valor, maxAge) {
  const seguro = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const idade = maxAge === null ? '' : `; Max-Age=${maxAge}`;
  return `ck_sessao=${valor}; Path=/; HttpOnly; SameSite=Lax${idade}${seguro}`;
}

function origemDeRede(req) {
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
  if (lista.length >= max) {
    janelas.set(chave, lista);
    return false;
  }
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
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

function politicaDeConteudo(html) {
  const hashes = [];
  const regex = /<script>([\s\S]*?)<\/script>/g;
  let trecho;
  while ((trecho = regex.exec(html)) !== null) {
    hashes.push(`'sha256-${crypto.createHash('sha256').update(trecho[1], 'utf8').digest('base64')}'`);
  }
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'none'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function enviarJSON(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function lerCorpo(req, limite = 8192) {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', (parte) => {
      dados += parte;
      if (Buffer.byteLength(dados, 'utf8') > limite) {
        reject(new Error('corpo grande demais'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(dados));
    req.on('error', reject);
  });
}

const ehJSON = (req) => (req.headers['content-type'] || '').toLowerCase().startsWith('application/json');

async function lerJSON(req) {
  try { return JSON.parse(await lerCorpo(req)); } catch { return null; }
}

async function exigirAprovacao(req, res, admin = false) {
  const conta = lerSessao(req);
  if (!conta) {
    enviarJSON(res, 401, { ok: false, codigo: 'sem_login', erro: 'Entre com uma conta aprovada.' });
    return null;
  }
  if (admin && !conta.admin) {
    enviarJSON(res, 403, { ok: false, codigo: 'sem_permissao', erro: 'Apenas o administrador pode realizar esta ação.' });
    return null;
  }
  return conta;
}

function servirArquivo(res, urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/painel') urlPath = '/painel.html';
  if (urlPath === '/admin') urlPath = '/admin.html';
  if (/[\0\\]/.test(urlPath) || urlPath.split('/').some((parte) => parte.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Não encontrado');
  }
  const arquivo = path.normalize(path.join(PUBLIC, urlPath));
  if (!arquivo.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(arquivo, (erro, conteudo) => {
    if (erro) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Não encontrado');
    }
    const extensao = path.extname(arquivo);
    const cabecalhos = {
      'Content-Type': tipos[extensao] || 'application/octet-stream',
      'Cache-Control': extensao === '.html' || urlPath === '/sw.js' ? 'no-cache' : 'public, max-age=3600',
    };
    if (extensao === '.html') cabecalhos['Content-Security-Policy'] = politicaDeConteudo(conteudo.toString('utf8'));
    res.writeHead(200, cabecalhos);
    res.end(conteudo);
  });
}

function listarContas() {
  return banco.users.map((conta) => ({
    id: conta.id,
    nome: conta.name,
    solicitadaEm: conta.requestedAt || conta.createdAt,
    status: conta.admin ? 'administrador' : conta.status,
    administrador: Boolean(conta.admin),
  })).sort((a, b) => String(b.solicitadaEm).localeCompare(String(a.solicitadaEm)));
}

async function tratar(req, res) {
  cabecalhosDeSeguranca(req, res);
  const { pathname } = new URL(req.url, 'http://localhost');
  const origemRede = origemDeRede(req);

  if (req.method === 'GET' && pathname === '/api/eu') {
    const conta = lerSessao(req);
    return enviarJSON(res, 200, {
      autenticacaoAtiva: true,
      logado: Boolean(conta),
      ...(conta ? { id: conta.id, nome: conta.name, admin: Boolean(conta.admin), autorizado: true } : {}),
    });
  }

  if (req.method === 'POST' && (pathname === '/api/acesso/solicitar' || pathname === '/api/entrar')) {
    if (!pedidoDoMesmoSite(req)) return enviarJSON(res, 403, { ok: false, erro: 'Origem não permitida.' });
    if (!ehJSON(req)) return enviarJSON(res, 415, { ok: false, erro: 'Tipo de conteúdo não aceito.' });
    const limitePorRota = pathname.endsWith('/entrar') ? 10 : 5;
    if (!dentroDoLimite(`${pathname}:${origemRede}`, limitePorRota, 60000)) {
      res.setHeader('Retry-After', '60');
      return enviarJSON(res, 429, { ok: false, codigo: 'muitas_tentativas', erro: 'Muitas tentativas. Aguarde um minuto e tente novamente.' });
    }
    const dados = await lerJSON(req);
    const nome = typeof dados?.nome === 'string' ? dados.nome.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
    const senha = typeof dados?.senha === 'string' ? dados.senha : '';
    if (nome.length < 3 || nome.length > 80 || !senha || senha.length > 128) {
      return enviarJSON(res, 400, { ok: false, erro: 'Informe o nome completo e uma senha válida.' });
    }

    if (pathname === '/api/entrar') {
      const conta = banco.users.find((u) => u.key === chaveNome(nome));
      if (!conta || !await senhaCorreta(senha, conta)) {
        return enviarJSON(res, 401, { ok: false, codigo: 'credenciais_invalidas', erro: 'Nome ou senha inválidos.' });
      }
      if (conta.status === 'pending') {
        return enviarJSON(res, 403, { ok: false, codigo: 'pendente', erro: 'Sua solicitação está aguardando aprovação do administrador.' });
      }
      if (conta.status !== 'approved') {
        return enviarJSON(res, 403, { ok: false, codigo: 'acesso_indisponivel', erro: 'Esta conta não tem acesso. Solicite novamente ou fale com o administrador.' });
      }
      const lembrar = dados.lembrar === true;
      const sessao = criarSessao(conta, lembrar);
      res.setHeader('Set-Cookie', cookieSessao(req, sessao.valor, lembrar ? Math.floor(sessao.duracao / 1000) : null));
      return enviarJSON(res, 200, { ok: true, nome: conta.name, admin: Boolean(conta.admin) });
    }

    if (senha.length < 8) return enviarJSON(res, 400, { ok: false, erro: 'A senha deve ter pelo menos 8 caracteres.' });
    const chave = chaveNome(nome);
    if (chave === chaveNome(ADMIN_NAME)) {
      return enviarJSON(res, 409, { ok: false, codigo: 'conta_existente', erro: 'Esta conta já está cadastrada. Entre com sua senha.' });
    }
    const credencial = await criarHash(senha);
    try {
      const resultado = await alterarBanco((dadosBanco) => {
        let conta = dadosBanco.users.find((u) => u.key === chave);
        if (conta && conta.status === 'pending') return 'pendente';
        if (conta && conta.status === 'approved') return 'existente';
        if (conta) {
          conta.name = nome;
          conta.status = 'pending';
          conta.salt = credencial.salt;
          conta.hash = credencial.hash;
          conta.requestedAt = new Date().toISOString();
          conta.updatedAt = conta.requestedAt;
          conta.sessionVersion = (conta.sessionVersion || 0) + 1;
          return 'pendente';
        }
        if (dadosBanco.users.length >= MAX_CONTAS) return 'limite';
        const agora = new Date().toISOString();
        dadosBanco.users.push({
          id: gerarId(),
          name: nome,
          key: chave,
          ...credencial,
          status: 'pending',
          requestedAt: agora,
          createdAt: agora,
          updatedAt: agora,
          sessionVersion: 0,
        });
        return 'pendente';
      });
      if (resultado === 'limite') return enviarJSON(res, 400, { ok: false, erro: 'O limite de solicitações foi atingido.' });
      if (resultado === 'existente') return enviarJSON(res, 409, { ok: false, codigo: 'conta_existente', erro: 'Esta conta já tem acesso. Entre com sua senha.' });
      return enviarJSON(res, 201, { ok: true, codigo: 'pendente', mensagem: 'Solicitação enviada. O acesso será liberado após a aprovação do administrador.' });
    } catch (erro) {
      console.error('Falha ao salvar solicitação de acesso:', erro.message);
      return enviarJSON(res, 500, { ok: false, erro: 'Não foi possível salvar a solicitação. Tente novamente.' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/sair') {
    if (!pedidoDoMesmoSite(req)) return enviarJSON(res, 403, { ok: false, erro: 'Origem não permitida.' });
    res.setHeader('Set-Cookie', cookieSessao(req, '', 0));
    return enviarJSON(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/events') {
    const conta = await exigirAprovacao(req, res);
    if (!conta) return;
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
    res.ckSessao = { id: conta.id, versao: conta.sessionVersion || 0 };
    painéis.add(res);
    conexoesPorOrigem.set(origemRede, daOrigem + 1);
    req.on('close', () => {
      painéis.delete(res);
      const restante = (conexoesPorOrigem.get(origemRede) || 1) - 1;
      if (restante <= 0) conexoesPorOrigem.delete(origemRede);
      else conexoesPorOrigem.set(origemRede, restante);
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/chamar') {
    if (!pedidoDoMesmoSite(req)) return enviarJSON(res, 403, { ok: false, erro: 'Origem não permitida.' });
    if (!ehJSON(req)) return enviarJSON(res, 415, { ok: false, erro: 'Tipo de conteúdo não aceito.' });
    if (!dentroDoLimite(`chamar:${origemRede}`, 30, 60000)) {
      res.setHeader('Retry-After', '30');
      return enviarJSON(res, 429, { ok: false, erro: 'Muitos chamados em pouco tempo.' });
    }
    if (!await exigirAprovacao(req, res)) return;
    const dados = await lerJSON(req);
    const numero = dados?.numero;
    if (!Number.isInteger(numero) || numero < 0 || numero > MAX_NUMERO) {
      return enviarJSON(res, 400, { ok: false, erro: 'Número inválido.' });
    }
    const mensagem = `data: ${JSON.stringify({ numero, em: Date.now() })}\n\n`;
    for (const painel of painéis) painel.write(mensagem);
    console.log(`[${new Date().toLocaleTimeString('pt-BR')}] Chamado: ${numero} (painéis conectados: ${painéis.size})`);
    return enviarJSON(res, 200, { ok: true, ouvintes: painéis.size });
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!dentroDoLimite(`admin:${origemRede}`, 60, 60000)) {
      return enviarJSON(res, 429, { ok: false, erro: 'Muitos pedidos.' });
    }
    if (req.method !== 'GET' && (!pedidoDoMesmoSite(req) || !ehJSON(req))) {
      return enviarJSON(res, 403, { ok: false, erro: 'Pedido não permitido.' });
    }
    if (!await exigirAprovacao(req, res, true)) return;
    if (req.method === 'GET' && pathname === '/api/admin/usuarios') {
      return enviarJSON(res, 200, { ok: true, usuarios: listarContas() });
    }
    const acao = pathname.match(/^\/api\/admin\/usuarios\/([0-9a-f-]{36})\/(aprovar|recusar|revogar)$/i);
    if (req.method === 'POST' && acao) {
      const [, id, operacao] = acao;
      const resultado = await alterarBanco((dadosBanco) => {
        const conta = dadosBanco.users.find((u) => u.id === id);
        if (!conta || conta.admin) return 'nao_encontrada';
        if (operacao === 'aprovar' && conta.status === 'pending') conta.status = 'approved';
        else if (operacao === 'recusar' && conta.status === 'pending') conta.status = 'rejected';
        else if (operacao === 'revogar' && conta.status === 'approved') conta.status = 'revoked';
        else return 'conflito';
        conta.updatedAt = new Date().toISOString();
        conta.sessionVersion = (conta.sessionVersion || 0) + 1;
        return 'ok';
      });
      if (resultado === 'nao_encontrada') return enviarJSON(res, 404, { ok: false, erro: 'Conta não encontrada.' });
      if (resultado === 'conflito') return enviarJSON(res, 409, { ok: false, erro: 'O status desta conta já foi alterado.' });
      return enviarJSON(res, 200, { ok: true, usuarios: listarContas() });
    }
    res.writeHead(405, { Allow: 'GET, POST' });
    return res.end();
  }

  if (req.method === 'GET') return servirArquivo(res, pathname);
  res.writeHead(405);
  res.end();
}

const servidor = http.createServer((req, res) => {
  tratar(req, res).catch((erro) => {
    console.error('Erro inesperado:', erro.message);
    if (!res.headersSent) enviarJSON(res, 500, { ok: false, erro: 'Erro interno. Tente novamente.' });
    else res.end();
  });
});

servidor.headersTimeout = 10000;
servidor.requestTimeout = 15000;
setInterval(() => {
  for (const painel of painéis) {
    const sessao = painel.ckSessao;
    const conta = sessao && banco.users.find((u) => u.id === sessao.id);
    if (!conta || conta.status !== 'approved' || (conta.sessionVersion || 0) !== sessao.versao) {
      painel.write('event: auth-expired\ndata: {}\n\n');
      painel.end();
    } else {
      painel.write(': ping\n\n');
    }
  }
}, 20000);

async function iniciarServidor() {
  segredoSessao = await carregarSegredo();
  banco = await carregarBanco();
  await prepararAdministrador();
  servidor.listen(PORT, () => {
    console.log(`ChamaKids rodando na porta ${PORT}. Autenticação própria ativa.`);
    console.log(`Armazenamento de acessos: ${USA_REDIS ? 'Upstash Redis' : ARQUIVO_BANCO}.`);
    if (!USA_REDIS) console.log('Garanta que DATA_DIR esteja em armazenamento persistente no ambiente de hospedagem.');
  });
}

iniciarServidor().catch((erro) => {
  console.error('Não foi possível iniciar o ChamaKids:', erro.message);
  process.exitCode = 1;
});

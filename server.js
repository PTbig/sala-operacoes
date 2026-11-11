'use strict';
/*
 * Sala de Operações: servidor de coordenação de ocorrências.
 * Sem dependências externas. Requer Node.js 22.13 ou superior (node:sqlite).
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/* ---------------- configuração ---------------- */
loadEnv(path.join(__dirname, '.env'));
const PORT = +process.env.PORT || 8080;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const FOTOS_DIR = path.join(DATA_DIR, 'fotos');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';
const SESSION_DAYS = +process.env.SESSION_DAYS || 7;
const MAX_FOTO = 12 * 1024 * 1024;
fs.mkdirSync(FOTOS_DIR, { recursive: true });

function loadEnv(f) {
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const POSTOS = { bombeiro: 1, chefe: 2, comando: 3, central: 4 };
const EST_OCC = ['Aberta', 'Em curso', 'Concluída'];
const EST_VEI = ['Disponível', 'Em ocorrência', 'Inoperacional'];
const EST_EL = ['Disponível', 'Em serviço', 'Indisponível'];
const DEFAULT_CONFIG = {
  corporacao: 'Corpo de Bombeiros',
  tiposOcorrencia: ['Queda de árvore', 'Inundação', 'Deslizamento de terras', 'Queda de estrutura', 'Cabos elétricos', 'Via obstruída', 'Salvamento', 'Incêndio', 'Apoio a população', 'Outro'],
  tiposVeiculo: ['VCOT', 'VLCI', 'VFCI', 'VUCI', 'VECI', 'VSAT', 'VTTU', 'VTPT', 'ABSC', 'ABTM', 'VOPE', 'Outro'],
  mapaCentro: { lat: 39.6, lng: -8.0, zoom: 7 },
};

/* ---------------- base de dados ---------------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'sala.db'));
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS membros(id INTEGER PRIMARY KEY, utilizador TEXT UNIQUE NOT NULL COLLATE NOCASE, nome TEXT NOT NULL,
  numero TEXT DEFAULT '', posto TEXT NOT NULL, hash TEXT NOT NULL, obriga_troca INTEGER DEFAULT 1, ativo INTEGER DEFAULT 1,
  estado TEXT DEFAULT 'Disponível', criado INTEGER);
CREATE TABLE IF NOT EXISTS sessoes(token TEXT PRIMARY KEY, membro_id INTEGER NOT NULL REFERENCES membros(id) ON DELETE CASCADE, expira INTEGER);
CREATE TABLE IF NOT EXISTS ocorrencias(id INTEGER PRIMARY KEY, sado TEXT DEFAULT '', tipo TEXT, prioridade INTEGER, estado TEXT,
  morada TEXT DEFAULT '', descricao TEXT DEFAULT '', lat REAL, lng REAL, por INTEGER, ts INTEGER, atualizado INTEGER);
CREATE TABLE IF NOT EXISTS veiculos(id INTEGER PRIMARY KEY, sigla TEXT NOT NULL, tipo TEXT, estado TEXT DEFAULT 'Disponível',
  ocorrencia_id INTEGER REFERENCES ocorrencias(id) ON DELETE SET NULL, criado INTEGER);
CREATE TABLE IF NOT EXISTS tripulacao(membro_id INTEGER PRIMARY KEY REFERENCES membros(id) ON DELETE CASCADE,
  veiculo_id INTEGER NOT NULL REFERENCES veiculos(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS registos(id INTEGER PRIMARY KEY, ocorrencia_id INTEGER NOT NULL REFERENCES ocorrencias(id) ON DELETE CASCADE,
  tipo TEXT, texto TEXT DEFAULT '', foto TEXT, por INTEGER, ts INTEGER);
CREATE TABLE IF NOT EXISTS mensagens(id INTEGER PRIMARY KEY, texto TEXT, prioridade INTEGER DEFAULT 0,
  ocorrencia_id INTEGER REFERENCES ocorrencias(id) ON DELETE SET NULL, por INTEGER, ts INTEGER);
CREATE TABLE IF NOT EXISTS config(chave TEXT PRIMARY KEY, valor TEXT);
CREATE INDEX IF NOT EXISTS ix_reg ON registos(ocorrencia_id, ts);
CREATE INDEX IF NOT EXISTS ix_msg ON mensagens(ts);
`);
const q = (sql) => db.prepare(sql);
const now = () => Date.now();

function getConfig() {
  const c = { ...DEFAULT_CONFIG };
  for (const r of q('SELECT chave, valor FROM config').all()) { try { c[r.chave] = JSON.parse(r.valor); } catch {} }
  return c;
}

/* ---------------- palavras-passe e sessões ---------------- */
function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return 'scrypt$' + salt.toString('hex') + '$' + h.toString('hex');
}
function checkPw(pw, stored) {
  const [, s, h] = String(stored).split('$');
  if (!s || !h) return false;
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  const exp = Buffer.from(h, 'hex');
  return exp.length === calc.length && crypto.timingSafeEqual(exp, calc);
}
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
function validPw(pw) { return typeof pw === 'string' && pw.length >= 10 && pw.length <= 200; }

// Primeiro arranque: cria a conta Central.
if (!q('SELECT COUNT(*) n FROM membros').get().n) {
  let pw = process.env.ADMIN_PASSWORD;
  const gerada = !pw;
  if (gerada) pw = crypto.randomBytes(9).toString('base64url');
  const user = process.env.ADMIN_USER || 'central';
  q('INSERT INTO membros(utilizador,nome,numero,posto,hash,obriga_troca,criado) VALUES(?,?,?,?,?,1,?)')
    .run(user, 'Central', '', 'central', hashPw(pw), now());
  console.log('\n==============================================');
  console.log(' Conta inicial criada');
  console.log(' Utilizador: ' + user);
  console.log(' Palavra-passe: ' + (gerada ? pw : '(a definida em ADMIN_PASSWORD)'));
  console.log(' Vai ser pedida uma nova palavra-passe no 1.º login.');
  console.log('==============================================\n');
}
setInterval(() => q('DELETE FROM sessoes WHERE expira < ?').run(now()), 3600e3).unref();

/* ---------------- tempo real (SSE) ---------------- */
const clients = new Set();
function broadcast(ev) {
  const s = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(s);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000).unref();

/* ---------------- proteção de login ---------------- */
const tentativas = new Map();
function bloqueado(ip) {
  const t = tentativas.get(ip);
  return t && t.n >= 8 && now() - t.ts < 15 * 60e3;
}
function falhou(ip) { const t = tentativas.get(ip) || { n: 0, ts: now() }; t.n++; t.ts = now(); tentativas.set(ip, t); }

/* ---------------- HTTP ---------------- */
class HttpErr extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const err = (c, m) => { throw new HttpErr(c, m); };

function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf ? body : JSON.stringify(body ?? {});
  res.writeHead(code, { 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req, max) {
  return new Promise((ok, ko) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > max) { ko(new HttpErr(413, 'Ficheiro demasiado grande.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', ko);
  });
}
async function json(req) {
  const b = await readBody(req, 256 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { err(400, 'Pedido inválido.'); }
}
function cookies(req) {
  const o = {};
  (req.headers.cookie || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return o;
}
function sessao(req) {
  const t = cookies(req).sala;
  if (!t) return null;
  const r = q(`SELECT m.* FROM sessoes s JOIN membros m ON m.id=s.membro_id WHERE s.token=? AND s.expira>? AND m.ativo=1`).get(sha(t), now());
  return r || null;
}
const str = (v, max = 500) => (v == null ? '' : String(v).trim().slice(0, max));
const pub = (m) => ({ id: m.id, utilizador: m.utilizador, nome: m.nome, numero: m.numero, posto: m.posto, estado: m.estado, ativo: !!m.ativo, obrigaTroca: !!m.obriga_troca });

function need(me, posto) { if ((POSTOS[me.posto] || 0) < POSTOS[posto]) err(403, 'O teu posto não permite esta ação.'); }
function logReg(occ, texto, por) {
  q('INSERT INTO registos(ocorrencia_id,tipo,texto,por,ts) VALUES(?,?,?,?,?)').run(occ, 'estado', texto, por, now());
}

const routes = [];
const route = (m, p, fn, opts = {}) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, opts });

/* ---- autenticação ---- */
route('POST', '/api/login', async (req, res) => {
  const ip = req.socket.remoteAddress;
  if (bloqueado(ip)) err(429, 'Demasiadas tentativas. Aguarda 15 minutos.');
  const b = await json(req);
  const m = q('SELECT * FROM membros WHERE utilizador=? AND ativo=1').get(str(b.utilizador, 60));
  if (!m || !checkPw(String(b.password || ''), m.hash)) { falhou(ip); err(401, 'Utilizador ou palavra-passe errados.'); }
  tentativas.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  q('INSERT INTO sessoes(token,membro_id,expira) VALUES(?,?,?)').run(sha(token), m.id, now() + SESSION_DAYS * 864e5);
  send(res, 200, { me: pub(m) }, { 'Set-Cookie': `sala=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${COOKIE_SECURE ? '; Secure' : ''}` });
}, { publico: true });

route('POST', '/api/logout', async (req, res) => {
  const t = cookies(req).sala; if (t) q('DELETE FROM sessoes WHERE token=?').run(sha(t));
  send(res, 200, {}, { 'Set-Cookie': `sala=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}` });
}, { publico: true });

route('GET', '/api/me', async (req, res, me) => send(res, 200, { me: pub(me) }), { semTroca: true });

route('POST', '/api/password', async (req, res, me) => {
  const b = await json(req);
  if (!checkPw(String(b.atual || ''), me.hash)) err(400, 'A palavra-passe atual está errada.');
  if (!validPw(b.nova)) err(400, 'A nova palavra-passe tem de ter pelo menos 10 caracteres.');
  if (b.nova === b.atual) err(400, 'Escolhe uma palavra-passe diferente da atual.');
  q('UPDATE membros SET hash=?, obriga_troca=0 WHERE id=?').run(hashPw(b.nova), me.id);
  const t = cookies(req).sala;
  q('DELETE FROM sessoes WHERE membro_id=? AND token<>?').run(me.id, sha(t || ''));
  send(res, 200, { me: pub({ ...me, obriga_troca: 0 }) });
}, { semTroca: true });

/* ---- configuração ---- */
route('GET', '/api/config', async (req, res) => {
  send(res, 200, { ...getConfig(), mapsKey: MAPS_KEY });
}, { semTroca: true });
route('PUT', '/api/config', async (req, res, me) => {
  need(me, 'central');
  const b = await json(req);
  const lista = (a) => [...new Set((Array.isArray(a) ? a : []).map((x) => str(x, 40)).filter(Boolean))].slice(0, 60);
  if (b.corporacao !== undefined) q('INSERT OR REPLACE INTO config VALUES(?,?)').run('corporacao', JSON.stringify(str(b.corporacao, 80) || DEFAULT_CONFIG.corporacao));
  if (b.tiposOcorrencia) { const l = lista(b.tiposOcorrencia); if (!l.length) err(400, 'Indica pelo menos um tipo de ocorrência.'); q('INSERT OR REPLACE INTO config VALUES(?,?)').run('tiposOcorrencia', JSON.stringify(l)); }
  if (b.tiposVeiculo) { const l = lista(b.tiposVeiculo); if (!l.length) err(400, 'Indica pelo menos um tipo de veículo.'); q('INSERT OR REPLACE INTO config VALUES(?,?)').run('tiposVeiculo', JSON.stringify(l)); }
  if (b.mapaCentro && isFinite(b.mapaCentro.lat) && isFinite(b.mapaCentro.lng)) {
    q('INSERT OR REPLACE INTO config VALUES(?,?)').run('mapaCentro', JSON.stringify({ lat: +b.mapaCentro.lat, lng: +b.mapaCentro.lng, zoom: Math.min(18, Math.max(5, +b.mapaCentro.zoom || 12)) }));
  }
  broadcast({ col: 'config' });
  send(res, 200, getConfig());
});

/* ---- estado geral ---- */
route('GET', '/api/estado', async (req, res) => {
  const membros = q('SELECT m.*, t.veiculo_id FROM membros m LEFT JOIN tripulacao t ON t.membro_id=m.id ORDER BY m.nome').all()
    .map((m) => ({ ...pub(m), veiculo: m.veiculo_id ?? null }));
  const veiculos = q('SELECT * FROM veiculos ORDER BY sigla').all()
    .map((v) => ({ id: v.id, sigla: v.sigla, tipo: v.tipo, estado: v.estado, ocorrencia: v.ocorrencia_id }));
  const ocorrencias = q(`SELECT * FROM ocorrencias WHERE estado<>'Concluída' OR atualizado > ? ORDER BY ts DESC LIMIT 800`).all(now() - 7 * 864e5);
  const mensagens = q('SELECT id,texto,prioridade,ocorrencia_id ocorrencia,por,ts FROM mensagens ORDER BY ts DESC LIMIT 300').all().reverse();
  send(res, 200, { membros, veiculos, ocorrencias, mensagens });
});

route('GET', '/api/eventos', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}, { stream: true });

/* ---- ocorrências ---- */
function occBody(b, cfg, parcial) {
  const o = {};
  if (!parcial || b.tipo !== undefined) { o.tipo = str(b.tipo, 60); if (!cfg.tiposOcorrencia.includes(o.tipo)) err(400, 'Tipo de ocorrência inválido.'); }
  if (!parcial || b.prioridade !== undefined) { o.prioridade = +b.prioridade; if (![1, 2, 3].includes(o.prioridade)) err(400, 'Prioridade inválida.'); }
  if (!parcial || b.lat !== undefined || b.lng !== undefined) {
    o.lat = +b.lat; o.lng = +b.lng;
    if (!isFinite(o.lat) || !isFinite(o.lng) || Math.abs(o.lat) > 90 || Math.abs(o.lng) > 180) err(400, 'Localização inválida.');
  }
  for (const k of ['morada', 'descricao', 'sado']) if (!parcial || b[k] !== undefined) o[k] = str(b[k], k === 'descricao' ? 4000 : 200);
  if (b.estado !== undefined) { if (!EST_OCC.includes(b.estado)) err(400, 'Estado inválido.'); o.estado = b.estado; }
  return o;
}
route('POST', '/api/ocorrencias', async (req, res, me) => {
  need(me, 'chefe');
  const o = occBody(await json(req), getConfig(), false);
  const t = now();
  const r = q('INSERT INTO ocorrencias(sado,tipo,prioridade,estado,morada,descricao,lat,lng,por,ts,atualizado) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(o.sado, o.tipo, o.prioridade, 'Aberta', o.morada, o.descricao, o.lat, o.lng, me.id, t, t);
  const id = Number(r.lastInsertRowid);
  logReg(id, 'Ocorrência registada', me.id);
  broadcast({ col: 'ocorrencias', nova: { id, tipo: o.tipo, prioridade: o.prioridade, morada: o.morada, por: me.id } });
  send(res, 201, { id });
});
route('PATCH', '/api/ocorrencias/:id', async (req, res, me, p) => {
  need(me, 'chefe');
  const atual = q('SELECT * FROM ocorrencias WHERE id=?').get(+p.id) || err(404, 'Ocorrência não encontrada.');
  const o = occBody(await json(req), getConfig(), true);
  const keys = Object.keys(o); if (!keys.length) return send(res, 200, {});
  q(`UPDATE ocorrencias SET ${keys.map((k) => k + '=?').join(',')}, atualizado=? WHERE id=?`).run(...keys.map((k) => o[k]), now(), atual.id);
  if (o.estado && o.estado !== atual.estado) {
    logReg(atual.id, 'Estado: ' + o.estado, me.id);
    if (o.estado === 'Concluída') q(`UPDATE veiculos SET ocorrencia_id=NULL, estado='Disponível' WHERE ocorrencia_id=?`).run(atual.id);
  }
  if (o.prioridade && o.prioridade !== atual.prioridade) logReg(atual.id, 'Prioridade: ' + ({ 1: 'Crítica', 2: 'Alta', 3: 'Normal' })[o.prioridade], me.id);
  if (o.sado !== undefined && o.sado !== atual.sado) logReg(atual.id, 'N.º SADO: ' + (o.sado || 'removido'), me.id);
  broadcast({ col: 'ocorrencias' }); broadcast({ col: 'registos', id: atual.id });
  send(res, 200, {});
});
route('DELETE', '/api/ocorrencias/:id', async (req, res, me, p) => {
  need(me, 'comando');
  const fotos = q(`SELECT foto FROM registos WHERE ocorrencia_id=? AND foto IS NOT NULL`).all(+p.id);
  q(`UPDATE veiculos SET ocorrencia_id=NULL, estado='Disponível' WHERE ocorrencia_id=?`).run(+p.id);
  q('DELETE FROM ocorrencias WHERE id=?').run(+p.id);
  for (const f of fotos) fs.rm(path.join(FOTOS_DIR, f.foto), () => {});
  broadcast({ col: 'ocorrencias' }); broadcast({ col: 'veiculos' });
  send(res, 200, {});
});
route('GET', '/api/ocorrencias/:id/registos', async (req, res, me, p) => {
  send(res, 200, q('SELECT id,tipo,texto,foto,por,ts FROM registos WHERE ocorrencia_id=? ORDER BY ts LIMIT 1000').all(+p.id));
});
route('POST', '/api/ocorrencias/:id/notas', async (req, res, me, p) => {
  const b = await json(req); const texto = str(b.texto, 4000);
  if (!texto) err(400, 'A nota está vazia.');
  if (!q('SELECT id FROM ocorrencias WHERE id=?').get(+p.id)) err(404, 'Ocorrência não encontrada.');
  q('INSERT INTO registos(ocorrencia_id,tipo,texto,por,ts) VALUES(?,?,?,?,?)').run(+p.id, 'nota', texto, me.id, now());
  broadcast({ col: 'registos', id: +p.id });
  send(res, 201, {});
});
route('POST', '/api/ocorrencias/:id/fotos', async (req, res, me, p) => {
  if (!q('SELECT id FROM ocorrencias WHERE id=?').get(+p.id)) err(404, 'Ocorrência não encontrada.');
  const buf = await readBody(req, MAX_FOTO);
  let ext = null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
  else if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ext = 'png';
  else if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') ext = 'webp';
  if (!ext) err(415, 'Formato de imagem não suportado. Usa JPEG, PNG ou WebP.');
  const nome = crypto.randomBytes(16).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(FOTOS_DIR, nome), buf);
  const legenda = str(decodeURIComponent(req.headers['x-legenda'] || ''), 500);
  q('INSERT INTO registos(ocorrencia_id,tipo,texto,foto,por,ts) VALUES(?,?,?,?,?,?)').run(+p.id, 'foto', legenda, nome, me.id, now());
  broadcast({ col: 'registos', id: +p.id });
  send(res, 201, { foto: nome });
});
route('GET', '/fotos/:nome', async (req, res, me, p) => {
  if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(p.nome)) err(404, 'Não encontrado.');
  const f = path.join(FOTOS_DIR, p.nome);
  if (!fs.existsSync(f)) err(404, 'Não encontrado.');
  const type = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[p.nome.split('.').pop()];
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable' });
  fs.createReadStream(f).pipe(res);
}, { stream: true });

/* ---- veículos e tripulações ---- */
route('POST', '/api/veiculos', async (req, res, me) => {
  need(me, 'comando');
  const b = await json(req); const sigla = str(b.sigla, 20).toUpperCase(); const tipo = str(b.tipo, 20);
  if (!sigla) err(400, 'Indica a sigla do veículo.');
  if (!getConfig().tiposVeiculo.includes(tipo)) err(400, 'Tipo de veículo inválido.');
  q('INSERT INTO veiculos(sigla,tipo,estado,criado) VALUES(?,?,?,?)').run(sigla, tipo, 'Disponível', now());
  broadcast({ col: 'veiculos' }); send(res, 201, {});
});
route('PATCH', '/api/veiculos/:id', async (req, res, me, p) => {
  need(me, 'chefe');
  const v = q('SELECT * FROM veiculos WHERE id=?').get(+p.id) || err(404, 'Veículo não encontrado.');
  const b = await json(req);
  if (b.sigla !== undefined || b.tipo !== undefined) {
    need(me, 'comando');
    const sigla = b.sigla !== undefined ? str(b.sigla, 20).toUpperCase() : v.sigla;
    const tipo = b.tipo !== undefined ? str(b.tipo, 20) : v.tipo;
    if (!sigla || !getConfig().tiposVeiculo.includes(tipo)) err(400, 'Sigla ou tipo inválido.');
    q('UPDATE veiculos SET sigla=?, tipo=? WHERE id=?').run(sigla, tipo, v.id);
  }
  if (b.ocorrencia !== undefined) {
    if (b.ocorrencia === null) {
      q(`UPDATE veiculos SET ocorrencia_id=NULL, estado='Disponível' WHERE id=?`).run(v.id);
      if (v.ocorrencia_id) logReg(v.ocorrencia_id, v.sigla + ' retirado', me.id);
    } else {
      const o = q('SELECT id FROM ocorrencias WHERE id=?').get(+b.ocorrencia) || err(404, 'Ocorrência não encontrada.');
      if (v.estado === 'Inoperacional') err(400, 'Este veículo está inoperacional.');
      q(`UPDATE veiculos SET ocorrencia_id=?, estado='Em ocorrência' WHERE id=?`).run(o.id, v.id);
      logReg(o.id, v.sigla + ' atribuído', me.id);
      if (v.ocorrencia_id && v.ocorrencia_id !== o.id) logReg(v.ocorrencia_id, v.sigla + ' transferido para outra ocorrência', me.id);
    }
  } else if (b.estado !== undefined) {
    if (!EST_VEI.includes(b.estado)) err(400, 'Estado inválido.');
    if (b.estado === 'Em ocorrência' && !v.ocorrencia_id) err(400, 'Atribui o veículo a uma ocorrência a partir da ocorrência.');
    if (b.estado !== 'Em ocorrência') {
      q('UPDATE veiculos SET estado=?, ocorrencia_id=NULL WHERE id=?').run(b.estado, v.id);
      if (v.ocorrencia_id) logReg(v.ocorrencia_id, v.sigla + ' passou a ' + b.estado, me.id);
    }
  }
  broadcast({ col: 'veiculos' }); if (v.ocorrencia_id || b.ocorrencia) broadcast({ col: 'registos' });
  send(res, 200, {});
});
route('DELETE', '/api/veiculos/:id', async (req, res, me, p) => {
  need(me, 'comando');
  q('DELETE FROM veiculos WHERE id=?').run(+p.id);
  broadcast({ col: 'veiculos' }); send(res, 200, {});
});
route('POST', '/api/veiculos/:id/tripulacao', async (req, res, me, p) => {
  need(me, 'chefe');
  const b = await json(req);
  if (!q('SELECT id FROM veiculos WHERE id=?').get(+p.id)) err(404, 'Veículo não encontrado.');
  if (!q('SELECT id FROM membros WHERE id=? AND ativo=1').get(+b.membro)) err(404, 'Elemento não encontrado.');
  q('INSERT OR REPLACE INTO tripulacao(membro_id,veiculo_id) VALUES(?,?)').run(+b.membro, +p.id);
  broadcast({ col: 'veiculos' }); send(res, 200, {});
});
route('DELETE', '/api/veiculos/:id/tripulacao/:membro', async (req, res, me, p) => {
  need(me, 'chefe');
  q('DELETE FROM tripulacao WHERE membro_id=? AND veiculo_id=?').run(+p.membro, +p.id);
  broadcast({ col: 'veiculos' }); send(res, 200, {});
});

/* ---- mensagens ---- */
route('POST', '/api/mensagens', async (req, res, me) => {
  const b = await json(req); const texto = str(b.texto, 2000); const prioridade = +b.prioridade || 0;
  if (!texto) err(400, 'A mensagem está vazia.');
  if (![0, 1, 2, 3].includes(prioridade)) err(400, 'Prioridade inválida.');
  const occ = b.ocorrencia ? (q('SELECT id FROM ocorrencias WHERE id=?').get(+b.ocorrencia)?.id ?? null) : null;
  const t = now();
  const r = q('INSERT INTO mensagens(texto,prioridade,ocorrencia_id,por,ts) VALUES(?,?,?,?,?)').run(texto, prioridade, occ, me.id, t);
  broadcast({ col: 'mensagens', msg: { id: Number(r.lastInsertRowid), texto, prioridade, ocorrencia: occ, por: me.id, ts: t } });
  send(res, 201, {});
});

/* ---- elementos ---- */
route('PUT', '/api/me/estado', async (req, res, me) => {
  const b = await json(req); if (!EST_EL.includes(b.estado)) err(400, 'Estado inválido.');
  q('UPDATE membros SET estado=? WHERE id=?').run(b.estado, me.id);
  broadcast({ col: 'membros' }); send(res, 200, {});
});
function podeGerir(me, postoAlvo) {
  need(me, 'comando');
  if (me.posto !== 'central' && POSTOS[postoAlvo] >= POSTOS.comando) err(403, 'Só a Central gere contas de Comando e Central.');
}
route('POST', '/api/membros', async (req, res, me) => {
  const b = await json(req);
  const posto = String(b.posto); if (!POSTOS[posto]) err(400, 'Posto inválido.');
  podeGerir(me, posto);
  const utilizador = str(b.utilizador, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(utilizador)) err(400, 'O utilizador só pode ter letras, números, ponto, hífen e sublinhado (mín. 3).');
  if (q('SELECT id FROM membros WHERE utilizador=?').get(utilizador)) err(409, 'Esse utilizador já existe.');
  const nome = str(b.nome, 60); if (!nome) err(400, 'Indica o nome.');
  if (!validPw(b.password)) err(400, 'A palavra-passe temporária tem de ter pelo menos 10 caracteres.');
  q('INSERT INTO membros(utilizador,nome,numero,posto,hash,obriga_troca,criado) VALUES(?,?,?,?,?,1,?)')
    .run(utilizador, nome, str(b.numero, 20), posto, hashPw(b.password), now());
  broadcast({ col: 'membros' }); send(res, 201, {});
});
route('PATCH', '/api/membros/:id', async (req, res, me, p) => {
  const m = q('SELECT * FROM membros WHERE id=?').get(+p.id) || err(404, 'Elemento não encontrado.');
  const b = await json(req);
  podeGerir(me, m.posto);
  if (m.id === me.id && (b.posto !== undefined || b.ativo !== undefined)) err(400, 'Não podes alterar o teu próprio posto nem desativar a tua conta.');
  if (b.posto !== undefined) { if (!POSTOS[b.posto]) err(400, 'Posto inválido.'); podeGerir(me, b.posto); q('UPDATE membros SET posto=? WHERE id=?').run(b.posto, m.id); }
  if (b.nome !== undefined) { const n = str(b.nome, 60); if (!n) err(400, 'Indica o nome.'); q('UPDATE membros SET nome=? WHERE id=?').run(n, m.id); }
  if (b.numero !== undefined) q('UPDATE membros SET numero=? WHERE id=?').run(str(b.numero, 20), m.id);
  if (b.ativo !== undefined) {
    q('UPDATE membros SET ativo=? WHERE id=?').run(b.ativo ? 1 : 0, m.id);
    if (!b.ativo) { q('DELETE FROM sessoes WHERE membro_id=?').run(m.id); q('DELETE FROM tripulacao WHERE membro_id=?').run(m.id); }
  }
  if (b.password !== undefined) {
    if (!validPw(b.password)) err(400, 'A palavra-passe temporária tem de ter pelo menos 10 caracteres.');
    q('UPDATE membros SET hash=?, obriga_troca=1 WHERE id=?').run(hashPw(b.password), m.id);
    q('DELETE FROM sessoes WHERE membro_id=?').run(m.id);
  }
  broadcast({ col: 'membros' }); broadcast({ col: 'veiculos' }); send(res, 200, {});
});

/* ---------------- ficheiros estáticos ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
function estatico(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(PUBLIC_DIR, p));
  if (!f.startsWith(PUBLIC_DIR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); return res.end('Não encontrado'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': p === '/index.html' ? 'no-cache' : 'public, max-age=300' });
  fs.createReadStream(f).pipe(res);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://*.googleapis.com https://*.gstatic.com *.google.com https://*.ggpht.com *.googleusercontent.com 'unsafe-eval' blob: https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.googleapis.com https://*.gstatic.com *.google.com *.googleusercontent.com https://*.tile.openstreetmap.org https://cdnjs.cloudflare.com",
  "connect-src 'self' https://*.googleapis.com *.google.com https://*.gstatic.com data: blob:",
  "frame-src *.google.com", "worker-src blob:", "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
].join('; ');

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self)');
  const url = new URL(req.url, 'http://x');
  try {
    const r = routes.find((x) => x.m === req.method && x.re.test(url.pathname));
    if (!r) {
      if (url.pathname.startsWith('/api/')) err(404, 'Rota desconhecida.');
      if (req.method !== 'GET') err(405, 'Método não permitido.');
      return estatico(req, res, url);
    }
    if (req.method !== 'GET' && req.headers['x-sala'] !== '1') err(403, 'Pedido recusado.');
    let me = null;
    if (!r.opts.publico) {
      me = sessao(req);
      if (!me) err(401, 'Sessão terminada. Entra de novo.');
      if (me.obriga_troca && !r.opts.semTroca) err(428, 'Tens de definir uma nova palavra-passe.');
    }
    await r.fn(req, res, me, url.pathname.match(r.re).groups || {});
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpErr) return send(res, e.code, { erro: e.message });
    console.error(e);
    send(res, 500, { erro: 'Erro interno do servidor.' });
  }
});
server.listen(PORT, () => console.log(`Sala de Operações a correr na porta ${PORT}${MAPS_KEY ? ' (Google Maps ativo)' : ' (mapa OpenStreetMap; defina GOOGLE_MAPS_API_KEY para Google Maps)'}`));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { server.close(); db.close(); process.exit(0); });

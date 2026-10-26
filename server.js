'use strict';
// Express: static files + catalog API. WebSocket /ws: rooms where the TV (host) owns the queue
// and phones (guests) send songs to it. Rooms live in memory; the TV re-creates its room on reconnect.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const PORT = +process.env.PORT || 3030;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const EMBED_ERRORS = { 100: 'видео удалено или скрыто', 101: 'владелец запретил встраивание', 150: 'владелец запретил встраивание' };
const ROOM_TTL = 6 * 3600e3; // room without a TV is dropped after 6 h

function readJson(name, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch (e) { return def; }
}
function writeJson(name, val) {
  const p = path.join(DATA, name);
  fs.writeFileSync(p + '.tmp', JSON.stringify(val, null, 2) + '\n');
  fs.renameSync(p + '.tmp', p);
}

// Catalog merged with found videos; videos known to be broken are left out.
function catalog() {
  const videos = readJson('videos.json', {}), bad = readJson('bad-videos.json', {});
  const songs = readJson('catalog.json', []).map((s) => ({
    ...s, videos: ((videos[s.id] && videos[s.id].candidates) || []).map((c) => c.id).filter((id) => !bad[id])
  }));
  return { songs, withVideo: songs.filter((s) => s.videos.length).length };
}

// Address phones should open: PUBLIC_URL, else the address the TV used (unless it is localhost), else the LAN IP.
// Prefer home Wi-Fi/LAN ranges; VPN and virtual adapters (Radmin, Hamachi, WSL, VirtualBox…) go last.
function lanIp() {
  const VIRTUAL = /vpn|radmin|hamachi|zerotier|tailscale|wireguard|vethernet|virtualbox|vmware|docker|wsl|hyper-v|loopback/i;
  const all = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) all.push({ name, ip: a.address });
  }
  const rank = (x) => (VIRTUAL.test(x.name) ? 2 : 0) + (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.ip) ? 0 : 1);
  all.sort((a, b) => rank(a) - rank(b));
  return all.length ? all[0].ip : 'localhost';
}
function joinBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (host && !/^(localhost|127\.|\[::1\])/.test(host)) {
    const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
    return proto + '://' + host;
  }
  return 'http://' + lanIp() + ':' + PORT;
}

/* ---------- HTTP ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2kb' }));

app.get('/api/catalog', (req, res) => { res.set('Cache-Control', 'no-store').json(catalog()); });

app.post('/api/bad', (req, res) => {
  const j = req.body || {}, code = +j.code;
  if (!/^[\w-]{11}$/.test(j.vid || '') || !EMBED_ERRORS[code]) return res.status(400).json({ error: 'Неверные данные' });
  const bad = readJson('bad-videos.json', {});
  const prev = bad[j.vid];
  bad[j.vid] = { song: String(j.song || '').slice(0, 40), code, count: (prev ? prev.count : 0) + 1, at: new Date().toISOString() };
  writeJson('bad-videos.json', bad);
  console.log('[плеер] не играет ' + j.vid + ' (' + (j.song || 'своя ссылка') + '): ошибка ' + code + ', ' + EMBED_ERRORS[code]);
  res.json({ ok: true });
});

app.get('/api/qr', async (req, res) => {
  const code = String(req.query.code || '');
  if (!/^\d{4}$/.test(code)) return res.status(400).json({ error: 'Неверный код комнаты' });
  const svg = await QRCode.toString(joinBase(req) + '/r/' + code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#120e1d', light: '#ffffff' } });
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Нет такого адреса' }));
app.get(['/r', '/r/:code'], (req, res) => res.sendFile(path.join(PUB, 'remote.html')));
app.use(express.static(PUB, { maxAge: 0 }));

/* ---------- комнаты ---------- */
const rooms = new Map(); // code -> {code, token, host, guests:Set, state, hostLeft}
const rid = () => crypto.randomBytes(9).toString('base64url');
const send = (ws, m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 30);
let songIds = { at: 0, set: new Set() };
function hasSong(id) {
  if (Date.now() - songIds.at > 60e3) songIds = { at: Date.now(), set: new Set(readJson('catalog.json', []).map((s) => s.id)) };
  return songIds.set.has(id);
}
function newCode() {
  for (let i = 0; i < 200; i++) { const c = String(1000 + crypto.randomInt(9000)); if (!rooms.has(c)) return c; }
  throw new Error('нет свободных кодов');
}
function toGuests(room, m) { for (const g of room.guests) send(g, m); }
function guestCount(room) { send(room.host, { t: 'guests', count: room.guests.size }); }

function onHost(ws, m) {
  let room = /^\d{4}$/.test(m.code || '') ? rooms.get(m.code) : null;
  if (room && room.token !== m.token) room = null; // чужая комната — выдаём новый код
  if (!room) {
    // после перезапуска сервера пробуем вернуть экрану прежний код, чтобы старый QR продолжал работать
    const code = /^\d{4}$/.test(m.code || '') && !rooms.has(m.code) ? m.code : newCode();
    const token = typeof m.token === 'string' && /^[\w-]{12,40}$/.test(m.token) ? m.token : rid();
    room = { code, token, host: null, guests: new Set(), state: null, hostLeft: 0 };
    rooms.set(code, room);
  }
  if (room.host && room.host !== ws) { send(room.host, { t: 'replaced' }); room.host.close(); }
  room.host = ws; room.hostLeft = 0;
  ws.role = 'host'; ws.room = room;
  send(ws, { t: 'room', code: room.code, token: room.token, joinUrl: joinBase(ws.req) + '/r/' + room.code });
  guestCount(room);
  toGuests(room, { t: 'host', online: true });
}

function onJoin(ws, m) {
  const room = rooms.get(String(m.code || ''));
  if (!room) return send(ws, { t: 'error', code: 'room', text: 'Комната ' + String(m.code || '').slice(0, 4) + ' не найдена. Проверьте код на экране.' });
  const name = cleanName(m.name);
  if (!name) return send(ws, { t: 'error', code: 'name', text: 'Введите имя.' });
  ws.role = 'guest'; ws.room = room; ws.gid = rid(); ws.name = name; ws.adds = [];
  room.guests.add(ws);
  send(ws, { t: 'joined', code: room.code, hostOnline: !!room.host, state: room.state });
  guestCount(room);
}

function fromHost(ws, m) {
  const room = ws.room;
  if (m.t === 'state' && m.state && typeof m.state === 'object') { room.state = m.state; toGuests(room, { t: 'state', state: m.state }); }
  else if (m.t === 'ack') {
    for (const g of room.guests) if (g.gid === m.gid) send(g, { t: 'ack', rid: m.rid, ok: !!m.ok, text: String(m.text || '').slice(0, 200) });
  }
  else if (m.t === 'to' && m.m && typeof m.m === 'object' && typeof m.m.t === 'string') { // личное сообщение одному гостю
    for (const g of room.guests) if (g.gid === m.gid) send(g, m.m);
  }
}

// Гость может добавлять песни, реагировать, вести избранное, присылать свой счёт
// и переключать на следующую песню (телефон спрашивает подтверждение). Пауза — только у экрана.
const REACTS = { clap: 1, fire: 1, heart: 1, lol: 1 };
function fromGuest(ws, m) {
  const room = ws.room, now = Date.now();
  if (m.t === 'name') { ws.name = cleanName(m.name) || ws.name; return; }
  const out = { t: m.t, gid: ws.gid, singer: ws.name };
  if (m.t === 'add') {
    const fail = (text) => send(ws, { t: 'ack', rid: m.rid, ok: false, text });
    ws.adds = ws.adds.filter((t) => now - t < 60e3);
    if (ws.adds.length >= 10) return fail('Слишком много песен подряд. Подождите минуту.');
    if (!hasSong(String(m.songId || ''))) return fail('Такой песни нет в каталоге.');
    if (!room.host) return fail('Экран сейчас не в сети. Попробуйте через минуту.');
    ws.adds.push(now);
    Object.assign(out, { songId: m.songId, rid: m.rid });
  } else if (m.t === 'fav') {
    if (!hasSong(String(m.songId || ''))) return;
    Object.assign(out, { songId: m.songId, on: !!m.on });
  } else if (m.t === 'react') {
    if (!REACTS[m.kind]) return;
    ws.reacts = (ws.reacts || []).filter((t) => now - t < 5e3);
    if (ws.reacts.length >= 12) return; // не даём засыпать экран
    ws.reacts.push(now);
    out.kind = m.kind;
  } else if (m.t === 'skip') {
    if (now - (ws.lastSkip || 0) < 5e3) return send(ws, { t: 'ack', rid: m.rid, ok: false, text: 'Подождите пару секунд перед следующим переключением.' });
    if (!room.host) return send(ws, { t: 'ack', rid: m.rid, ok: false, text: 'Экран сейчас не в сети.' });
    ws.lastSkip = now;
    Object.assign(out, { uid: String(m.uid || '').slice(0, 20), rid: m.rid });
  } else if (m.t === 'score') {
    const s = Math.round(+m.score);
    if (!(s >= 0 && s <= 100)) return;
    Object.assign(out, { score: s, uid: String(m.uid || '').slice(0, 20) });
  } else if (m.t !== 'me') return;
  send(room.host, out);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
wss.on('connection', (ws, req) => {
  ws.req = req; ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'host' && !ws.role) return onHost(ws, m);
    if (m.t === 'join' && !ws.role) return onJoin(ws, m);
    if (ws.role === 'host') return fromHost(ws, m);
    if (ws.role === 'guest') return fromGuest(ws, m);
  });
  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    if (ws.role === 'host' && room.host === ws) { room.host = null; room.hostLeft = Date.now(); toGuests(room, { t: 'host', online: false }); }
    if (ws.role === 'guest') { room.guests.delete(ws); guestCount(room); }
  });
});

// keepalive (прокси хостингов рвут молчащие соединения) и уборка брошенных комнат
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
  for (const [code, room] of rooms) if (!room.host && room.hostLeft && Date.now() - room.hostLeft > ROOM_TTL) {
    toGuests(room, { t: 'error', code: 'room', text: 'Комната закрыта.' });
    rooms.delete(code);
  }
}, 30e3).unref();

server.listen(PORT, () => {
  const c = catalog();
  console.log('Сцена: http://localhost:' + PORT + '  (песен: ' + c.songs.length + ', с видео: ' + c.withVideo + ')');
  console.log('С телефона в той же сети: ' + (PUBLIC_URL || 'http://' + lanIp() + ':' + PORT) + '/r/КОД');
  if (!c.withVideo) console.log('Видео ещё не найдены: npm run resolve (нужен YOUTUBE_API_KEY в .env, см. README.md)');
});

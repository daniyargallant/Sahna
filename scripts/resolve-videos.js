#!/usr/bin/env node
'use strict';
/*
  Finds embeddable karaoke videos for data/catalog.json via YouTube Data API v3
  and stores up to 3 candidates per song in data/videos.json.

  Resumable: songs already in videos.json are skipped, the file is saved after
  every song, and the run stops cleanly on quotaExceeded.

  node scripts/resolve-videos.js            — next songs until quota runs out
  node scripts/resolve-videos.js --limit=10 — at most 10 songs
  node scripts/resolve-videos.js --retry    — also re-search songs where nothing was found
  node scripts/resolve-videos.js --only=ru-001,en-014
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
loadEnv(path.join(ROOT, '.env'));

const KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const API = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';
const args = process.argv.slice(2);
const opt = (name) => { const a = args.find((x) => x.startsWith('--' + name + '=')); return a ? a.split('=')[1] : null; };
const RETRY = args.includes('--retry');
const LIMIT = +opt('limit') || Infinity;
const ONLY = opt('only') ? opt('only').split(',') : null;

const COST = 101; // search.list 100 + videos.list 1
const DAILY = 10000;
const KARAOKE = /karaoke|караоке|минус|instrumental|инструментал/i;
const PENALTY = /\b(live|cover|remix|reaction|tutorial|кавер|разбор)\b|shorts/i;

function loadEnv(file) {
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { return; }
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
function readJson(name, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch (e) { return def; }
}
function writeJson(name, val) {
  const p = path.join(DATA, name);
  fs.writeFileSync(p + '.tmp', JSON.stringify(val, null, 2) + '\n');
  fs.renameSync(p + '.tmp', p);
}
function seconds(iso) { // PT3M41S -> 221
  const m = (iso || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}
function norm(s) { return (s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function decode(s) { return (s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }

class ApiError extends Error {
  constructor(status, reason, message) { super(message); this.status = status; this.reason = reason; }
}
async function yt(endpoint, params) {
  const u = new URL(API + '/' + endpoint);
  u.search = new URLSearchParams({ ...params, key: KEY }).toString();
  let r;
  try { r = await fetch(u); } catch (e) { throw new ApiError(0, 'network', 'нет связи с YouTube API (' + e.message + ')'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = j.error || {};
    throw new ApiError(r.status, (e.errors && e.errors[0] && e.errors[0].reason) || '', e.message || 'HTTP ' + r.status);
  }
  return j;
}

function score(song, v) {
  const t = norm(v.title);
  let s = 0;
  if (t.includes(norm(song.title))) s += 4;
  if (norm(song.artist).split(' ').filter((w) => w.length > 2).some((w) => t.includes(w))) s += 2;
  if (/karaoke|караоке/i.test(v.title)) s += 1;
  if (PENALTY.test(v.title)) s -= 2;
  return s + Math.log10(1 + v.views) / 3;
}

async function resolve(song, bad) {
  const q = song.artist + ' ' + song.title + (song.language === 'en' ? ' karaoke' : ' караоке');
  const found = await yt('search', {
    part: 'id', q, type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: '5'
  });
  const ids = (found.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
  if (!ids.length) return { q, candidates: [] };
  const info = await yt('videos', { part: 'snippet,contentDetails,status,statistics', id: ids.join(',') });
  const ok = (info.items || []).map((v) => ({
    id: v.id,
    title: decode(v.snippet.title),
    channel: decode(v.snippet.channelTitle),
    seconds: seconds(v.contentDetails.duration),
    views: +(v.statistics && v.statistics.viewCount) || 0,
    embeddable: v.status.embeddable && v.status.privacyStatus !== 'private'
  })).filter((v) => v.embeddable && v.seconds >= 120 && v.seconds <= 480 && KARAOKE.test(v.title) && !bad[v.id]);
  ok.sort((a, b) => score(song, b) - score(song, a));
  return { q, candidates: ok.slice(0, 3).map(({ id, title, channel, seconds }) => ({ id, title, channel, seconds })) };
}

async function main() {
  const catalog = readJson('catalog.json', []);
  const videos = readJson('videos.json', {});
  const bad = readJson('bad-videos.json', {});
  const usable = (id) => videos[id] && videos[id].candidates.some((c) => !bad[c.id]);
  const needs = (s) => ONLY ? ONLY.includes(s.id) : !videos[s.id] || (!usable(s.id) && (RETRY || videos[s.id].candidates.length));
  const todo = catalog.filter(needs);

  console.log('Песен в каталоге: ' + catalog.length + ', с видео: ' + catalog.filter((s) => usable(s.id)).length + ', к поиску: ' + todo.length);
  if (!todo.length) { console.log('Всё уже найдено. Для повторного поиска пустых: --retry'); return; }
  if (!KEY) {
    console.error('\nНет ключа. Создайте файл .env рядом с package.json:\n  YOUTUBE_API_KEY=ваш_ключ\nКак получить ключ — см. README.md.');
    process.exitCode = 1; return;
  }
  const days = Math.ceil(todo.length * COST / DAILY);
  console.log('Каждая песня ≈ ' + COST + ' ед. квоты, лимит ' + DAILY + ' в сутки (≈ ' + Math.floor(DAILY / COST) + ' песен).' + (days > 1 ? ' Понадобится примерно ' + days + ' дн.' : '') + '\n');

  const save = () => {
    const sorted = {};
    for (const s of catalog) if (videos[s.id]) sorted[s.id] = videos[s.id];
    writeJson('videos.json', sorted);
  };
  let done = 0, found = 0, stop = null;
  for (const song of todo) {
    if (done >= LIMIT) break;
    const label = song.artist + ' — ' + song.title;
    try {
      const r = await resolve(song, bad);
      videos[song.id] = { query: r.q, checked: new Date().toISOString().slice(0, 10), candidates: r.candidates };
      save();
      done++;
      if (r.candidates.length) found++;
      console.log((r.candidates.length ? '✓ ' : '✗ ') + song.id + '  ' + label + (r.candidates.length ? '  (' + r.candidates.length + ')' : '  — подходящих видео нет'));
    } catch (e) {
      if (e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded' || e.reason === 'rateLimitExceeded') stop = 'Квота на сегодня закончилась. Запустите скрипт завтра — он продолжит с того же места.';
      else if (e.status === 400 || e.status === 403) stop = 'YouTube API отклонил запрос (' + (e.reason || e.status) + '): ' + e.message + '\nПроверьте ключ и что YouTube Data API v3 включён в Google Cloud.';
      else if (e.reason === 'network') stop = 'Ошибка сети: ' + e.message;
      else { console.log('! ' + song.id + '  ' + label + '  — ошибка: ' + e.message); continue; }
      break;
    }
  }
  const left = catalog.filter((s) => !videos[s.id]).length;
  const empty = catalog.filter((s) => videos[s.id] && !usable(s.id)).length;
  console.log('\nЗа этот запуск: обработано ' + done + ', найдено видео для ' + found + '.');
  if (stop) console.log(stop);
  console.log('Осталось найти: ' + left + ' песен' + (left ? ' (≈ ' + Math.ceil(left * COST / DAILY) + ' дн.)' : '') + '.' + (empty ? ' Без рабочих видео: ' + empty + ' (повторить: --retry).' : ''));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });

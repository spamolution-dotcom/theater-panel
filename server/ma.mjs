// Music Assistant's own websocket API, for what Home Assistant's integration doesn't offer: the
// rows of MA's home page (Top picks, Recently played, Recently added albums) and the library's
// genres. Playing still goes through HA (actions.mjs), like the rest of the Music tab.
//
// One connection, opened on first use and again after it drops. MA sends its server info, the
// panel signs in with the long-lived token, then sends commands; a long answer may come in parts.

import { config } from './config.mjs';
import { extImage } from './images.mjs';

// The Music Assistant app on this Home Assistant (host network, port 8095), unless set.
const urls = () => (config.ma.url ? [config.ma.url] : ['http://d5369777-music-assistant:8095', 'http://172.30.32.1:8095']);
const TIMEOUT = 12e3;

let conn = null;      // a Promise of { ws, base, send }
let nextId = 1;

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws');
    const pending = new Map();
    const parts = new Map();
    const base = url;
    let done = false;
    const fail = (err) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      if (!done) { done = true; reject(err); }
    };
    const timer = setTimeout(() => { fail(new Error('Music Assistant did not answer')); try { ws.close(); } catch { /* closed */ } }, TIMEOUT);
    const send = (command, args = {}) => new Promise((res, rej) => {
      const message_id = String(nextId++);
      const t = setTimeout(() => { pending.delete(message_id); rej(new Error(`Music Assistant: ${command} timed out`)); }, TIMEOUT);
      pending.set(message_id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
      ws.send(JSON.stringify({ message_id, command, args }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.server_version && !('message_id' in msg)) {
        // Images on MA's image proxy are fetched by the panel, from where it reached MA.
        send('auth', { token: config.ma.token }).then(() => {
          clearTimeout(timer); done = true; resolve({ ws, base, send });
        }, (err) => { clearTimeout(timer); fail(new Error(`Music Assistant refused the token (${err.message})`)); ws.close(); });
        return;
      }
      const p = pending.get(msg.message_id);
      if (!p) return;
      if ('error_code' in msg) { pending.delete(msg.message_id); parts.delete(msg.message_id); p.reject(new Error(msg.details || `error ${msg.error_code}`)); return; }
      if (msg.partial) { parts.set(msg.message_id, (parts.get(msg.message_id) || []).concat(msg.result || [])); return; }
      const before = parts.get(msg.message_id);
      parts.delete(msg.message_id);
      pending.delete(msg.message_id);
      p.resolve(before ? before.concat(msg.result || []) : msg.result);
    });
    ws.addEventListener('error', () => fail(new Error(`Can't reach Music Assistant at ${url}`)));
    ws.addEventListener('close', () => { fail(new Error('Music Assistant closed the connection')); if (conn && done) conn = null; });
  });
}

async function open() {
  let last;
  for (const url of urls()) {
    try { return await connect(url); } catch (err) { last = err; }
  }
  throw last;
}

async function cmd(command, args) {
  if (!config.ma.token) throw new Error('No Music Assistant token in the add-on settings');
  if (!conn) { conn = open(); conn.catch(() => { conn = null; }); }
  const c = await conn;
  try {
    return await c.send(command, args);
  } catch (err) {
    if (/closed|reach/.test(err.message)) conn = null;
    throw err;
  }
}

// MA's picture for an item: its own, its album's, its artist's (the same order MA's frontend uses).
function imageOf(i, base) {
  const usable = (img) => img && img.path && (!img.type || img.type === 'thumb');
  const pick = [i.image, i.album?.image, ...(i.metadata?.images || []), ...(i.artists || []).map((a) => a.image)].find(usable);
  if (!pick) return null;
  if (pick.proxy_id) return extImage(`${base}/imageproxy/${pick.proxy_id}?size=512`);
  if (pick.remotely_accessible && /^https?:/.test(pick.path)) return extImage(pick.path);
  return extImage(`${base}/imageproxy?path=${encodeURIComponent(pick.path)}&provider=${encodeURIComponent(pick.provider || '')}&size=512`);
}
function item(i, base) {
  return {
    uri: i.uri, type: i.media_type, name: i.name,
    artist: (i.artists || []).map((a) => a.name).join(', ') || i.owner || undefined,
    image: imageOf(i, base),
  };
}
const PLAYABLE = ['album', 'playlist', 'track', 'artist', 'radio', 'genre'];

let cache = null;     // { at, value }
const FRESH = 60e3;

// The home page: the rows MA shows by default with their items, Top picks taken from them in
// turn (as MA's own page does), and the 8 genres with the most music in them.
export async function musicHome({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < FRESH) return cache.value;
  const folders = (await cmd('music/recommendations')) || [];
  const base = (await conn).base;
  const shown = folders.filter((f) => f.enabled_by_default !== false);
  const rows = (await Promise.all(shown.map(async (f) => {
    const items = f.items && f.items.length ? f.items
      : await cmd('music/recommendations/items', { provider: f.provider, item_id: f.item_id }).catch(() => []);
    return { id: f.item_id, title: f.name, items: (items || []).filter((i) => PLAYABLE.includes(i.media_type)).map((i) => item(i, base)) };
  }))).filter((r) => r.items.length);
  const top = [];
  const seen = new Set();
  const most = rows.reduce((m, r) => Math.max(m, r.items.length), 0);
  for (let n = 0; n < most && top.length < 5; n++) {
    for (const r of rows) {
      const x = r.items[n];
      if (x && !seen.has(x.uri) && top.length < 5) { seen.add(x.uri); top.push({ ...x, tag: r.title }); }
    }
  }
  let genres = [];
  try {
    const all = (await cmd('music/genres/library_items', { hide_empty: true, limit: 500 })) || [];
    const counts = all.length ? await cmd('music/genres/media_counts', { genre_ids: all.map((g) => String(g.item_id)) }).catch(() => ({})) : {};
    const total = (id) => Object.values(counts?.[id] || {}).reduce((s, n) => s + n, 0);
    genres = all.map((g) => ({ uri: g.uri, type: 'genre', name: g.name, n: total(String(g.item_id)) }))
      .sort((a, b) => b.n - a.n).slice(0, 8).map(({ n, ...g }) => g);
  } catch (err) {
    console.warn('[ma] genres:', err.message);
  }
  const value = { top, rows, genres };
  cache = { at: Date.now(), value };
  return value;
}

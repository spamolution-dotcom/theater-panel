// Theater panel server: serves the panel UI, a small JSON API over Plex / Seerr / Music
// Assistant, an image cache, and a Server-Sent Events stream of the theater's HA entities.
// No framework and no build step; Node's http module is enough for one wall panel.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHash } from 'node:crypto';

import { config, watchedEntities } from './config.mjs';
import * as accents from './accents.mjs';
import { HomeAssistant } from './ha.mjs';
import * as plex from './media.mjs';
import * as seerr from './seerr.mjs';
import * as taste from './taste.mjs';
import * as sleep from './sleep.mjs';
import * as seasonal from './seasonal.mjs';
import * as wrapped from './wrapped.mjs';
import { initImageCache, serveImage, extImage } from './images.mjs';
import { runAction, script, onPanelSound, musicLibrary, musicSearch, musicQueue, lastLaunched, castNow, livePosition } from './actions.mjs';
import { gameEntities, gamesState, steamLibrary } from './games.mjs';
import * as admin from './admin.mjs';
import * as icons from './icons.mjs';
import * as vote from './vote.mjs';
import * as tonight from './tonight.mjs';
import * as guest from './guest.mjs';
import * as tmdb from './tmdb.mjs';
import { netList, clientIp } from './net.mjs';
import { versions } from './version.mjs';
import * as hass from './hass.mjs';
import QRCode from 'qrcode';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(root, 'web');
const MODULES = join(root, 'node_modules');

// Browser paths for third-party files, so the page loads nothing from the internet.
const VENDOR = {
  '/vendor/preact.mjs': 'preact/dist/preact.module.js',
  '/vendor/preact-hooks.mjs': 'preact/hooks/dist/hooks.module.js',
  '/vendor/htm.mjs': 'htm/dist/htm.module.js',
};
const FONTS = /^\/fonts\/((big-shoulders-display|ibm-plex-sans|ibm-plex-mono)-latin-\d{3}-normal\.woff2)$/;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
};

// ---------- Home Assistant bridge ----------

// Entities streamed to the panel: the theater's own, plus the gaming PC's power and sensors.
// A broken games.json must not keep the server from starting; the Games screen just goes quiet.
const gameEntitiesSafe = () => gameEntities().catch((e) => { console.warn('[games] config unreadable:', e.message); return []; });
let entities = [...new Set([...watchedEntities(), ...(await gameEntitiesSafe())])];
const ha = new HomeAssistant({ url: config.ha.url, token: config.ha.token, entities });

// After the admin page saves: reconnect HA if its URL, token or the entity list changed, and tell
// open panels to reload their settings.
async function applySettings() {
  isProxy = netList(config.trustedProxies);
  isTrusted = netList(config.trustedNetworks);
  entities = [...new Set([...watchedEntities(), ...(await gameEntitiesSafe())])];
  ha.reconfigure({ url: config.ha.url, token: config.ha.token, entities });
  broadcast('settings', {});
  await hass.apply();
}
const clients = new Set();
function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { clients.delete(res); }   // a panel that went away mid-write
  }
  hass.observe(event, data);
}
ha.on('states', (changed) => broadcast('states', changed));
onPanelSound((sound) => broadcast('sound', sound));
ha.on('status', (connected) => broadcast('ha', { connected }));

// Plex sessions: polled only while someone is looking, faster while something is playing.
let sessions = [];
let streams = [];
let pollTimer = null;
// The film that just finished, waiting for a verdict: when the theater's own session disappears
// after most of a film, the panel asks how it was and writes the answer back to Plex. Only for
// films, only when the session belongs to this room (PLEX_PLAYER_NAME), and only if it really
// ran to the end - nobody wants to rate something they gave up on after ten minutes. Everyone
// on the sofa can have a say: the card stays up for a while and Plex gets the average.
let playing = null;
let verdict = null;
const WATCHED_ENOUGH = 0.8;
const ASK_FOR = 20 * 60e3;        // how long the card waits for the room's verdict
async function pollSessions() {
  clearTimeout(pollTimer);
  let next = 30000;
  if (clients.size && config.plex.url && !config.media.on) {
    try {
      // One call to Plex, read two ways: the theater's own session, and everything on the server.
      const { sessions: all, streams: everything } = await plex.activity();
      const mine = config.plexPlayerName ? all.filter((s) => s.player === config.plexPlayerName) : all;
      if (JSON.stringify(mine) !== JSON.stringify(sessions)) { sessions = mine; broadcast('sessions', sessions); }
      tonight.observe(mine).catch((e) => console.warn('[tonight]', e.message));
      if (mine.length) playing = mine[0];
      else if (playing) {
        const done = playing;
        playing = null;
        const pct = done.duration ? done.viewOffset / done.duration : 0;
        if (config.plexPlayerName && done.type === 'movie' && pct >= WATCHED_ENOUGH) {
          verdict = { id: String(done.id), title: done.title, year: done.year, poster: done.poster, at: Date.now(), votes: [] };
          broadcast('rate', verdict);
        }
      }
      // Nobody said anything: take the card away again rather than leaving it up all week.
      if (verdict && Date.now() - verdict.at > ASK_FOR) { verdict = null; broadcast('rate', { id: null }); }
      if (JSON.stringify(everything) !== JSON.stringify(streams)) { streams = everything; broadcast('streams', streams); }
      hass.sessions(sessions, streams);
      if (mine.length) next = 5000;
    } catch (e) { /* Plex unreachable: keep the last known state */ }
    const tv = ha.states[config.entities.appleTv]?.state;
    if (tv === 'playing' || tv === 'paused') next = 5000;
  }
  if (config.media.on) {
    const mine = streamerSessions();
    if (JSON.stringify(mine) !== JSON.stringify(sessions)) { sessions = mine; broadcast('sessions', sessions); hass.sessions(sessions, []); }
    if (mine.length) next = 5000;
  }
  pollTimer = setTimeout(pollSessions, next);
}

// This fork: what is on the Streamer. The Android TV Remote integration says which app is in front;
// Stremio's own player entity (HACS) says what it is, but it syncs from Stremio's cloud and can be
// hours stale, so it counts only when it changed recently. Otherwise the title the panel itself
// last opened stands in. No reliable playing/paused state exists for either app.
const STREMIO_APP = 'com.stremio.one';
const NETFLIX_APP = 'com.netflix.ninja';
const FRESH = 15 * 60e3;
const CHOOSING_MAX = 3 * 60e3;   // how long 'pick a stream' may stay up after a title is opened
// Stremio's artwork for an IMDb id: the usual poster, a large one for the hallway's Now Showing
// board, and the wide background.
function metahubPics(imdb) {
  if (!/^tt\d+$/.test(imdb || '')) return {};
  const m = (kind, size) => extImage(`https://images.metahub.space/${kind}/${size}/${imdb}/img`);
  return { poster: m('poster', 'medium'), posterLarge: m('poster', 'large'), art: m('background', 'medium') };
}

function streamerSessions() {
  const e = config.entities;
  const tv = ha.states[e.appleTv];
  const app = tv?.attributes?.app_id;
  if (!tv || ['off', 'unavailable', 'unknown'].includes(tv.state)) return [];
  // Netflix: something is on, but neither title nor position is known, so no clock.
  if (app === NETFLIX_APP) return [{ id: 'netflix', type: 'movie', title: 'Netflix', app: 'netflix', state: 'playing' }];
  if (app !== STREMIO_APP) return [];
  const l = lastLaunched();
  // Best source: Google Cast's view of the Streamer. Stremio's player publishes its title,
  // position and play/pause there the moment a stream starts (the Current Watching sensor below
  // only catches up when Stremio syncs, which can be much later).
  const cast = castNow(ha);
  if (cast) {
    const a = cast.attributes;
    const pos = livePosition(a, cast.state);
    const same = l && Date.now() - l.at < 6 * 3600e3;
    const imdb = same ? String(l.id).split(':')[0] : '';
    const pics = metahubPics(imdb);
    return [{
      id: same ? l.id : 'stremio', type: same ? l.type : 'movie', app: 'stremio', state: cast.state === 'paused' ? 'paused' : 'playing',
      title: same && l.title ? l.title : a.media_title || 'Stremio', showTitle: same ? l.showTitle : undefined,
      season: same ? l.season : undefined, episode: same ? l.episode : undefined, year: same ? l.year : undefined,
      viewOffset: pos != null ? Math.round(pos * 1000) : 0, duration: a.media_duration ? Math.round(a.media_duration * 1000) : 0,
      poster: pics.poster || (same ? l.poster : null), posterLarge: pics.posterLarge, art: pics.art,
    }];
  }
  // Stremio's 'Current Watching' sensor updates within seconds of playback starting, with the
  // episode, position and length. It counts once it has changed since the panel last opened a title
  // (until then Stremio is showing the stream list); with no title opened by the panel, a recent one.
  const cw = ha.states[e.stremioWatching];
  const a = cw?.attributes || {};
  const updated = Date.parse(cw?.last_updated || 0);
  const current = cw && !['unknown', 'unavailable', ''].includes(cw.state) && a.imdb_id
    && (l ? updated > l.at : Date.now() - updated < FRESH);
  if (current) {
    const imdb = a.imdb_id;
    const isEp = a.type === 'series' && a.season != null;
    // The sensor's state is "Show S06E03 Episode title"; the show's name is the part before SxxEyy.
    const show = isEp ? String(cw.state).replace(/\s+S\d+E\d+.*$/, '') : cw.state;
    return [{
      id: isEp ? `${imdb}:${a.season}:${a.episode}` : imdb, type: isEp ? 'episode' : 'movie', app: 'stremio', state: 'playing',
      title: isEp ? a.episode_title || `Episode ${a.episode}` : show, showTitle: isEp ? show : undefined,
      season: isEp ? Number(a.season) : undefined, episode: isEp ? Number(a.episode) : undefined,
      viewOffset: Number(a.time_offset) || 0, duration: Number(a.duration) || 0,
      ...metahubPics(imdb),
    }];
  }
  // Opened by the panel, stream not picked yet (or Stremio has not synced playback yet): no clock.
  // After a few minutes in Stremio a stream has almost certainly been picked, even if the player
  // entity (synced from Stremio's cloud) has not caught up: say it is on, still without a clock.
  if (l && Date.now() - l.at < 6 * 3600e3) {
    return [{ id: l.id, type: l.type, app: 'stremio', state: Date.now() - l.at > CHOOSING_MAX ? 'playing' : 'choosing', title: l.title || 'Stremio', showTitle: l.showTitle, season: l.season, episode: l.episode, year: l.year, poster: l.poster }];
  }
  return [{ id: 'stremio', type: 'movie', app: 'stremio', title: 'Stremio', state: 'choosing' }];
}

// ---------- HTTP ----------

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(s);
}

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 64 * 1024) throw admin.httpError(413, 'Body too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw admin.httpError(400, 'Body is not valid JSON'); }
}

// Every POST must be JSON sent by our own pages (or a rest_command, which sets the type
// too). A cross-site HTML form can post text/plain but never application/json, and browsers
// label anything from another site with Sec-Fetch-Site, so between the two a page elsewhere on
// the LAN cannot drive the theater through someone's trusted-network address.
function checkPost(req) {
  if (req.method !== 'POST') return;
  if (req.headers['sec-fetch-site'] === 'cross-site') throw admin.httpError(403, 'Cross-site requests are not allowed');
  if (!/^application\/json/.test(req.headers['content-type'] || '')) throw admin.httpError(415, 'JSON only');
}

// The app icons are public so Unraid's Docker page and bookmarks can show them.
const PUBLIC = new Set(['/assets/icon.png', '/assets/apple-touch-icon.png', '/assets/preroll.mp3', '/assets/preroll-spooky.mp3', '/assets/intermission.mp3', '/vote', '/vote/', '/api/vote', '/healthz']);

// Trusted networks skip the key entirely (see TRUST_NETWORKS on the settings page).
let isProxy = netList(config.trustedProxies);
let isTrusted = netList(config.trustedNetworks);

const isHttps = (req) => req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);

function authorized(req, url, res) {
  if (!config.panelKey || PUBLIC.has(url.pathname)) return true;
  // The guest remote: its page and its two calls open with the evening's token, nothing else.
  if ((url.pathname === '/guest' || url.pathname === '/api/guest/state' || url.pathname === '/api/guest/act') && guest.valid(url.searchParams.get('t') || '')) return true;
  if (config.trustedNetworks.length && isTrusted(clientIp(req, isProxy))) return true;
  const cookie = /(?:^|;\s*)tp_key=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const given = url.searchParams.get('key') || (cookie && decodeURIComponent(cookie)) || '';
  const a = Buffer.from(given); const b = Buffer.from(config.panelKey);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (ok && url.searchParams.get('key')) {
    res.setHeader('set-cookie', `tp_key=${encodeURIComponent(config.panelKey)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict${isHttps(req) ? '; Secure' : ''}`);
  }
  return ok;
}

async function serveFile(res, file, cache = 'no-cache') {
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': cache });
    res.end(body);
  } catch { res.writeHead(404).end(); }
}

const routes = [];
const get = (re, fn) => routes.push(['GET', re, fn]);
const post = (re, fn) => routes.push(['POST', re, fn]);

// Which build is running and whether GHCR has a newer one (Home Assistant shows this as an
// update entity; see ha/theater.yaml).
get(/^\/api\/version$/, () => versions());

// The panel's look, for something outside the admin page to read and set - the Kiosk Satellite
// plugin that shows theme, accent and weather as Home Assistant entities uses this. Same save
// path as the admin page, so open panels follow at once. Behind the panel key like the rest.
const LOOK = {
  theme: { key: 'THEME', options: ['classic', 'sofa'], value: () => config.ui.theme },
  accent: { key: 'ACCENT', options: ['auto', 'none', ...accents.IDS], value: () => config.ui.accent },
  intensity: { key: 'ACCENT_INTENSITY', min: 0, max: 100, value: () => config.ui.accentIntensity },
};
const lookState = () => ({
  theme: LOOK.theme.value(), accent: LOOK.accent.value(), intensity: LOOK.intensity.value(),
  active: accentNow().id,
  options: { theme: LOOK.theme.options, accent: LOOK.accent.options },
});
get(/^\/api\/look$/, () => lookState());
post(/^\/api\/look$/, async (m, q, body) => {
  const values = {};
  for (const [name, spec] of Object.entries(LOOK)) {
    if (body?.[name] === undefined) continue;
    if (spec.options) {
      if (!spec.options.includes(String(body[name]))) throw admin.httpError(400, `${name} must be one of ${spec.options.join(', ')}`);
      values[spec.key] = String(body[name]);
    } else {
      const n = Number(body[name]);
      if (!Number.isFinite(n) || n < spec.min || n > spec.max) throw admin.httpError(400, `${name} must be ${spec.min}-${spec.max}`);
      values[spec.key] = String(Math.round(n));
    }
  }
  if (Object.keys(values).length) { admin.save({ values }); await applySettings(); }
  return lookState();
});

get(/^\/api\/state$/, () => ({
  ha: { connected: ha.connected, configured: ha.configured, states: ha.states },
  sessions,
  streams,
  entities: config.entities,
  ui: { ...config.ui, birthdays: undefined, accent: accentNow(), dogName: config.entities.dogName },
  projectorApps: config.projectorApps,
  effectFavourites: config.effectFavourites,
  build: config.build,
  idleMinutes: config.idleMinutes,
  hallway: { dashboardUrl: config.dashboardUrl, returnMinutes: config.hallwayReturnMinutes },
  sleep: sleep.get(),
  preroll: { enabled: Boolean(config.preroll.url) && config.preroll.enabled, seconds: config.preroll.seconds, moviesOnly: config.preroll.moviesOnly },
  intermission: { minutes: config.intermission.minutes, sound: Boolean(config.intermission.url) },
  projectorHotC: config.projectorHotC,
  soundbar: { step: config.soundbarStep, calibrationSeconds: config.soundbarCalibrationSeconds, thx: Boolean(config.thxUrl) },
  services: { plex: config.media.on, stremio: config.media.on, seerr: Boolean(config.seerr.url) },
}));

get(/^\/api\/plex\/libraries$/, () => plex.libraries());
get(/^\/api\/plex\/library\/([a-z0-9-]+)$/, (m, q) => plex.listLibrary(m[1], {
  filters: (q.get('filters') || '').split(',').filter(Boolean), genre: q.get('genre') || undefined,
  brand: q.get('brand') || undefined,
  sort: q.get('sort') || 'added', start: Number(q.get('start') || 0), size: Math.min(Number(q.get('size') || 60), 120),
}));
get(/^\/api\/plex\/genres\/([a-z0-9-]+)$/, (m) => plex.genres(m[1]));
get(/^\/api\/plex\/brand\/([a-z]+)$/, (m, q) => plex.brandBrowse(m[1], { filters: (q.get('filters') || '').split(',').filter(Boolean), size: Math.min(Number(q.get('size') || 60), 120) }));
get(/^\/api\/networks$/, () => (config.seerr.url ? seerr.networks() : [])); 
get(/^\/api\/plex\/item\/([\w.%:-]+)$/, (m) => plex.item(decodeURIComponent(m[1])));
get(/^\/api\/plex\/episodes\/([\w.%:-]+)$/, (m) => plex.episodes(decodeURIComponent(m[1])));
// The panel's own settings sheet: the harmless knobs, behind the panel's auth like every action.
get(/^\/api\/tweaks$/, () => admin.tweaks());
post(/^\/api\/tweaks$/, async (m, q, body) => { const r = admin.saveTweaks(body?.values); await applySettings(); return r; });

// Continue watching, with who last watched each one (from the server's history), for the
// "last time" line when someone comes back to a film after days away.
get(/^\/api\/plex\/ondeck$/, async (m, q) => {
  const deck = await plex.onDeck(Math.min(Number(q.get('size') || 12), 60));
  const [hist, accounts] = await Promise.all([plex.history({ size: 400 }).catch(() => []), plex.accounts().catch(() => [])]);
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  for (const it of deck) {
    const row = hist.find((r) => r.key === String(it.showKey || it.id));
    if (row) { it.who = names.get(row.account) || null; it.lastViewedAt ??= row.viewedAt; }
  }
  return deck;
});
get(/^\/api\/shelves$/, () => (config.media.on && plex.shelves ? plex.shelves() : []));
get(/^\/api\/plex\/recent$/, (m, q) => plex.recentlyAdded(Math.min(Number(q.get('size') || 16), 60)));
const qrSvg = (text) => QRCode.toString(String(text).slice(0, 300), { type: 'svg', margin: 1, color: { dark: '#25170F', light: '#0000' } });

// Movie night. The panel asks for a shortlist, then everyone votes from their phones at
// /vote (a tiny page served below); the panel follows along over its event stream.

// "You'll love this": what the house finished lately, and what goes with it. Anything already
// in Plex comes back with the key that plays it; the rest can be requested from the same card.
get(/^\/api\/taste$/, async () => (config.media.on ? { rows: await taste.rows({ count: 3 }).catch(() => []) } : { rows: [] }));

// The Mystery box: one unwatched film, weighted towards what the house has been watching. The
// panel counts down and then plays it, so this only picks.
// Tonight: the film, the time, the trailers, the break. One plan at a time.
get(/^\/api\/tonight$/, () => tonight.state() || {});
post(/^\/api\/tonight$/, async (m, q, body = {}) => {
  if (body.clear) return tonight.cancel() || {};
  if (body.skip) return tonight.skip();
  if (body.start && !body.ratingKey) return tonight.start();
  if (!/^\d+$/.test(String(body.ratingKey || ''))) throw admin.httpError(400, 'Which film?');
  const at = body.at ? Number(body.at) : null;
  if (at && (!Number.isFinite(at) || at < Date.now() - 60e3 || at > Date.now() + 36 * 3600e3)) throw admin.httpError(400, 'Pick a time later today or tomorrow');
  const s = await tonight.set({ ratingKey: body.ratingKey, at, trailers: body.trailers !== false });
  return body.start ? tonight.start() : s;
});
// The marquee outside the room: the plan with everything a poster board needs, and the times.
get(/^\/api\/marquee$/, async () => {
  const plan = tonight.state();
  const showing = sessions[0] || null;
  return { plan, showing: showing ? { title: showing.title, showTitle: showing.showTitle, year: showing.year, poster: showing.poster, state: showing.state, viewOffset: showing.viewOffset, duration: showing.duration } : null, scene: ha.states['input_select.theater_scene']?.state || '', now: Date.now() };
});

// The film before and after this one in its series, and whether the library has them.
get(/^\/api\/plex\/related\/([\w.%:-]+)$/, async (m) => {
  const it = await plex.item(decodeURIComponent(m[1]));
  if (!it.tmdb || !config.tmdb.apiKey) return { collection: null, prev: null, next: null };
  const n = await tmdb.neighbours(it.tmdb).catch(() => ({ collection: null, prev: null, next: null }));
  const owned = await plex.byTmdb([n.prev?.tmdb, n.next?.tmdb].filter(Boolean)).catch(() => []);
  const own = (x) => x ? { ...x, owned: owned.find((o) => o.tmdb === x.tmdb) || null } : null;
  return { collection: n.collection, prev: own(n.prev), next: own(n.next) };
});

// When the room is used: a year of history by weekday and hour.
get(/^\/api\/habits$/, () => taste.habits());

// The guest remote. Start and end need the panel; state and act need the evening's token.
post(/^\/api\/guest\/start$/, () => guest.start(config.tonight.guestHours));
post(/^\/api\/guest\/end$/, () => { guest.end(); return { ok: true }; });
get(/^\/api\/guest$/, () => guest.state() || {});
get(/^\/api\/guest\/state$/, () => {
  const s = sessions[0];
  const tv = ha.states[config.entities.appleTv];
  return {
    title: s ? (s.showTitle ? `${s.showTitle} · ${s.title}` : s.title) : (tv?.attributes?.media_title || ''),
    state: s ? s.state : (tv?.state || 'off'), viewOffset: s?.viewOffset || 0, duration: s?.duration || 0,
    scene: ha.states['input_select.theater_scene']?.state || '', tonight: tonight.state(), expires: guest.state()?.expires || null,
  };
});
const GUEST_ACTS = {
  play_pause: { action: 'transport', cmd: 'play_pause' }, vol_up: { action: 'transport', cmd: 'vol_up' }, vol_down: { action: 'transport', cmd: 'vol_down' },
  back10: { action: 'transport', cmd: 'seek_rel', seconds: -10 }, fwd30: { action: 'transport', cmd: 'seek_rel', seconds: 30 },
  intermission: { action: 'scene', name: 'intermission' }, movie_time: { action: 'scene', name: 'movie_time' }, lights_up: { action: 'scene', name: 'lights_up' }, aisle_glow: { action: 'aisle_glow' },
};
post(/^\/api\/guest\/act$/, async (m, q, body = {}) => {
  const act = GUEST_ACTS[body.cmd];
  if (!act) throw admin.httpError(400, 'Not something a guest can do');
  await runAction(ha, act);
  return { ok: true };
});

// The settings sheet's audit: ten draws under the saved rules, nothing started.
get(/^\/api\/mystery\/preview$/, (m, q) => taste.preview({ n: Math.min(20, Math.max(1, Number(q.get('n')) || 10)), filters: (q.get('filters') || '').split(',').filter(Boolean) }));
get(/^\/api\/mystery$/, (m, q) => taste.mystery({
  filters: (q.get('filters') || '').split(',').filter(Boolean),
  exclude: (q.get('not') || '').split(',').filter(Boolean).slice(0, 20),
}));

// Year in review: the house's year from Plex's history (the Home screen's chip, and #/year).
get(/^\/api\/year$/, (m, q) => taste.review({ year: Math.min(Math.max(Number(q.get('year')) || new Date().getFullYear(), 2000), 2100) }));

// How was it? The film that just finished, and the popcorn boxes' answer on its way to Plex.
get(/^\/api\/rate$/, () => verdict || { id: null });
post(/^\/api\/rate$/, async (m, q, body) => {
  if (body?.dismiss) { verdict = null; broadcast('rate', { id: null }); return { ok: true }; }
  const id = String(body?.id || verdict?.id || '');
  const stars = Math.max(1, Math.min(5, Number(body?.stars) || 0));
  if (!id || !stars) throw new Error('Which film, and how many?');
  // Everyone in the room can add a star rating; Plex is told the average, so the last word is
  // the room's, not whoever tapped last.
  if (!verdict || verdict.id !== id) verdict = { id, title: body?.title || '', year: body?.year, poster: null, at: Date.now(), votes: [] };
  verdict.votes.push(stars);
  const average = verdict.votes.reduce((a, b) => a + b, 0) / verdict.votes.length;
  const r = await plex.rate(id, Math.round(average * 2 * 10) / 10);   // Plex counts in halves of a star
  broadcast('rate', verdict);
  taste.forget();                                      // the recommendations have something new to go on
  return { ...r, votes: verdict.votes.length, average: Math.round(average * 10) / 10 };
});

// The sleep timer lives on the server so it outlives the panel's own screen.
get(/^\/api\/sleep$/, () => sleep.get() || { mode: null });
post(/^\/api\/sleep$/, (m, q, body) => sleep.set(body || {}) || { mode: null });

post(/^\/api\/vote\/start$/, (m, q, body) => {
  const items = (body.items || []).slice(0, 6).map((i) => ({
    id: String(i.id), title: String(i.title || '').slice(0, 120), year: i.year || null,
    poster: typeof i.poster === 'string' && /^\/img\//.test(i.poster) ? i.poster : null, plexId: String(i.id),
  }));
  if (items.length < 2) throw admin.httpError(400, 'Pick at least two');
  const st = vote.start(items);
  broadcast('vote', st);
  return st;
});

get(/^\/api\/vote$/, () => vote.state() || { items: [] });


post(/^\/api\/vote$/, (m, q, body) => {
  const st = vote.vote(body.round, body.voter, body.item);
  broadcast('vote', st);
  return st;
});

post(/^\/api\/vote\/end$/, () => { const w = vote.winner(); vote.clear(); broadcast('vote', null); return { winner: w }; });

// Voice, through Home Assistant's own assistant (custom sentences in ha/theater.yaml call this):
// { intent: "play", query: "avatar" } or { intent: "scene", name: "movie_time" }.
post(/^\/api\/voice$/, (m, q, body) => voiceIntent(body));
async function voiceIntent(body = {}) {
  const intent = String(body.intent || '').toLowerCase();
  if (intent === 'scene') {
    const name = String(body.name || '').toLowerCase().replace(/[^a-z_]/g, '');
    await runAction(ha, { action: 'scene', name });
    return { ok: true, spoken: name.replace(/_/g, ' ') };
  }
  if (intent === 'navigate') {
    const route = String(body.route || '').replace(/[^\w#/?=&,.-]/g, '');
    broadcast('navigate', { route });
    return { ok: true, spoken: route.replace(/^#?\//, '') };
  }
  // "Surprise me": the server picks, every open panel opens the Mystery box on that pick, and
  // the voice answer names it. The countdown on the panel still starts it.
  if (intent === 'mystery' || intent === 'surprise') {
    const pick = await taste.mystery({ filters: (body.filters || '').split(',').filter(Boolean) });
    broadcast('mystery', pick);
    broadcast('navigate', { route: '#/lobby' });
    return { ok: true, spoken: `${pick.item.title}. ${pick.why}`, id: pick.item.id };
  }
  if (intent !== 'play') throw admin.httpError(400, 'Unknown voice intent');
  const query = String(body.query || '').trim();
  if (!query) throw admin.httpError(400, 'Nothing to play');
  const hits = await plex.search(query, 10);
  // Best match: an exact title first, then one that starts with what was said, then a movie.
  const said = query.toLowerCase();
  const name = (h) => String(h.showTitle || h.title || '').toLowerCase();
  const score = (h) => (name(h) === said ? 3 : name(h).startsWith(said) ? 2 : h.type === 'movie' ? 1 : 0);
  const best = hits.slice().sort((a, b) => score(b) - score(a))[0];
  if (!best) return { ok: false, spoken: `I could not find ${query} in Plex` };
  // A show plays its next episode, a movie plays itself.
  const target = best.type === 'show' ? (await plex.item(best.id)).next || best : best;
  if (!body.dryRun) await runAction(ha, { action: 'play', ratingKey: target.id, type: target.type, offset: target.viewOffset || 0 });
  return { ok: true, spoken: best.type === 'show' ? `${best.title}, ${target.title || 'next episode'}` : best.title, id: target.id };
}

// Idle screen: Plex's own titles (in progress, just added), with two boards woven in - the
// holiday shelf while its season lasts, and Coming soon from the request queue.
// "?season=halloween" or "christmas" shows a shelf out of season (for a look, or a screenshot).
const seasonParam = (q) => (['halloween', 'christmas', 'hallmark'].includes(q.get('season')) ? q.get('season') : undefined);
get(/^\/api\/showing$/, async (m, q) => {
  const [plexItems, soon, shelves] = await Promise.all([
    config.media.on ? plex.showing(10).catch(() => []) : [],
    config.seerr.url ? seasonal.coming(6).catch(() => []) : [],
    config.media.on ? seasonal.shelves(seasonParam(q)).catch(() => []) : [],
  ]);
  const boards = [];
  for (const shelf of shelves) if (shelf.items.length >= 4) boards.push({ id: `board-${shelf.id}`, kind: 'board', board: 'seasonal', season: shelf.id, title: shelf.title, kicker: shelf.kicker, items: shelf.items.slice(0, 8) });
  if (soon.length >= 2) boards.push({ id: 'board-coming', kind: 'board', board: 'coming', title: 'Coming soon', kicker: 'Asked for, and on its way', items: soon });
  // a board every few titles, so the idle screen alternates between them and the posters
  const out = [];
  plexItems.forEach((it, i) => { out.push(it); if (i % 3 === 2 && boards.length) out.push(boards.shift()); });
  return [...out, ...boards];
});

// The account's Plex watchlist: owned titles play, the rest can be requested.
get(/^\/api\/watchlist$/, async () => ({ items: (await plex.watchlist()) || [], signedIn: Boolean(config.plex.accountToken) }));

// Movie night draws from the season's shelf while one is up (Halloween Scares in October, the
// Christmas shelves in December), the whole unwatched pile otherwise or with season=0.
get(/^\/api\/pick$/, async (m, q) => {
  const filters = ['unwatched', ...(q.get('filters') || '').split(',')].filter(Boolean);
  const n = Math.min(6, Math.max(2, Number(q.get('n')) || 3));
  const want = q.get('season');
  if (want !== '0') {
    const shelves = await seasonal.shelves(['halloween', 'christmas'].includes(want) ? want : undefined).catch(() => []);
    let pool = shelves.flatMap((s) => s.items.map((it) => ({ ...it, shelf: s.title }))).filter((it) => !it.watched);
    if (filters.includes('short')) pool = pool.filter((it) => !it.duration || it.duration < 7200000);
    if (filters.includes('family')) pool = pool.filter((it) => !it.contentRating || ['G', 'PG', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG'].includes(it.contentRating));
    if (filters.includes('4k')) pool = pool.filter((it) => it.is4k);
    if (pool.length >= n) {
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      return { items: pool.slice(0, n), source: shelves.map((s) => s.title).join(' and ') };
    }
  }
  const { items } = await plex.listLibrary(plex.MERGED, { filters: [...new Set(filters)], sort: 'random', size: 60 });
  return { items: items.slice(0, n) };
});

// The holiday shelves on their own (the For you tab), and Coming soon.
get(/^\/api\/seasonal$/, async (m, q) => ({ shelves: config.media.on ? await seasonal.shelves(seasonParam(q)).catch(() => []) : [] }));
get(/^\/api\/coming$/, async () => ({ items: config.seerr.url ? await seasonal.coming(8) : [] }));

get(/^\/api\/plex\/search$/, (m, q) => plex.search(q.get('q') || ''));

get(/^\/api\/seerr\/search$/, (m, q) => seerr.search(q.get('q') || '', q.get('page') || 1));
get(/^\/api\/seerr\/discover\/(trending|movies|tv)$/, (m, q) => seerr.discover(m[1], q.get('page') || 1));
get(/^\/api\/seerr\/provider\/([a-z]+)$/, (m, q) => seerr.byProvider(m[1], q.get('type') === 'tv' ? 'tv' : 'movie', q.get('page') || 1));
get(/^\/api\/seerr\/(movie|tv)\/(\d+)$/, (m) => seerr.details(m[1], m[2]));
get(/^\/api\/seerr\/requests$/, (m, q) => seerr.requests(Math.min(Number(q.get('take') || 8), 30)));
get(/^\/api\/seerr\/counts$/, () => seerr.counts());
// Where a guest's phone should go to ask for something. Just the address; no key.
get(/^\/api\/seerr\/url$/, () => ({ url: config.seerr.publicUrl ? `${config.seerr.publicUrl}/discover` : '' }));
get(/^\/api\/seerr\/arrivals$/, () => (config.seerr.url ? seerr.arrivals(config.arrivalHours) : []));
post(/^\/api\/seerr\/request$/, (m, q, body) => seerr.request(body));

get(/^\/api\/music\/library$/, (m, q) => musicLibrary(ha, { type: q.get('type') || 'album', order: q.get('order') || 'timestamp_added_desc', limit: Math.min(Number(q.get('limit') || 24), 60) }));
get(/^\/api\/music\/search$/, (m, q) => musicSearch(ha, q.get('q') || ''));
get(/^\/api\/music\/queue$/, (m, q) => musicQueue(ha, q.get('entity_id')));

get(/^\/api\/games$/, () => gamesState());
get(/^\/api\/steam\/library$/, () => steamLibrary());

// Move every open panel to a route (#/showtime, #/watch?brand=netflix, #/games...). Kiosk
// Satellite's navigate service now moves the HA page around the panel, so HA automations reach
// the panel's own routes through here or, as a device, esphome.theater_panel_navigate.
post(/^\/api\/navigate$/, (m, q, body) => {
  const route = String(body.route || '');
  if (!/^#?\/?[a-z]+(\?[\w=&%.,-]*)?$/i.test(route)) throw admin.httpError(400, 'Bad route');
  broadcast('navigate', { route });
  return { ok: true, panels: clients.size };
});

post(/^\/api\/action$/, async (m, q, body) => {
  const r = await runAction(ha, body);
  // A film is on its way (after the pre-roll, and the projector waking): look for its Plex
  // session sooner than the idle 30 s poll would, so Showtime comes up with the film.
  if (body.action === 'play') for (const s of [8, 20, 35, 50]) setTimeout(pollSessions, s * 1000).unref?.();
  return { ok: true, ...(r && typeof r === 'object' && 'preroll' in r ? { preroll: r.preroll } : {}) };
});

// The panel runs inside Home Assistant's Webpage dashboard, so it must be frameable by HA
// (and nothing else): its own origin plus FRAME_ANCESTORS (e.g. https://home-iot.coulson.io).
// The admin page is never frameable.
// The panel's own pages carry a couple of inline scripts (the import map, the voting page). They
// are allowed by hash, so a stray injected script still cannot run.
// The holiday accent in effect right now; re-checked hourly so a panel left on overnight dresses
// up (or down) on the day without anyone touching it.
const accentNow = () => accents.resolve(config.ui.accent, accents.parseBirthdays(config.ui.birthdays));
let lastAccent = accentNow().id;
setInterval(() => { const id = accentNow().id; if (id !== lastAccent) { lastAccent = id; broadcast('settings', {}); } }, 60 * 60e3).unref();

const inlineHashes = await (async () => {
  const files = ['index.html', 'admin.html', 'vote.html', 'guest.html', 'marquee.html', 'fxgrid.html', 'basement.html', 'basement/dev.html'];
  const out = new Set();
  for (const f of files) {
    const html = await readFile(join(WEB, f), 'utf8').catch(() => '');
    for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      out.add(`'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
    }
  }
  return [...out].join(' ');
})();

// The origins of the configured sounds, for media-src: the panel plays the pre-roll and the
// intermission march itself when the room's speaker is asleep (server/actions.mjs).
function soundOrigins() {
  const out = new Set();
  for (const url of [config.preroll.url, config.preroll.spookyUrl, config.intermission.url, config.thxUrl]) {
    try { const u = new URL(url); if (/^https?:$/.test(u.protocol)) out.add(u.origin); } catch {}
  }
  return [...out].join(' ');
}

const frameAncestors = (path) => (path.startsWith('/admin') || path.startsWith('/api/admin') ? "'none'" : ["'self'", ...config.frameAncestors].join(' '));

// Admin API. Everything but sign-in needs the admin cookie; changes must be JSON (with the
// SameSite=Strict cookie, that keeps other sites from posting here).
async function adminApi(req, res, path) {
  const method = req.method;
  const body = method === 'POST' ? await readBody(req) : undefined;
  if (path === '/api/admin/login' && method === 'POST') return admin.login(res, body, isHttps(req));
  if (path === '/api/admin/logout' && method === 'POST') return admin.logout(res);
  if (path === '/api/admin/session') return { admin: admin.isAdmin(req), configured: Boolean(config.adminPassword) };
  if (!admin.isAdmin(req)) throw admin.httpError(401, 'Sign in first');
  if (path === '/api/admin/settings' && method === 'GET') return admin.view();
  if (path === '/api/admin/settings' && method === 'POST') { const r = admin.save(body); await applySettings(); return r; }
  if (path === '/api/admin/import' && method === 'POST') { const r = await admin.importContainer(body?.rev); await applySettings(); return r; }
  if (path === '/api/admin/entities') return admin.haEntities(ha);
  if (path === '/api/admin/plex-libraries') return admin.plexLibraries();
  if (path === '/api/admin/light-effects') return admin.lightEffects(ha);
  if (path === '/api/admin/icons') return icons.search(ha, new URL(req.url, 'http://panel').searchParams.get('q'));
  if (path === '/api/admin/test' && method === 'POST') {
    // The Wrapped message goes out through HA, so its test lives here rather than in admin.mjs.
    if (body.service === 'wrapped') {
      const targets = String(body.values?.WRAPPED_NOTIFY ?? config.wrapped.notify.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
      try { const r = await wrapped.send(ha, targets, { test: true }); return { ok: true, detail: `Sent to ${r.sent.join(', ')}` }; }
      catch (e) { return { ok: false, detail: e.message }; }
    }
    return admin.test(body.service, body.values);
  }
  if (path === '/api/admin/plex-pin' && method === 'POST') return admin.plexPinStart();
  if (path.startsWith('/api/admin/plex-pin/')) return admin.plexPinCheck(path.split('/').pop());
  if (path === '/api/admin/plex-account') return admin.plexAccount();
  throw admin.httpError(404, 'Not found');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://panel');
  const path = url.pathname;
  // Tight by default: the panel loads only its own files, and nothing may be sniffed as a type
  // it is not. Images come from our own proxy, so 'self' covers them too. Sounds may also come
  // from wherever the settings page points the pre-roll and the march (Home Assistant's www
  // folder, say): those origins, and only those, join media-src.
  res.setHeader('Content-Security-Policy',
    `default-src 'self'; script-src 'self' ${inlineHashes}; img-src 'self' data:; media-src 'self' ${soundOrigins()}; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${frameAncestors(path)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    if (!authorized(req, url, res)) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('Open this page once with ?key=<PANEL_KEY>.');
      return;
    }
    checkPost(req);

    if (path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: hello\ndata: ${JSON.stringify({ ha: { connected: ha.connected, configured: ha.configured, states: ha.states }, sessions, streams, build: config.build.version })}\n\n`);
      clients.add(res);
      hass.panelsChanged();
      if (clients.size === 1) pollSessions(); // first viewer: don't wait for the next poll
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); hass.panelsChanged(); });
      return;
    }

    // Artwork for a watched HA entity (media player covers), cached like any other image.
    if (path === '/api/ha-image') {
      const id = url.searchParams.get('e');
      const pic = entities.includes(id) && ha.states[id]?.attributes?.entity_picture;
      if (!pic) { res.writeHead(404).end(); return; }
      res.writeHead(302, { location: extImage(pic.startsWith('http') ? pic : config.ha.url + pic), 'cache-control': 'no-store' }).end();
      return;
    }

    // Container health check: no key, no secrets, just "the server is up".
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(`ok ${config.build.version}`);
      return;
    }

    // The QR the panel shows for movie night: the address people should open.
    if (path === '/api/vote/qr.svg') {
      const svg = await qrSvg(url.searchParams.get('url') || '/vote');
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(svg);
      return;
    }

    // A snapshot of the dog camera, so the panel never needs an HA token. Only that one entity,
    // and only while it is configured, so this cannot become a general camera proxy.
    if (path === '/api/camera.jpg') {
      const id = config.entities.dogCamera;
      if (!id || !config.ha.url || !config.ha.token) { res.writeHead(404).end(); return; }
      const r = await fetch(`${config.ha.url}/api/camera_proxy/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${config.ha.token}` } });
      if (!r.ok) { res.writeHead(502).end(); return; }
      res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }

    // One icon as SVG, e.g. /api/icon/mdi/microsoft-xbox.svg. Never framed or scripted.
    const ic = /^\/api\/icon\/([a-z0-9-]+)\/([a-z0-9-]+)\.svg$/.exec(path);
    if (ic) {
      const svg = await icons.iconSvg(ha, ic[1], ic[2]);
      if (!svg) { res.writeHead(404, { 'cache-control': 'max-age=300' }).end(); return; }
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=31536000, immutable', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'x-content-type-options': 'nosniff' });
      res.end(svg);
      return;
    }

    if (path.startsWith('/api/admin/')) {
      try { return json(res, 200, await adminApi(req, res, path)); }
      catch (e) { return json(res, e.status || 502, { error: e.message }); }
    }
    if (path === '/admin' || path === '/admin/') return serveFile(res, join(WEB, 'admin.html'));
    if (path === '/vote' || path === '/vote/') return serveFile(res, join(WEB, 'vote.html'));
    if (path === '/guest' || path === '/guest/') return serveFile(res, join(WEB, 'guest.html'));
    if (path === '/marquee' || path === '/marquee/') return serveFile(res, join(WEB, 'marquee.html'));

    if (path.startsWith('/api/')) {
      for (const [method, re, fn] of routes) {
        const m = path.match(re);
        if (!m || method !== req.method) continue;
        const body = method === 'POST' ? await readBody(req) : undefined;
        return json(res, 200, await fn(m, url.searchParams, body));
      }
      return json(res, 404, { error: 'Not found' });
    }

    if (path.startsWith('/img/')) return serveImage(req, res);
    if (VENDOR[path]) return serveFile(res, join(MODULES, VENDOR[path]), 'public, max-age=2592000');
    const f = FONTS.exec(path);
    if (f) return serveFile(res, join(MODULES, '@fontsource', f[2], 'files', f[1]), 'public, max-age=31536000, immutable');

    // Static UI. Every unknown path serves the app so /watch, /music etc. can be bookmarked.
    const rel = normalize(path).replace(/^(\.\.[/\\])+/, '');
    if (rel !== '/' && extname(rel)) return serveFile(res, join(WEB, rel));
    return serveFile(res, join(WEB, 'index.html'));
  } catch (e) {
    // Errors that know their status (bad input, not found) keep it; anything else is an upstream
    // (Plex, Seerr, HA) or unexpected failure.
    console.warn(`[http] ${req.method} ${path}: ${e.message}`);
    if (!res.headersSent) json(res, e.status || 502, { error: e.message });
  }
});

await initImageCache();
sleep.init({ ha, broadcast, run: (body) => runAction(ha, body), script: (name, vars) => script(ha, name, vars) });
hass.init({ ha, broadcast, run: (body) => runAction(ha, body), save: async (body) => admin.save(body), applySettings, panels: () => clients.size, voice: (body) => voiceIntent(body) });
hass.apply();
tonight.init({ ha, broadcast, onChange: (plan) => hass.tonight(plan) });
ha.start();
pollSessions();
if (config.media.on) { plex.warmMovies(); }
wrapped.schedule(ha);
server.listen(config.port, () => {
  console.log(`[panel] theater-panel ${config.build.version}${config.build.time ? ` (${config.build.time})` : ''}`);
  console.log(`[panel] listening on :${config.port}`);
  console.log(`[panel] HA ${config.ha.url || '(not set)'} | Stremio ${config.media.on ? config.stremio.email || 'auth key' : '(not set)'} | Seerr ${config.seerr.url || '(not set)'}`);
});

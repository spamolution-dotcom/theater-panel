// Stremio as the panel's library, in place of Plex. The rest of the server imports this module
// under the name `plex` (through media.mjs) and calls the same functions, so the screens do not
// need to know where titles come from.
//
// Sources:
// - Stremio's account API (api.strem.io, unofficial but the one Stremio's own apps use): the
//   library, continue watching and watch history. Signs in with email and password once, keeps
//   the auth key in memory and on disk, and signs in again if the key stops working.
// - Cinemeta (v3-cinemeta.strem.io, public): catalogs, search, full metadata, series episodes.
// - Posters and backgrounds from Stremio's image host (images.metahub.space), through the panel's
//   own image cache.
//
// Ids are Stremio's: "tt0111161" for a film or series, "tt9288030:1:2" for an episode and
// "tt9288030:s1" for a season (the panel's own form, for the season picker).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { config } from './config.mjs';
import { extImage } from './images.mjs';
import { httpError } from './admin.mjs';

const API = 'https://api.strem.io/api';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const METAHUB = 'https://images.metahub.space';

// ---------- small helpers ----------

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  if (hit?.pending) return hit.pending;
  const pending = fn();
  cache.set(key, { ...hit, pending });
  try {
    const v = await pending;
    cache.set(key, { t: Date.now(), v });
    return v;
  } catch (e) {
    if (hit && 'v' in hit) { cache.set(key, hit); return hit.v; }   // keep serving the last good answer
    cache.delete(key);
    throw e;
  }
}

async function getJson(url, timeoutMs = 15000) {
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (r.status === 404) return null;
  if (!r.ok) throw httpError(502, `${new URL(url).host} ${r.status}`);
  return r.json();
}

const ms = (v) => (v == null ? null : typeof v === 'number' ? v : Date.parse(v) || null);
const minutes = (s) => { const m = /(\d+)\s*min/i.exec(String(s || '')); return m ? Number(m[1]) * 60000 : null; };
const yearOf = (v) => { const m = /\d{4}/.exec(String(v ?? '')); return m ? Number(m[0]) : undefined; };
const kind = (stremioType) => (stremioType === 'series' ? 'show' : stremioType);
const stremioType = (panelType) => (panelType === 'show' || panelType === 'episode' ? 'series' : 'movie');

// Ids end up in Cinemeta URLs: keep them to the characters Stremio ids use.
function checkId(v, what = 'id') {
  const s = String(v ?? '');
  if (!/^[A-Za-z0-9_.%-]+(?::[A-Za-z0-9_.%-]+)*$/.test(s) || s.length > 80) throw httpError(400, `Bad ${what}`);
  return s;
}
const baseId = (id) => String(id).split(':')[0];

const poster = (id, fallback, size = 'medium') => extImage(/^tt\d+$/.test(id) ? `${METAHUB}/poster/${size}/${id}/img` : fallback);
const background = (id, fallback) => extImage(/^tt\d+$/.test(id) ? `${METAHUB}/background/medium/${id}/img` : fallback);

// ---------- Stremio account ----------

const AUTH_FILE = join(dirname(process.env.SETTINGS_FILE || join(dirname(config.cacheDir || './cache'), 'settings.json')), 'stremio-auth.json');
let authKey = null;
try { authKey = JSON.parse(readFileSync(AUTH_FILE, 'utf8')).authKey || null; } catch { /* first run */ }

export const configured = () => Boolean(config.stremio?.email && config.stremio?.password) || Boolean(config.stremio?.authKey);

async function post(path, body) {
  const r = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (r.status === 401 || data?.error?.code === 1 || /session/i.test(data?.error?.message || '')) {
    const e = httpError(401, data?.error?.message || 'Stremio sign-in needed');
    e.auth = true;
    throw e;
  }
  if (!r.ok || data?.error) throw httpError(502, `Stremio ${path}: ${data?.error?.message || r.status}`);
  return data?.result ?? data;
}

async function login() {
  if (!config.stremio?.email || !config.stremio?.password) {
    if (config.stremio?.authKey) return (authKey = config.stremio.authKey);
    throw httpError(503, 'Stremio is not set up: add the email and password in the add-on options');
  }
  const res = await post('login', { email: config.stremio.email, password: config.stremio.password, facebook: false });
  authKey = res?.authKey;
  if (!authKey) throw httpError(502, 'Stremio sign-in returned no key');
  try {
    mkdirSync(dirname(AUTH_FILE), { recursive: true });
    writeFileSync(AUTH_FILE, JSON.stringify({ authKey, at: new Date().toISOString() }), { mode: 0o600 });
  } catch (e) { console.warn(`[stremio] could not save the sign-in: ${e.message}`); }
  console.log('[stremio] signed in');
  return authKey;
}

// A call that needs the account: sign in first if needed, and once more if the key has expired.
async function withAuth(fn) {
  if (!authKey) await login();
  try { return await fn(authKey); }
  catch (e) {
    if (!e.auth) throw e;
    authKey = null;
    await login();
    return fn(authKey);
  }
}

// Every library item Stremio keeps for the account, including removed and "temp" ones (watched
// without being added), which is where continue watching and history live.
const LIB_TTL = 60e3;
const rawLibrary = () => cached('library', LIB_TTL, () =>
  withAuth((key) => post('datastoreGet', { authKey: key, collection: 'libraryItem', ids: [], all: true }))
    .then((r) => (Array.isArray(r) ? r : [])));

export const staleMovies = () => cache.delete('library');
export const warmMovies = () => rawLibrary().then((l) => console.log(`[stremio] library: ${l.length} items`))
  .catch((e) => console.warn('[stremio] library:', e.message));

const inLibrary = (it) => !it.removed && !it.temp && (it.type === 'movie' || it.type === 'series');
const finished = (offset, duration) => Boolean(duration) && (offset || 0) >= 0.9 * duration;
// A film watched to the end is done; a series stays, because its next episode is up next.
const inProgress = (it) => (it.type === 'movie' || it.type === 'series') && (!it.removed || it.temp) && (it.state?.timeOffset || 0) > 0
  && !(it.type === 'movie' && finished(it.state.timeOffset, it.state.duration));
const watchedFlag = (it) => (it.state?.timesWatched || 0) > 0 || (it.state?.flaggedWatched || 0) > 0;
const lastWatched = (it) => ms(it.state?.lastWatched) || 0;

async function libraryIndex() {
  const lib = await rawLibrary();
  return new Map(lib.map((it) => [it._id, it]));
}

// ---------- Cinemeta ----------

const metaTtl = 6 * 3600e3;
export function meta(type, id) {
  id = checkId(id);
  return cached(`meta:${type}:${id}`, metaTtl, async () => (await getJson(`${CINEMETA}/meta/${type}/${encodeURIComponent(id)}.json`))?.meta || null);
}
// A film or a series when the type is not known: the library knows, else ask Cinemeta both ways.
async function metaAny(id) {
  const lib = await libraryIndex().catch(() => new Map());
  const known = lib.get(id)?.type;
  if (known) return meta(known, id);
  return (await meta('series', id)) || (await meta('movie', id));
}

async function catalog(type, { genre, skip, search } = {}) {
  const extra = [genre && `genre=${encodeURIComponent(genre)}`, search && `search=${encodeURIComponent(search)}`, skip && `skip=${skip}`].filter(Boolean).join('&');
  const url = `${CINEMETA}/catalog/${type}/top${extra ? `/${extra}` : ''}.json`;
  return cached(`cat:${url}`, search ? 10 * 60e3 : 3600e3, async () => (await getJson(url))?.metas || []);
}

// ---------- mapping to the panel's item shape ----------

function fromMeta(m, lib) {
  const id = m.id || m.imdb_id;
  const state = lib?.get(id)?.state;
  return {
    id,
    type: kind(m.type),
    title: m.name,
    year: yearOf(m.year ?? m.releaseInfo),
    summary: m.description,
    duration: minutes(m.runtime),
    viewOffset: state?.timeOffset || 0,
    watched: lib?.get(id) ? watchedFlag(lib.get(id)) : false,
    rating: m.imdbRating ? Number(m.imdbRating) : undefined,
    genres: (m.genres || m.genre || []).slice(0, 3),
    allGenres: m.genres || m.genre || [],
    addedAt: lib?.get(id) ? Math.floor((ms(lib.get(id)._ctime) || 0) / 1000) : undefined,
    lastViewedAt: state ? lastWatched(lib.get(id)) || null : null,
    inLibrary: lib ? inLibrary(lib.get(id) || {}) : false,
    is4k: false,
    quality: null,
    poster: poster(id, m.poster),
    art: background(id, m.background),
  };
}

function fromLibrary(it) {
  const s = it.state || {};
  return {
    id: it._id,
    type: kind(it.type),
    title: it.name,
    year: yearOf(it.year),
    duration: s.duration || null,
    viewOffset: s.timeOffset || 0,
    watched: watchedFlag(it),
    addedAt: Math.floor((ms(it._ctime) || 0) / 1000),
    lastViewedAt: lastWatched(it) || null,
    inLibrary: inLibrary(it),
    is4k: false,
    quality: null,
    poster: poster(it._id, it.poster),
    art: background(it._id, it.background),
  };
}

const episodeNo = (v) => Number(v.episode ?? v.number ?? 0);

function fromVideo(v, show, { offset = 0, duration = null } = {}) {
  return {
    id: v.id,
    type: 'episode',
    title: v.name || v.title || `Episode ${episodeNo(v)}`,
    showTitle: show.name,
    showKey: show.id,
    season: Number(v.season),
    episode: episodeNo(v),
    summary: v.overview || v.description,
    duration: duration || minutes(show.runtime),
    viewOffset: offset,
    watched: false,
    released: v.released,
    poster: poster(show.id, show.poster),
    still: extImage(v.thumbnail) || background(show.id, show.background),
    art: background(show.id, show.background),
  };
}

// The episode a series item in the library points at (where it was left), as a panel item.
async function libraryEpisode(it) {
  const s = it.state || {};
  const show = await meta('series', it._id).catch(() => null);
  const vid = s.video_id && s.video_id !== it._id ? s.video_id : null;
  const v = show?.videos?.find((x) => x.id === vid);
  if (show && v) {
    // Stremio keeps the position of an episode watched to the end. Past 90% it is finished: offer
    // the next episode from the start, as Stremio's own Continue Watching does.
    const dur = s.duration || minutes(show.runtime);
    if (finished(s.timeOffset, dur)) {
      const order = (show.videos || []).filter((x) => Number(x.season) > 0)
        .sort((a, b) => Number(a.season) - Number(b.season) || episodeNo(a) - episodeNo(b));
      const next = order[order.findIndex((x) => x.id === v.id) + 1];
      if (next) return { ...fromVideo(next, show), lastViewedAt: lastWatched(it) || null };
    }
    return { ...fromVideo(v, show, { offset: finished(s.timeOffset, dur) ? 0 : s.timeOffset || 0, duration: dur }), lastViewedAt: lastWatched(it) || null };
  }
  const [, season, episode] = String(vid || '').split(':');
  return {
    ...fromLibrary(it),
    id: vid || it._id,
    type: vid ? 'episode' : 'show',
    title: vid ? `Episode ${episode}` : it.name,
    showTitle: it.name,
    showKey: it._id,
    season: season ? Number(season) : undefined,
    episode: episode ? Number(episode) : undefined,
  };
}

// ---------- what the screens ask for ----------

export const MERGED = 'movies';
const LIBS = [
  { id: 'movies', title: 'My movies', type: 'movie', source: 'library' },
  { id: 'shows', title: 'My shows', type: 'show', source: 'library' },
];
// The Watch tabs and the lobby's shelves: your library first, then every catalog your installed
// Stremio addons offer, in the order Stremio lists them (Cinemeta's Popular / New / Featured, and
// whatever the other addons add).
export async function libraries() {
  const cats = await catalogs().catch((e) => { console.warn('[stremio] addon catalogs:', e.message); return []; });
  return [...LIBS, ...cats].map(({ id, title, type, source }) => ({ id, title, type, source: source === 'library' ? 'library' : 'catalog' }));
}

// ---------- addon catalogs ----------

// The account's installed addons, as Stremio's apps see them.
const addons = () => cached('addons', 3600e3, () =>
  withAuth((key) => post('addonCollectionGet', { authKey: key, update: true }))
    .then((r) => (Array.isArray(r?.addons) ? r.addons : [])));

const catKey = (url, type, id) => `cat-${createHash('sha1').update(`${url}|${type}|${id}`).digest('hex').slice(0, 10)}`;
let catIndex = new Map();
// Catalogs a screen can page through: films and series, and nothing that needs an input first
// (search, or a catalog that insists on a genre).
export async function catalogs() {
  const list = [];
  for (const a of await addons()) {
    const base = String(a.transportUrl || '').replace(/\/manifest\.json$/, '');
    const m = a.manifest || {};
    if (!/^https?:\/\//.test(base)) continue;
    for (const c of m.catalogs || []) {
      if (!['movie', 'series'].includes(c.type)) continue;
      const extras = c.extra || [];
      if ((c.extraRequired || []).length || extras.some((e) => e.isRequired)) continue;
      const kind = c.type === 'series' ? 'Series' : 'Films';
      const name = c.name || c.id;
      const title = /cinemeta/i.test(m.name || m.id || '') ? `${name} ${kind.toLowerCase()}` : `${name} · ${kind}`;
      list.push({ id: catKey(base, c.type, c.id), title, type: kind === 'Series' ? 'show' : 'movie', source: 'addon', base, catType: c.type, catId: c.id, addon: m.name || m.id, paged: extras.some((e) => e.name === 'skip'), genres: extras.find((e) => e.name === 'genre')?.options || [] });
    }
  }
  catIndex = new Map(list.map((c) => [c.id, c]));
  return list;
}

async function addonCatalog(def, { skip = 0, genre } = {}) {
  const parts = [genre && `genre=${encodeURIComponent(genre)}`, skip && def.paged && `skip=${skip}`].filter(Boolean);
  const extra = parts.length ? `/${parts.join('&')}` : '';
  const url = `${def.base}/catalog/${def.catType}/${encodeURIComponent(def.catId)}${extra}.json`;
  const metas = await cached(`addoncat:${url}`, 30 * 60e3, async () => (await getJson(url, 12000))?.metas || []);
  // Titles the panel can open are the IMDb-keyed ones (Cinemeta has their details and seasons).
  return metas.filter((m) => /^tt\d+$/.test(m.id || ''));
}

const SORTS = {
  added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
  title: (a, b) => String(a.title).localeCompare(String(b.title)),
  year: (a, b) => (b.year || 0) - (a.year || 0),
  released: (a, b) => (b.year || 0) - (a.year || 0),
  rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1),
  watched: (a, b) => (b.lastViewedAt || 0) - (a.lastViewedAt || 0),
};
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- Watch filters ----------
//
// Family friendly = IMDb's "Family" genre (not "Animation", which takes in adult shows too).
// Under 2 hours = a known running time under 120 min (unknown is left out, not let through).
// Library items and some addon catalogs carry no genres, running time or rating, so those are
// looked up in Cinemeta once (cached for 6 hours) when a filter or sort needs them.
const isFamily = (it) => (it.allGenres || it.genres || []).some((g) => /^family$/i.test(g));
const isShort = (it) => Boolean(it.duration) && it.duration < 7200000;

async function eachLimited(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) await fn(list[i++]); }));
}
async function enrich(items, { genres, runtime, rating, force }) {
  // force: catalog rows carry an abbreviated genre list, so read the full one from the title's page.
  const todo = items.filter((it) => (genres && (force || !(it.allGenres || []).length)) || (runtime && !it.duration) || (rating && it.rating == null));
  await eachLimited(todo, 8, async (it) => {
    const m = await meta(stremioType(it.type), it.id).catch(() => null);
    if (!m) return;
    const full = m.genres || m.genre || [];
    if (full.length && (force || !(it.allGenres || []).length)) { it.allGenres = full; it.genres = full.slice(0, 3); }
    if (!it.duration) it.duration = minutes(m.runtime);
    if (it.rating == null && m.imdbRating) it.rating = Number(m.imdbRating);
    if (!it.year) it.year = yearOf(m.releaseInfo ?? m.year);
  });
}
async function applyFilters(items, filters, sort) {
  const family = filters.includes('family');
  const short = filters.includes('short');
  let out = filters.includes('unwatched') ? items.filter((it) => !it.watched) : items;
  if (family) await enrich(out, { genres: true, force: true });
  if (short || sort === 'rating') await enrich(out, { runtime: short, rating: sort === 'rating' });
  if (family) out = out.filter(isFamily);
  if (short) out = out.filter(isShort);
  return out;
}

export async function listLibrary(libId, { filters = [], genre, sort = 'added', start = 0, size = 60 } = {}) {
  let def = LIBS.find((l) => l.id === libId) || catIndex.get(libId);
  if (!def && String(libId).startsWith('cat-')) { await catalogs(); def = catIndex.get(libId); }
  if (!def) throw httpError(404, 'No such library');
  // Catalogs are ranked lists fetched a page at a time: they keep their own order (only Random
  // reshuffles the page), and a filtered page can come back shorter than a full one.
  if (def.source === 'addon' || def.source === 'catalog') {
    const lib = await libraryIndex().catch(() => null);
    const type = def.source === 'addon' ? def.catType : stremioType(def.type);
    // Family friendly: ask the catalog for its Family genre when it has one (Cinemeta does).
    const family = filters.includes('family');
    const g = genre || (family && (def.source === 'catalog' || (def.genres || []).includes('Family')) ? 'Family' : undefined);
    const page = (skip) => (def.source === 'addon' ? addonCatalog(def, { skip, genre: g }) : catalog(type, { genre: g, skip: skip || undefined }));
    // A filter can empty most of a page, so read on (up to 6 pages) until there is a screenful.
    let skip = start, items = [], more = true;
    for (let n = 0; n < 6 && more && items.length < Math.min(size, 24); n++) {
      const metas = await page(skip);
      skip += metas.length;
      more = metas.length > 0 && (def.source !== 'addon' || def.paged);
      // Asked the catalog for Family already: trust it (catalog rows list only a few genres each).
      const rest = g === 'Family' && !genre ? filters.filter((f) => f !== 'family') : filters;
      items.push(...await applyFilters(metas.map((m) => fromMeta({ type, ...m }, lib)), rest, null));
    }
    if (sort === 'random') items = shuffle(items);
    return { total: start + items.length + (more ? size : 0), items, next: skip, more };
  }
  const want = stremioType(def.type);
  let rows = (await rawLibrary()).filter((it) => inLibrary(it) && it.type === want).map(fromLibrary);
  rows = await applyFilters(rows, filters, sort);
  rows = sort === 'random' ? shuffle(rows) : rows.sort(SORTS[sort] || SORTS.added);
  return { total: rows.length, items: rows.slice(start, start + size) };
}

// Cinemeta's genres for the catalog tabs (the library tabs have none to filter on).
export async function genres(libId) {
  const def = LIBS.find((l) => l.id === libId);
  if (!def || def.source !== 'catalog') return [];   // library tabs and addon catalogs: no genre filter
  const manifest = await cached('manifest', 24 * 3600e3, () => getJson(`${CINEMETA}/manifest.json`));
  const cat = (manifest?.catalogs || []).find((c) => c.type === stremioType(def.type) && c.id === 'top');
  const opts = (cat?.extra || []).find((e) => e.name === 'genre')?.options || cat?.genres || [];
  return opts.map((g) => ({ id: g, title: g }));
}

export async function brandBrowse() { return { total: 0, items: [] }; }

export async function item(id) {
  id = checkId(id, 'item id');
  const lib = await libraryIndex().catch(() => new Map());
  const [showId, sn, en] = id.split(':');
  if (sn && en) {   // an episode
    const show = await meta('series', showId);
    const v = show?.videos?.find((x) => x.id === id);
    if (!show || !v) throw httpError(404, 'Not found');
    const s = lib.get(showId)?.state;
    return { ...fromVideo(v, show, { offset: s?.video_id === id ? s.timeOffset || 0 : 0 }), cast: (show.cast || []).slice(0, 4), genres: (show.genres || []).slice(0, 4), versions: [], badges: [] };
  }
  const m = await metaAny(id);
  if (!m) throw httpError(404, 'Not found');
  const out = {
    ...fromMeta(m, lib),
    poster: poster(id, m.poster, 'large'),
    directors: (m.director || []).slice(0, 2),
    cast: (m.cast || []).slice(0, 4),
    genres: (m.genres || m.genre || []).slice(0, 4),
    tagline: undefined,
    versions: [],
    badges: [],
  };
  if (m.type === 'series') {
    const videos = (m.videos || []).filter((v) => v.season != null);
    const bySeason = new Map();
    for (const v of videos) bySeason.set(Number(v.season), (bySeason.get(Number(v.season)) || 0) + 1);
    out.seasons = [...bySeason.entries()].sort((a, b) => (a[0] || 99) - (b[0] || 99))
      .map(([n, count]) => ({ id: `${id}:s${n}`, title: n === 0 ? 'Specials' : `Season ${n}`, index: n, leafCount: count, viewedLeafCount: 0 }));
    out.leafCount = videos.filter((v) => Number(v.season) > 0).length;
    // Next up: where Stremio left off, else the first episode of the first real season.
    const it = lib.get(id);
    const at = it?.state?.video_id && videos.find((v) => v.id === it.state.video_id);
    const first = videos.filter((v) => Number(v.season) > 0).sort((a, b) => Number(a.season) - Number(b.season) || episodeNo(a) - episodeNo(b))[0];
    const next = at || first;
    if (next) out.next = fromVideo(next, m, { offset: at ? it.state.timeOffset || 0 : 0 });
  }
  return out;
}

export async function episodes(seasonId) {
  const m = /^(.+):s(\d+)$/.exec(checkId(seasonId, 'season id'));
  if (!m) throw httpError(400, 'Bad season id');
  const show = await meta('series', m[1]);
  if (!show) throw httpError(404, 'Not found');
  const lib = await libraryIndex().catch(() => new Map());
  const s = lib.get(m[1])?.state;
  return (show.videos || []).filter((v) => Number(v.season) === Number(m[2]))
    .sort((a, b) => episodeNo(a) - episodeNo(b))
    .map((v) => fromVideo(v, show, { offset: s?.video_id === v.id ? s.timeOffset || 0 : 0 }));
}

// Continue watching, as Stremio's own apps show it: anything with a saved position, newest first.
export async function onDeck(size = 12) {
  const rows = (await rawLibrary()).filter(inProgress).sort((a, b) => lastWatched(b) - lastWatched(a)).slice(0, size);
  return Promise.all(rows.map((it) => (it.type === 'series' ? libraryEpisode(it) : fromLibrary(it))));
}

export async function recentlyAdded(size = 16) {
  return (await rawLibrary()).filter(inLibrary).sort((a, b) => (ms(b._ctime) || 0) - (ms(a._ctime) || 0)).slice(0, size).map(fromLibrary);
}

// The idle screen's list: what is in progress, then what was added lately.
export async function showing(size = 10) {
  const [deck, recent] = await Promise.all([onDeck(6).catch(() => []), recentlyAdded(size).catch(() => [])]);
  const out = [];
  const seen = new Set();
  const key = (m) => String(m.showKey || m.id);
  for (const m of deck) {
    if (seen.has(key(m))) continue;
    seen.add(key(m));
    out.push({ ...m, id: `deck-${m.id}`, kind: 'deck', label: m.viewOffset ? 'Continue watching' : 'Up next' });
  }
  for (const m of recent) {
    if (seen.has(key(m))) continue;
    seen.add(key(m));
    out.push({ ...m, id: `new-${m.id}`, kind: 'new', label: 'In your library' });
  }
  return out;
}

export async function search(query, size = 30) {
  const q = String(query || '').trim();
  if (!q) return [];
  const [films, series, lib] = await Promise.all([
    catalog('movie', { search: q }).catch(() => []),
    catalog('series', { search: q }).catch(() => []),
    libraryIndex().catch(() => null),
  ]);
  const out = [];
  for (let i = 0; out.length < size && (i < films.length || i < series.length); i++) {
    if (films[i]) out.push(fromMeta({ type: 'movie', ...films[i] }, lib));
    if (series[i]) out.push(fromMeta({ type: 'series', ...series[i] }, lib));
  }
  return out.slice(0, size);
}

// Watch history: one row per title Stremio has seen played, newest first. Stremio keeps only the
// last time per title, so dedupe is always on and there is one household account.
export async function history({ size = 200, since = null } = {}) {
  return (await rawLibrary())
    .filter((it) => (it.type === 'movie' || it.type === 'series') && lastWatched(it) && (!since || lastWatched(it) > since))
    .sort((a, b) => lastWatched(b) - lastWatched(a))
    .slice(0, size)
    .map((it) => ({ key: it._id, type: kind(it.type), title: it.name, viewedAt: lastWatched(it), account: null }));
}
export async function accounts() { return []; }

// Metadata for history rows, keyed by id (Year in review).
export async function metaBatch(keys) {
  const out = new Map();
  const lib = await libraryIndex().catch(() => new Map());
  for (const k of [...new Set(keys.map(String))].slice(0, 200)) {
    const m = await meta(lib.get(k)?.type || 'movie', k).catch(() => null);
    if (m) out.set(k, fromMeta(m, lib));
  }
  return out;
}
export async function seedDetails(id) {
  const m = await metaAny(checkId(id)).catch(() => null);
  return m ? { id: m.id, type: kind(m.type), title: m.name, year: yearOf(m.releaseInfo), genres: m.genres || [], imdb: m.id } : null;
}

// Now playing comes from Home Assistant (the Streamer's foreground app), not from here.
export async function activity() { return { sessions: [], streams: [] }; }
export async function sessions() { return []; }

// Plex-only features with no Stremio counterpart yet. Empty answers keep the screens quiet.
export async function watchlist() { return []; }
export async function byTmdb() { return []; }
export async function ratedMovies() { return []; }
export async function collectionItems() { return []; }
export async function rate() { return { ok: false }; }
export async function clearProgress() { return { ok: false }; }
export async function setStreams() { return { ok: false }; }
export const RECENT_FROM = () => new Date().getFullYear() - (config.mystery?.years || 10);
export const RATED_MIN = () => config.mystery?.minRating || 0;

// The lobby's rows: your films and shows, then each addon catalog, first page only.
export async function shelves() {
  const cats = await catalogs().catch(() => []);
  return [...LIBS, ...cats].map(({ id, title, type, addon }) => ({ id, title, type, addon: addon || 'Your library' }));
}

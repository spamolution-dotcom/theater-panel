// Image proxy with a disk cache. Posters and backdrops are fetched once at the size the panel
// draws them and then served from disk, so scrolling the poster grid never touches Plex, TMDB
// or Home Assistant. Upstream tokens stay on the server.
//
// Three sources:
//   /img/plex/<w>x<h>?p=<plex image path>   resized by Plex's own transcoder
//   /img/tmdb/<size>/<file>                  TMDB CDN (posters for titles not in Plex)
//   /img/steam/<appid>/<file>                Steam CDN (library capsules for the Games screen)
//   /img/ext?u=<url>&s=<sig>                 any other URL the server itself handed out
//                                            (Music Assistant art, HA entity pictures);
//                                            signed so the proxy cannot be used to reach
//                                            arbitrary hosts on the LAN.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, stat, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.mjs';

// Stable across restarts (so image links in an open page keep working), derived from the
// configured secrets unless IMAGE_SECRET is set.
// IMAGE_SECRET is generated on first run (see config.mjs) so /img/ext links can't be forged.
const secret = createHash('sha256').update(process.env.IMAGE_SECRET || config.imageSecret || randomBytes(32).toString('hex')).digest();
const dir = join(config.cacheDir, 'img');
let writesSincePrune = 0;
let writeSeq = 0;

export async function initImageCache() {
  await mkdir(dir, { recursive: true });
  prune().catch(() => {});
}

export function plexImage(path, w, h) {
  if (!path) return null;
  return `/img/plex/${w}x${h}?p=${encodeURIComponent(path)}`;
}
export function tmdbImage(file, size = 'w342') {
  return file ? `/img/tmdb/${size}${file}` : null;
}
export function extImage(url) {
  if (!url) return null;
  return `/img/ext?u=${encodeURIComponent(url)}&s=${sign(url)}`;
}
const sign = (url) => createHmac('sha256', secret).update(url).digest('hex').slice(0, 24);

// Returns { upstreamUrl, headers } for a request path, or null when the request is not allowed.
function resolve(url) {
  const u = new URL(url, 'http://x');
  let m;
  if ((m = u.pathname.match(/^\/img\/plex\/(\d{2,4})x(\d{2,4})$/))) {
    const p = u.searchParams.get('p');
    // Only Plex's own media paths: "//host/x" would make Plex fetch somewhere else entirely.
    if (!p || !/^\/(library|photo|metadata)\/[^/]/.test(p) || !config.plex.url) return null;
    const q = new URLSearchParams({
      url: p, width: m[1], height: m[2], minSize: '1', upscale: '1', format: 'jpeg', quality: '80',
      'X-Plex-Token': config.plex.token,
    });
    return { upstream: `${config.plex.url}/photo/:/transcode?${q}` };
  }
  if ((m = u.pathname.match(/^\/img\/tmdb\/(w\d{2,4}|original)(\/[A-Za-z0-9_-]+\.(?:jpg|png))$/))) {
    return { upstream: `https://image.tmdb.org/t/p/${m[1]}${m[2]}` };
  }
  if ((m = u.pathname.match(/^\/img\/steam\/(\d{1,9})\/(library_600x900\.jpg|header\.jpg)$/))) {
    return { upstream: `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${m[1]}/${m[2]}` };
  }
  if (u.pathname === '/img/ext') {
    const target = u.searchParams.get('u');
    if (!target || u.searchParams.get('s') !== sign(target)) return null;
    // Home Assistant's own image paths (entity pictures, image entities). Inside the add-on HA is
    // reached through the Supervisor's proxy, which wants the token even when the URL carries one.
    if (config.ha.url && config.ha.token && target.startsWith(`${config.ha.url}/`)) {
      return { upstream: target, headers: { authorization: `Bearer ${config.ha.token}` } };
    }
    return { upstream: target };
  }
  return null;
}

export async function serveImage(req, res) {
  const r = resolve(req.url);
  if (!r) { res.writeHead(404).end(); return; }
  const key = createHash('sha1').update(r.upstream.replace(/X-Plex-Token=[^&]+/, '')).digest('hex');
  const file = join(dir, key);
  try {
    const body = await readFile(file);
    return send(res, body);
  } catch {}
  try {
    const up = await fetch(r.upstream, { headers: r.headers, signal: AbortSignal.timeout(15000) });
    if (!up.ok) { res.writeHead(up.status === 404 ? 404 : 502).end(); return; }
    const body = Buffer.from(await up.arrayBuffer());
    // The type comes from the bytes both now and on later hits from disk, so the same image
    // never changes type between the first view and the cached one.
    send(res, body);
    await store(file, body);
  } catch (e) {
    if (!res.headersSent) res.writeHead(502).end();
  }
}

// Written under a temporary name and renamed into place, so a request arriving mid-write reads
// either nothing (and fetches for itself) or the whole file, never a truncated poster that the
// browser would then keep for a year.
async function store(file, body) {
  const tmp = `${file}.${process.pid}.${++writeSeq}.tmp`;
  try {
    await writeFile(tmp, body);
    await rename(tmp, file);
  } catch (e) {
    unlink(tmp).catch(() => {});
    return console.warn('[img] cache write failed:', e.message);
  }
  if (++writesSincePrune > 200) { writesSincePrune = 0; prune().catch(() => {}); }
}

function send(res, body) {
  res.writeHead(200, {
    'content-type': sniff(body),
    'content-length': body.length,
    // Posters, backdrops and logos are effectively permanent, and each URL carries its own
    // identifiers, so the panel's browser can keep them for a year and never re-ask.
    'cache-control': 'public, max-age=31536000, immutable',
  });
  res.end(body);
}
function sniff(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  return 'image/jpeg';
}

// Keep the cache under IMAGE_CACHE_MB by deleting the least recently written files.
async function prune() {
  const names = await readdir(dir);
  const files = await Promise.all(names.map(async (n) => {
    const s = await stat(join(dir, n)); return { n, size: s.size, t: s.mtimeMs };
  }));
  let total = files.reduce((a, f) => a + f.size, 0);
  const cap = config.imageCacheMb * 1024 * 1024;
  if (total <= cap) return;
  files.sort((a, b) => a.t - b.t);
  for (const f of files) {
    if (total <= cap * 0.9) break;
    await unlink(join(dir, f.n)).catch(() => {});
    total -= f.size;
  }
}

// Album colours: while music plays, the cinema's lights take the colours of the album cover.
// When the track changes the cover's main colours are picked out and the lights that are on fade
// to them (brightness unchanged); lights that are off stay off. It runs here, not on a panel, so
// it works however the music was started and with every screen asleep. A film starting pauses
// the music (actions.mjs), so the film's own lighting takes over from there.
//
// The cover comes from Music Assistant's image proxy, asked for a small PNG, decoded with zlib:
// no image library needed. A cover in another format is skipped.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { config, SETTINGS_FILE } from './config.mjs';

const FILE = join(dirname(SETTINGS_FILE), 'album-colours.json');
let on = false;
try { on = Boolean(JSON.parse(readFileSync(FILE, 'utf8')).on); } catch { /* off until switched on */ }

let ctx = null;
let lastPic = '';
let busy = false;
// What it last did, shown under the switch: so "nothing happened" says why.
let status = '';

export const get = () => ({ on, status });
function say(text) {
  if (text === status) return;
  status = text;
  console.log('[album colours]', text);
  ctx?.broadcast('albumColours', get());
}

export function set(value) {
  on = Boolean(value);
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify({ on }));
  } catch (err) { console.warn('[album colours] could not save the setting:', err.message); }
  ctx?.broadcast('albumColours', get());
  if (on) { lastPic = ''; status = ''; check(); }
  return get();
}

export function init(context) {
  ctx = context;
  ctx.ha.on('states', check);
}

function check() {
  if (!on || !ctx || busy) return;
  const id = config.entities.musicPlayers.find((p) => ctx.ha.states[p]?.state === 'playing');
  if (!id) { if (!lastPic) say('Waiting for music on one of the music players in the settings'); return; }
  const a = ctx.ha.states[id].attributes || {};
  const pic = a.entity_picture;
  if (!pic) { say('This track has no cover'); return; }
  if (pic === lastPic) return;
  lastPic = pic;
  busy = true;
  apply(pic, a.media_title)
    .catch((err) => say(`Couldn't read the cover: ${err.message}`))
    .finally(() => { busy = false; check(); });
}

async function apply(pic, title) {
  const url = /^https?:\/\//.test(pic) ? new URL(pic) : new URL(pic, `${config.ha.url}/`);
  // Music Assistant's proxy: a small PNG is all the colours need.
  if (/\/imageproxy\b/.test(url.pathname)) { url.searchParams.set('size', '80'); url.searchParams.set('fmt', 'png'); }
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`cover: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const img = decodePng(buf);
  if (!img) { say("This cover isn't from Music Assistant, so its colours can't be read"); return; }
  const colours = palette(img);
  if (!colours.length) { say('Black-and-white cover: the lights stay as they are'); return; }
  const lights = config.entities.lights.filter((id) => ctx.ha.states[id]?.state === 'on');
  if (!lights.length) { say('No lights are on'); return; }
  await Promise.all(lights.map((id, i) => ctx.ha.callService('light', 'turn_on',
    { rgb_color: colours[i % colours.length], transition: 2 }, { target: { entity_id: id } })));
  say(`${colours.length} colour${colours.length > 1 ? 's' : ''} from ${title ? `“${title}”` : 'the cover'} on ${lights.length} light${lights.length > 1 ? 's' : ''}`);
}

// ---------- PNG (8-bit grey, RGB or RGBA, not interlaced) ----------
export function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 6: 4 }[type];
  if (!ch || depth !== 8 || interlace || !w || !h || w * h > 4e6) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[row + x - ch] : 0;
      const b = y ? out[row - stride + x] : 0;
      const c = x >= ch && y ? out[row - stride + x - ch] : 0;
      const v = raw[src + x];
      let p;
      if (f === 0) p = v;
      else if (f === 1) p = v + a;
      else if (f === 2) p = v + b;
      else if (f === 3) p = v + ((a + b) >> 1);
      else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      out[row + x] = p & 255;
    }
  }
  return { w, h, ch, data: out };
}

// ---------- the cover's main colours ----------
// Pixels grouped by hue (12 groups), each weighted by how colourful and bright it is; the three
// strongest groups (each at least 6 % of the total) become the colours, as bright as a light can
// show them. Near-black, near-white and grey pixels don't count.
export function palette({ w, h, ch, data }) {
  if (ch < 3) return [];
  const bins = Array.from({ length: 12 }, () => ({ wt: 0, r: 0, g: 0, b: 0 }));
  let total = 0;
  for (let i = 0; i < w * h; i++) {
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max < 40) continue;
    const s = (max - min) / max;
    if (s < 0.25) continue;
    const d = max - min;
    let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hue = ((hue * 60) + 360) % 360;
    const wt = s * (max / 255);
    const bin = bins[Math.floor(hue / 30) % 12];
    bin.wt += wt; bin.r += r * wt; bin.g += g * wt; bin.b += b * wt;
    total += wt;
  }
  if (!total) return [];
  return bins.filter((x) => x.wt >= total * 0.06).sort((x, y) => y.wt - x.wt).slice(0, 3).map((x) => {
    const c = [x.r / x.wt, x.g / x.wt, x.b / x.wt];
    const k = 255 / Math.max(...c, 1);
    return c.map((v) => Math.round(Math.min(255, v * k)));
  });
}

// Tonight: one film, a time, and the evening around it. Trailers for what the house has not
// seen yet play on the projector first (its SmartTube takes a YouTube link), the film follows,
// and a long film gets its intermission at the halfway mark by itself. Scheduled for a time or
// started now; either way the plan is what the marquee outside the room shows.

import { config } from './config.mjs';
import * as plex from './media.mjs';
import * as tmdb from './tmdb.mjs';
import { runAction, script } from './actions.mjs';

let deps = { ha: null, broadcast: () => {}, onChange: () => {} };
export function init(d) { deps = { ...deps, ...d }; }

let plan = null;
let timers = [];
const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
const later = (ms, fn) => { const t = setTimeout(() => fn().catch((e) => console.warn('[tonight]', e.message)), Math.max(0, ms)); timers.push(t); };

const trailerMs = () => config.tonight.trailerSeconds * 1000;

// The plan as the panels and the marquee see it: the film, the times, and where the evening is.
export function state() {
  if (!plan) return null;
  const at = plan.at;
  const n = plan.trailers.length;
  const times = at ? {
    preshow: at - n * trailerMs() - config.tonight.preshowMinutes * 60e3,
    trailers: n ? at - n * trailerMs() : null,
    feature: at,
    intermission: plan.intermissionAt ? at + plan.intermissionAt : null,
    ends: at + (plan.item.duration || 0) + (plan.intermissionAt ? config.intermission.minutes * 60e3 : 0),
  } : null;
  return { item: plan.item, at, times, trailers: plan.trailers, intermissionAt: plan.intermissionAt, state: plan.state, createdAt: plan.createdAt, startedAt: plan.startedAt || null };
}

// Where the break goes: the middle of a film longer than the setting, or nowhere.
function intermissionPoint(duration) {
  const min = config.tonight.autoIntermissionMinutes;
  if (!min || !duration || duration < min * 60e3) return null;
  return Math.round(duration / 2);
}

// Trailers for the evening: unwatched films inside the Mystery box's rules, the feature and the
// rest of its series left out, the first few with a trailer on TMDB.
async function pickTrailers(feature, count) {
  if (!count || !config.tmdb.apiKey) return [];
  const pool = await plex.listLibrary(plex.MERGED, { filters: ['unwatched', 'recent', 'rated'], sort: 'random', size: 60 }).catch(() => ({ items: [] }));
  const out = [];
  for (const it of pool.items) {
    if (out.length >= count) break;
    if (!it.tmdb || String(it.id) === String(feature.id)) continue;
    const key = await tmdb.trailer(it.tmdb).catch(() => null);
    if (key) out.push({ id: it.id, tmdb: it.tmdb, title: it.title, year: it.year, poster: it.poster, key });
  }
  return out;
}

// Set the plan: a film, optionally a time (ms since the epoch), optionally without trailers.
export async function set({ ratingKey, at = null, trailers = config.tonight.trailers } = {}) {
  const it = await plex.item(ratingKey);
  const list = trailers ? await pickTrailers(it, config.tonight.trailerCount) : [];
  clearTimers();
  plan = {
    item: { id: it.id, type: it.type, title: it.title, year: it.year, poster: it.poster, art: it.art, duration: it.duration, summary: it.summary, contentRating: it.contentRating, genres: it.genres, tmdb: it.tmdb, quality: it.quality },
    at: at ? Number(at) : null, trailers: list, intermissionAt: intermissionPoint(it.duration), state: at ? 'scheduled' : 'ready', createdAt: Date.now(), intermissionDone: false,
  };
  if (plan.at) arm();
  announce();
  return state();
}

// The timers for a scheduled evening: lights first, then the trailers, then the film.
function arm() {
  clearTimers();
  const s = state();
  if (!s?.times) return;
  const now = Date.now();
  if (s.times.preshow > now) later(s.times.preshow - now, async () => { plan.state = 'preshow'; announce(); await runAction(deps.ha, { action: 'scene', name: 'pre_show' }); });
  later((s.times.trailers ?? s.times.feature) - now, () => start());
}

// Start the evening now: the trailers back to back on the projector, then the film.
export async function start() {
  if (!plan) throw new Error('Nothing planned for tonight');
  if (plan.state === 'trailers' || plan.state === 'feature') return state();
  clearTimers();
  plan.startedAt = Date.now();
  const projector = config.entities.projector;
  if (plan.trailers.length && projector) {
    plan.state = 'trailers'; announce();
    await wakeProjector(projector);
    plan.trailers.forEach((tr, i) => later(i * trailerMs(), async () => {
      if (plan?.state !== 'trailers') return;
      plan.showing = i; announce();
      await deps.ha.callService('androidtv', 'adb_command', { command: `am start -a android.intent.action.VIEW -d vnd.youtube:${tr.key} ${config.tonight.trailerPackage}` }, { target: { entity_id: projector } });
    }));
    later(plan.trailers.length * trailerMs(), () => feature());
  } else {
    await feature();
  }
  return state();
}

async function wakeProjector(projector) {
  const st = () => deps.ha.states[projector]?.state;
  if (!['unavailable', 'unknown', 'off', undefined].includes(st())) return;
  await script(deps.ha, 'projector_power_on', { projector, apple_tv: config.entities.appleTv }).catch(() => {});
  for (let i = 0; i < 30 && ['unavailable', 'unknown', 'off', undefined].includes(st()); i++) await new Promise((r) => setTimeout(r, 3000));
}

// The trailers are over, or were skipped: the film, without the swell (the trailers were it).
async function feature() {
  if (!plan) return;
  clearTimers();
  plan.state = 'feature'; plan.featureAt = Date.now(); announce();
  await runAction(deps.ha, { action: 'play', ratingKey: plan.item.id, type: plan.item.type, offset: 0, noPreroll: plan.trailers.length > 0 });
}

export async function skip() { if (plan?.state === 'trailers') await feature(); return state(); }

export function cancel() { clearTimers(); plan = null; announce(); return null; }

// Fed from the session poll: the break at the halfway mark, and the evening's end.
export async function observe(sessions) {
  if (!plan || plan.state !== 'feature') return;
  const mine = sessions.find((s) => String(s.id) === String(plan.item.id));
  if (mine && plan.intermissionAt && !plan.intermissionDone && mine.viewOffset >= plan.intermissionAt) {
    plan.intermissionDone = true; announce();
    await runAction(deps.ha, { action: 'scene', name: 'intermission' });
  }
  if (!mine && plan.featureAt && Date.now() - plan.featureAt > 10 * 60e3 && !plan.seen) return;   // never started, or gone
  if (mine) plan.seen = true;
  else if (plan.seen) { plan.state = 'done'; announce(); later(3600e3, async () => { if (plan?.state === 'done') cancel(); }); }
}

function announce() {
  const s = state();
  deps.broadcast('tonight', s || {});
  deps.onChange(s);
}

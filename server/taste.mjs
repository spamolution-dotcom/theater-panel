// What the house actually watches, and what to do with it: the "You'll love this" rows on the
// Watch board and the Mystery box that picks a film and starts it.
//
// Both read Plex's own history (server/plex.mjs) and, for the rows, Seerr's TMDB proxy for
// "people who watched this also watched". No Trakt account and no second service to keep signed
// in - the panel already has a Plex token and a Seerr key.

import { config } from './config.mjs';
import * as plex from './media.mjs';
import * as seerr from './seerr.mjs';

const SEED_TTL = 20 * 60e3;
const ROW_TTL = 60 * 60e3;

let seedCache = { at: 0, key: '', list: null };

// The last few distinct titles anyone finished, with the genres and TMDB id a recommendation
// needs. Only the first handful of history rows are looked up in full, so this is a couple of
// Plex calls, not a couple of hundred.
export async function seeds(n = 6) {
  const key = `${n}:${config.historyAccounts.join(',')}`;
  if (seedCache.list && seedCache.key === key && Date.now() - seedCache.at < SEED_TTL) return seedCache.list;
  const accounts = await accountIds();
  const rows = await plex.history({ size: 200, accounts });
  const list = [];
  // What the house rated highly leads: a five-star film from the "How was it?" card is a
  // better seed than whatever happened to finish last night.
  for (const it of await loved()) {
    if (list.length >= 2) break;
    const d = await plex.seedDetails(it.id).catch(() => null);
    if (d?.title) list.push({ ...d, loved: true, userRating: it.userRating });
  }
  for (const row of rows) {
    if (list.length >= n) break;
    if (list.some((s) => s.id === row.key)) continue;
    const d = await plex.seedDetails(row.key).catch(() => null);
    if (!d || !d.title) continue;
    list.push({ ...d, watchedAt: row.viewedAt });
  }
  seedCache = { at: Date.now(), key, list };
  return list;
}

// The house's own star ratings, from the movie index: loved is four stars and up (Plex counts
// in halves, so 8+), disliked two and under (4-).
const rated = () => plex.ratedMovies().catch(() => []);
const loved = async () => (await rated()).filter((it) => it.userRating >= 8).sort((a, b) => b.userRating - a.userRating);
const disliked = async () => (await rated()).filter((it) => it.userRating <= 4);

// The settings page names accounts ("Alice, Bob"); Plex wants ids. Unknown names are
// ignored rather than silently narrowing the history to nothing.
async function accountIds() {
  const want = config.historyAccounts;
  if (!want.length) return [];
  const all = await plex.accounts().catch(() => []);
  return want.map((w) => (/^\d+$/.test(w) ? Number(w) : all.find((a) => a.name.toLowerCase() === w.toLowerCase())?.id)).filter(Boolean);
}

// Rows are worth an hour when they came back full; a failure or an empty answer is worth a
// minute, so a Seerr hiccup at startup does not leave the tab empty for the rest of the hour.
let rowCache = { at: 0, rows: null, ttl: ROW_TTL };

// "You'll love this": three rows, each seeded by something recently finished. Titles already in
// Plex carry the key that plays them; the rest can be requested from the same card.
export async function rows({ count = 3, size = 12 } = {}) {
  if (rowCache.rows && Date.now() - rowCache.at < rowCache.ttl) return rowCache.rows;
  if (!config.seerr.url) return [];
  const list = (await seeds(8)).filter((s) => s.tmdbId).slice(0, count);
  const seen = new Set(list.map((s) => s.tmdbId));
  const out = [];
  for (const seed of list) {
    const type = seed.type === 'show' ? 'tv' : 'movie';
    const r = await seerr.recommendations(type, seed.tmdbId).catch((e) => { console.warn('[taste]', seed.title, e.message); return []; });
    const items = r.filter((x) => !seen.has(x.id)).slice(0, size);
    items.forEach((x) => seen.add(x.id));
    if (items.length) out.push({ seed: { id: seed.id, title: seed.title, type: seed.type, poster: seed.poster, year: seed.year, loved: Boolean(seed.loved) }, items });
  }
  rowCache = { at: Date.now(), rows: out, ttl: out.length ? ROW_TTL : 60e3 };
  return out;
}

export const forget = () => { seedCache = { at: 0, key: '', list: null }; rowCache = { at: 0, rows: null, ttl: ROW_TTL }; };

// Warm the caches at startup, like the movie index, so the first visit to For you is not eight
// round trips to Plex.
export const warm = () => seeds(8).then(() => rows()).catch((e) => console.warn('[taste] warm:', e.message));

// Studios whose films count as mainstream for the Mystery box, matched as a substring of the
// studio Plex records (the first production company, so partners like Legendary and Thunder Road
// are here beside the majors). Anything else - a Hallmark house, a festival film's producer, a
// fan compilation - is out while "mainstream only" is on; the admin page can add names.
export const MAINSTREAM_STUDIOS = [
  'disney', 'pixar', 'marvel', 'lucasfilm', '20th century', 'searchlight', 'fox',
  'warner', 'new line', 'dc studios', 'dc films', 'hbo', 'castle rock', 'village roadshow',
  'universal', 'focus features', 'dreamworks', 'illumination', 'amblin', 'working title', 'blumhouse',
  'paramount', 'nickelodeon', 'skydance', 'bad robot', 'platinum dunes',
  'columbia', 'sony', 'tristar', 'screen gems', 'ghost corps', 'original film',
  'lionsgate', 'lions gate', 'summit', 'thunder road', 'millennium', 'nu image',
  'mgm', 'metro-goldwyn', 'united artists', 'orion', 'eon productions', 'annapurna',
  'netflix', 'amazon', 'apple', 'a24', 'neon', 'legendary', 'miramax', 'dimension', 'stx', 'open road',
  'studiocanal', 'canal+', 'gaumont', 'pathé', 'pathe', 'eone', 'entertainment one', 'bbc film', 'film4',
  'plan b', 'scott free', 'syncopy', 'monkeypaw', '87north', 'atomic monster', 'temple hill', 'imagine entertainment',
  'jerry bruckheimer', 'happy madison', 'point grey', 'regency', 'chernin', 'lightstorm', 'toho', 'studio ghibli', 'laika', 'aardman',
];
const mainstream = (studio, extra) => {
  const s = (studio || '').toLowerCase();
  return Boolean(s) && [...MAINSTREAM_STUDIOS, ...extra].some((m) => s.includes(m));
};
const RATED = /^(G|PG|PG-13|R|NC-17|TV-)/i;
// Content ratings in order, TV ratings folded onto their film equivalents, for "nothing below".
const RATING_RANK = { 'TV-Y': 0, 'TV-Y7': 0, 'TV-G': 0, G: 0, 'TV-PG': 1, PG: 1, 'TV-14': 2, 'PG-13': 2, 'TV-MA': 3, R: 3, 'NC-17': 4 };
const ratedAtLeast = (contentRating, floor) => {
  const rank = RATING_RANK[(contentRating || '').toUpperCase()];
  return rank != null && rank >= RATING_RANK[floor];
};

// The Mystery box: an unwatched film inside the admin page's limits (by default the last ten
// years, rated 7 or better, carrying a rating, from a mainstream studio), weighted towards the
// genres the house has been watching, so it is a surprise but not a random one. Returns the
// pick and the reason, and plays nothing by itself - the panel counts down first so it can be
// waved off.
export async function mystery({ filters = [], exclude = [] } = {}) {
  const rules = config.mystery;
  const only = { '4k': '4k', hdr: 'hdr' }[rules.quality] || '';
  const want = ['unwatched', 'recent', 'rated', rules.family ? 'family' : '', only, ...filters].filter(Boolean);
  // The merged index answers from memory, so the whole shuffled pile is cheap to ask for; the
  // rules below then thin it, and the first few hundred that survive are as random as any.
  const [pool, list] = await Promise.all([
    plex.listLibrary(plex.MERGED, { filters: [...new Set(want)], sort: 'random', size: 5000 }),
    seeds(8).catch(() => []),
  ]);
  const skip = new Set(exclude.map(String));
  const settledBefore = Date.now() / 1000 - rules.settleDays * 86400;
  const items = pool.items.filter((i) => !skip.has(String(i.id)))
    .filter((i) => !rules.maxMinutes || !i.duration || i.duration <= rules.maxMinutes * 60000)
    .filter((i) => !(i.genres || []).some((g) => rules.excludeGenres.includes(g.toLowerCase())))
    .filter((i) => !rules.settleDays || !i.addedAt || i.addedAt < settledBefore)
    .filter((i) => !rules.excludeLibraries.includes((i.library || '').toLowerCase()))
    .filter((i) => !rules.skipDisliked || i.userRating == null || i.userRating > 4)
    .filter((i) => !rules.ratedOnly || RATED.test(i.contentRating || ''))
    .filter((i) => rules.minContentRating === 'any' || ratedAtLeast(i.contentRating, rules.minContentRating))
    .filter((i) => !rules.mainstreamOnly || mainstream(i.studio, rules.studiosExtra))
    .filter((i) => !rules.studiosExclude.some((s) => (i.studio || '').toLowerCase().includes(s)))
    .slice(0, 300);
  if (!items.length) {
    const limits = [rules.years ? `from ${plex.RECENT_FROM()} on` : '', rules.minRating ? `rated ${rules.minRating}+` : '',
      rules.maxMinutes ? `under ${rules.maxMinutes} min` : '', rules.family ? 'family-friendly' : '', only ? `in ${only.toUpperCase()}` : '',
      rules.excludeGenres.length ? `outside ${rules.excludeGenres.join(', ')}` : '', rules.excludeLibraries.length ? `not in ${rules.excludeLibraries.join(', ')}` : '',
      rules.settleDays ? `older than ${rules.settleDays} days here` : '', rules.ratedOnly ? 'with a rating' : '',
      rules.minContentRating === 'any' ? '' : `rated ${rules.minContentRating} or above`, rules.mainstreamOnly ? 'from a mainstream studio' : '',
      rules.studiosExclude.length ? `not by ${rules.studiosExclude.join(', ')}` : ''].filter(Boolean).join(', ');
    throw new Error(`Nothing unwatched${limits ? ` ${limits}` : ''} matches that`);
  }

  // Genre weights: what has been watched most recently counts most, a loved film counts double,
  // and the genres of anything rated two stars or under count against.
  const weights = new Map();
  list.forEach((s, i) => {
    for (const g of s.genres || []) weights.set(g, (weights.get(g) || 0) + (list.length - i) * (s.loved ? 2 : 1));
  });
  for (const it of await disliked()) for (const g of it.genres || []) weights.set(g, (weights.get(g) || 0) - 4);
  // A preferred picture format triples a film's odds in the roll, after the shortlist is drawn
  // on taste alone: it wins more often than not, and a 1080p film the house would love still
  // gets its turn (weighting before the cut would fill the shortlist with nothing else).
  const preferred = (it) => (rules.quality === 'prefer4k' && it.is4k) || (rules.quality === 'preferhdr' && it.quality?.hdr);
  const scored = items.map((it) => {
    const hits = (it.genres || []).filter((g) => (weights.get(g) || 0) > 0);
    const taste = (it.genres || []).reduce((sum, g) => sum + (weights.get(g) || 0), 0);
    return { it, hits, score: Math.max(1, 1 + taste + (it.rating >= 7.5 ? 4 : it.rating >= 6.5 ? 2 : 0)) };
  }).sort((a, b) => b.score - a.score).slice(0, 30);
  for (const x of scored) if (preferred(x.it)) x.score *= 3;

  const total = scored.reduce((s, x) => s + x.score, 0);
  let roll = Math.random() * total;
  const pick = scored.find((x) => (roll -= x.score) <= 0) || scored[0];

  // Why this one: whichever seed it has most in common with (ties go to the more recent), named
  // along with the genre they share.
  const overlap = (s) => (s.genres || []).filter((g) => pick.hits.includes(g));
  const from = list.map((s) => ({ s, shared: overlap(s) })).filter((x) => x.shared.length)
    .sort((a, b) => b.shared.length - a.shared.length)[0];
  const why = from ? (from.s.loved ? `More ${from.shared[0].toLowerCase()}, since you loved ${from.s.title}` : `More ${from.shared[0].toLowerCase()}, after ${from.s.title}`)
    : pick.hits.length ? `More ${pick.hits[0].toLowerCase()} for the house`
    : 'Never started, and highly rated';
  return { item: pick.it, why, pool: items.length };
}

// Ten draws in a row, each kept out of the next, so the rules can be audited from the panel's
// settings sheet without starting anything.
export async function preview({ n = 10, filters = [] } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let r;
    try { r = await mystery({ filters, exclude: out.map((x) => x.id) }); } catch { break; }
    const it = r.item;
    out.push({ id: it.id, title: it.title, year: it.year, rating: it.rating, minutes: it.duration ? Math.round(it.duration / 60000) : null,
      contentRating: it.contentRating, studio: it.studio, res: it.quality?.res, hdr: Boolean(it.quality?.hdr), genres: it.genres || [], why: r.why });
  }
  return out;
}

// ---------- habits ----------

// When the room is actually used: a year of history as a weekday-by-hour grid, plus what the
// current weekday usually looks like (its busiest hour, films versus series, the titles that
// keep coming back). Cached for an hour; the grid does not move fast.
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
let habitsCache = { at: 0, v: null };
export async function habits() {
  if (habitsCache.v && Date.now() - habitsCache.at < 3600e3) return habitsCache.v;
  const rows = await plex.history({ size: 6000, since: Date.now() - 365 * 86400e3, dedupe: false });
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const byDay = Array.from({ length: 7 }, () => ({ plays: 0, movies: 0, shows: 0, titles: new Map() }));
  for (const r of rows) {
    if (!r.viewedAt) continue;
    const d = new Date(r.viewedAt);
    grid[d.getDay()][d.getHours()] += 1;
    const day = byDay[d.getDay()];
    day.plays += 1;
    if (r.type === 'movie') day.movies += 1; else day.shows += 1;
    day.titles.set(r.title, (day.titles.get(r.title) || 0) + 1);
  }
  const days = byDay.map((d, i) => {
    const hours = grid[i];
    const peakHour = hours.indexOf(Math.max(...hours));
    // The usual start: the first evening hour that carries a fifth of the day's peak.
    const start = hours.findIndex((n, h) => h >= 16 && n >= Math.max(1, hours[peakHour] * 0.2));
    return { day: i, name: DAY_NAMES[i], plays: d.plays, movies: d.movies, shows: d.shows, peakHour: d.plays ? peakHour : null, startHour: start >= 0 ? start : null,
      titles: [...d.titles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([title, plays]) => ({ title, plays })) };
  });
  const v = { grid, days, today: days[new Date().getDay()], max: Math.max(1, ...grid.flat()), weeks: 52 };
  habitsCache = { at: Date.now(), v };
  return v;
}

// ---------- Year in review ----------

// The house's year, from Plex's history: how much was watched, by whom, what came back most
// often, and when the room is actually busy. Plays are exact; hours are an estimate - history
// records that something was watched, not for how long, so each play counts as the length of the
// film, or of a typical episode of that show.
let reviewCache = new Map();

export async function review({ year = new Date().getFullYear() } = {}) {
  const key = String(year);
  const hit = reviewCache.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.v;

  const from = new Date(year, 0, 1).getTime();
  const to = new Date(year + 1, 0, 1).getTime();
  const rows = (await plex.history({ size: 6000, since: from, dedupe: false })).filter((r) => r.viewedAt && r.viewedAt < to);
  const names = new Map((await plex.accounts().catch(() => [])).map((a) => [a.id, a.name]));
  const meta = await plex.metaBatch(rows.map((r) => r.key)).catch(() => new Map());

  // Median known length, for anything the library no longer has.
  const lengths = [...meta.values()].map((m) => m.duration).filter(Boolean).sort((a, b) => a - b);
  const median = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 45 * 60e3;
  const lengthOf = (k) => meta.get(k)?.duration || median;

  const titles = new Map();          // one row per film or series
  const people = new Map();
  const days = new Array(7).fill(0);
  const hours = new Array(24).fill(0);
  const months = new Array(12).fill(0);
  const binges = new Map();          // "key|date" -> plays, for the longest sitting
  let ms = 0;

  for (const r of rows) {
    const len = lengthOf(r.key);
    ms += len;
    const d = new Date(r.viewedAt);
    days[d.getDay()] += 1;
    hours[d.getHours()] += 1;
    months[d.getMonth()] += 1;

    const t = titles.get(r.key) || { key: r.key, title: r.title, type: r.type, plays: 0, ms: 0, poster: meta.get(r.key)?.poster || null, year: meta.get(r.key)?.year };
    t.plays += 1; t.ms += len;
    titles.set(r.key, t);

    const who = names.get(r.account) || 'Someone';
    const p = people.get(who) || { name: who, plays: 0, ms: 0, titles: new Set() };
    p.plays += 1; p.ms += len; p.titles.add(r.key);
    people.set(who, p);

    const bk = `${r.key}|${d.toDateString()}`;
    binges.set(bk, (binges.get(bk) || 0) + 1);
  }

  const [bingeKey, bingePlays] = [...binges.entries()].sort((a, b) => b[1] - a[1])[0] || ['', 0];
  const [bk, bdate] = bingeKey.split('|');
  const top = [...titles.values()].sort((a, b) => b.ms - a.ms).slice(0, 10);

  const v = {
    year,
    plays: rows.length,
    hours: Math.round(ms / 3600e3),
    movies: rows.filter((r) => r.type === 'movie').length,
    episodes: rows.filter((r) => r.type === 'show').length,
    distinct: titles.size,
    first: rows.length ? Math.min(...rows.map((r) => r.viewedAt)) : null,
    last: rows.length ? Math.max(...rows.map((r) => r.viewedAt)) : null,
    top,
    people: [...people.values()].map((p) => ({ name: p.name, plays: p.plays, hours: Math.round(p.ms / 3600e3), titles: p.titles.size }))
      .sort((a, b) => b.plays - a.plays).slice(0, 8),
    days, hours24: hours, months,
    binge: bingePlays > 2 ? { title: titles.get(bk)?.title || 'Something', plays: bingePlays, date: bdate, poster: titles.get(bk)?.poster || null } : null,
  };
  if (reviewCache.size > 8) reviewCache.clear();
  reviewCache.set(key, { at: Date.now(), v });
  return v;
}

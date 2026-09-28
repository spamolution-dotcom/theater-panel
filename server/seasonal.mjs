// The holiday shelves and the Coming soon board: things for the idle screen to show between the
// films in progress, and a shelf on the For you tab while the season lasts.
//
//   Halloween Scares      all of October
//   Christmas Movies      Thanksgiving through New Year's Eve
//   Hallmark Christmas    the same window: Hallmark Media's Christmas films, and a ribbon on every
//                         one with Lacey Chabert in it, because there are so many
//
// With a TMDB API key on the settings page, each shelf is a public TMDB list (one per season)
// cut down to the films you own, in the list's order - the honorary Christmas films added if
// the list forgot them. Without a key, or if TMDB is down:
//
// both start from Kometa's seasonal collections in Plex ("Halloween.", "Christmas.") - owned and
// playable - and keep only what belongs on the shelf. Kometa's lists are broad: its Halloween
// collection has Twilight and Fantastic Beasts in it for their vampires and wizards. So a
// Halloween Scare has to be filed as Horror, or be about Halloween itself (trick-or-treating, a
// haunting, ghosts, witches); a Christmas Movie has to mention Christmas in its title or plot.
// Kometa only builds a season's collection inside its own window, so until it does the shelf
// falls back to films you own that TMDB tags with the holiday, through the same test (TMDB's
// "christmas" tag alone leads with the Harry Potter films, for their Christmas scenes).

import { config } from './config.mjs';
import * as plex from './media.mjs';
import * as seerr from './seerr.mjs';
import * as tmdb from './tmdb.mjs';
import { thanksgiving } from './accents.mjs';

const HALLOWEEN = /hallowe'?en|trick.or.treat|haunt|ghost|witch|pumpkin|spook|jack-o|all hallows/i;
const CHRISTMAS = /christmas|santa|xmas|noel|sleigh|\belf\b|grinch|scrooge|nutcracker|reindeer|mistletoe|north pole/i;
// Christmas movies whatever anyone's database says - Die Hard's plot summary is all terrorists
// and Nakatomi Plaza. Always on the shelf when they're in the library, found by title if neither
// Kometa's collection nor TMDB's holiday tag has them.
const HONORARY_CHRISTMAS = ['Die Hard', 'Gremlins', 'Lethal Weapon', 'Iron Man 3', 'Batman Returns', 'Trading Places', 'Edward Scissorhands'];
const honorary = (it) => HONORARY_CHRISTMAS.some((t) => t.toLowerCase() === String(it.title).toLowerCase());
const SEASONS = {
  halloween: {
    title: 'Halloween Scares', kicker: 'All October, from your library',
    collection: /^halloween\.?$/i, keyword: 3335,
    keep: (it) => it.horror || (it.allGenres || it.genres || []).includes('Horror') || HALLOWEEN.test(`${it.title} ${it.summary || it.overview || ''}`),
  },
  christmas: {
    title: 'Christmas Movies', kicker: "Thanksgiving to New Year's Eve, from your library",
    collection: /^(christmas|holiday)\.?$/i, keyword: 207317,
    always: HONORARY_CHRISTMAS,
    keep: (it) => honorary(it) || CHRISTMAS.test(`${it.title} ${it.summary || it.overview || ''}`),
  },
};

// Which holiday shelf is up today, if any (the first of them; seasonsNow has the whole set).
export function seasonNow(now = new Date()) {
  const m = now.getMonth() + 1, d = now.getDate();
  if (m === 10) return 'halloween';
  if ((m === 11 && d >= thanksgiving(now.getFullYear())) || m === 12) return 'christmas';
  return null;
}
// Every shelf up today: Christmas brings the Hallmark shelf with it.
export function seasonsNow(now = new Date()) {
  const s = seasonNow(now);
  return s === 'christmas' ? ['christmas', 'hallmark'] : s ? [s] : [];
}

// Hallmark Media on TMDB, and Lacey Chabert.
const HALLMARK_STUDIO = 53015;
const CHRISTMAS_KEYWORD = 207317;
const LACEY = 22082;

// The Hallmark shelf: Hallmark Media's Christmas films that are in the library, with a ribbon
// on each one Lacey Chabert is in and a count of them in the kicker. Nothing else filters it -
// a Hallmark Christmas film is exactly what it says it is.
async function hallmarkShelf() {
  const [films, credits] = await Promise.all([
    seerr.ownedBy({ studio: HALLMARK_STUDIO, keywords: String(CHRISTMAS_KEYWORD) }),
    seerr.personMovies(LACEY).catch((e) => { console.warn('[seasonal] credits:', e.message); return []; }),
  ]);
  // TMDB files some of her Hallmark Christmas films under other production companies, or without
  // the keyword, so her owned Christmas titles join the shelf whether or not the studio search
  // found them - it's her shelf as much as Hallmark's.
  const lacey = new Set(credits.map((r) => r.id));
  // (Black Christmas is a Christmas title she is in; it is not a Hallmark film.)
  const all = [...films, ...credits.filter((r) => r.plexKey && CHRISTMAS.test(r.title) && !r.horror)];
  const seen = new Set();
  const items = [];
  for (const r of all) {
    if (seen.has(r.plexKey)) continue;
    seen.add(r.plexKey);
    items.push({ id: String(r.plexKey), type: 'movie', title: r.title, year: r.year, poster: r.poster, art: r.backdrop, rating: r.rating, watched: false, ribbon: lacey.has(r.id) ? 'Lacey Chabert' : undefined });
  }
  // Lacey's first, so the joke lands on the idle screen's eight; the rest newest first.
  items.sort((a, b) => (b.ribbon ? 1 : 0) - (a.ribbon ? 1 : 0) || (b.year || 0) - (a.year || 0));
  const hers = items.filter((i) => i.ribbon).length;
  return { id: 'hallmark', title: 'Hallmark Christmas', kicker: `${items.length} in your library · ${hers} of them with Lacey Chabert`, source: 'tmdb', total: items.length, items: items.slice(0, 40) };
}

const cache = new Map();

// The shelf for a season: { id, title, kicker, items }, or null out of season. Unwatched first,
// in an order that changes daily, so the idle screen doesn't show the same eight every time.
export async function shelf(season = seasonNow()) {
  const day = new Date().toDateString();
  const hit = cache.get(season);
  if (hit && hit.day === day && Date.now() - hit.at < 6 * 3600e3) return hit.v;
  if (season === 'hallmark') {
    const v = await hallmarkShelf();
    // An empty shelf is a Seerr that was not answering yet (the first seconds after a restart),
    // not a fact worth six hours: cache it for a minute.
    cache.set(season, { at: v.items.length ? Date.now() : Date.now() - 6 * 3600e3 + 60e3, day, v });
    return v;
  }
  const s = SEASONS[season];
  if (!s) return null;

  let items = [];
  let source = 'kometa';
  if (config.tmdb.apiKey) {
    try {
      items = await plex.byTmdb(await tmdb.listIds(config.tmdb.lists[season]));
      source = 'tmdb-list';
    } catch (e) { console.warn('[seasonal] tmdb list:', e.message); }
  }
  if (items.length < 8) {
    items = (await plex.collectionItems(s.collection).catch(() => [])).filter(s.keep);
    source = 'kometa';
  }
  if (items.length < 8) {
    const tagged = await seerr.byKeyword(s.keyword).catch(() => []);
    const owned = tagged.filter((r) => r.plexKey && s.keep(r));
    items = owned.map((r) => ({ id: String(r.plexKey), type: 'movie', title: r.title, year: r.year, poster: r.poster, art: r.backdrop, rating: r.rating, watched: false }));
    source = 'tmdb';
  }
  for (const title of s.always || []) {
    if (items.some((it) => it.title.toLowerCase() === title.toLowerCase())) continue;
    const hit = (await plex.search(title, 10).catch(() => [])).find((m) => m.type === 'movie' && m.title.toLowerCase() === title.toLowerCase());
    if (hit) items.push(hit);
  }
  const seed = [...day].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  // A list is in its maker's order, so it keeps it; the fallbacks reshuffle daily, unwatched first.
  const shuffled = source === 'tmdb-list' ? items : items.map((it, i) => ({ it, k: ((seed ^ (i * 2654435761)) >>> 0) % 100000 }))
    .sort((a, b) => (a.it.watched - b.it.watched) || (a.k - b.k)).map((x) => x.it);
  const v = { id: season, title: s.title, kicker: s.kicker, source, total: items.length, items: shuffled.slice(0, 40) };
  cache.set(season, { at: items.length ? Date.now() : Date.now() - 6 * 3600e3 + 60e3, day, v });
  return v;
}

// Coming soon: what has been asked for and isn't here yet, most imminent first - downloading now,
// then the soonest release date, then the rest.
export async function coming(limit = 8) {
  const { results } = await seerr.requests(20);
  const today = new Date().toISOString().slice(0, 10);
  const items = results.filter((r) => !['Available', 'Declined', 'Failed'].includes(r.label)).map((r) => {
    const future = r.releaseDate && r.releaseDate > today;
    let when;
    if (r.label === 'Downloading') when = r.progress != null ? `Downloading · ${r.progress}%` : 'Downloading';
    else if (future) when = `Out ${new Date(`${r.releaseDate}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    else if (r.label === 'Waiting for approval') when = 'Requested';
    else when = 'On its way';
    const rank = r.label === 'Downloading' ? 0 : future ? 1 : 2;
    return { id: r.id, title: r.title, year: r.year, poster: r.poster, art: r.backdrop, mediaType: r.mediaType, when, rank, releaseDate: r.releaseDate, progress: r.progress };
  });
  items.sort((a, b) => a.rank - b.rank || (b.progress ?? 0) - (a.progress ?? 0) || String(a.releaseDate).localeCompare(String(b.releaseDate)));
  // A title asked for twice (another season, or 1080p and 4K) is one poster, at its best status.
  const seen = new Set();
  return items.filter((i) => { const k = `${i.mediaType}:${i.title}:${i.year}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, limit);
}

// All the shelves up today (or for a season named to try one out of season), in order.
export async function shelves(season) {
  const ids = season ? (season === 'christmas' ? ['christmas', 'hallmark'] : [season]) : seasonsNow();
  const out = await Promise.all(ids.map((id) => shelf(id).catch((e) => { console.warn('[seasonal]', id, e.message); return null; })));
  return out.filter((v) => v?.items?.length);
}

// Warm today's shelves a little after startup, once Plex and Seerr are answering, so the idle
// screen's first board is not the one that finds them still empty.
export function warm() {
  setTimeout(() => shelves().catch((e) => console.warn('[seasonal] warm:', e.message)), 45e3).unref?.();
}

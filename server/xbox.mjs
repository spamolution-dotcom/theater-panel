// The Xbox on the Games screen, through Home Assistant's Xbox integration: the installed games
// and apps (its media browser), opening one, Xbox home, and starting the room for gaming (your
// Xbox Scene helper, whose automation runs the Xbox start sequence).
//
// The integration has no "recently played" list, so the panel keeps its own: a game moves to the
// front when it is opened from the panel or seen playing on the console.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config, SETTINGS_FILE } from './config.mjs';
import { extImage } from './images.mjs';
import { httpError } from './admin.mjs';

const PLAYED_FILE = join(dirname(SETTINGS_FILE), 'xbox-played.json');
const XBOX_INPUT = 'Xbox One';
let played = null;           // title id -> ms of last play
let library = null;          // { at, games, apps }

export const configured = () => Boolean(config.entities.xbox);

// The account and console entities the Games screen shows, derived from the settings so HA streams them.
export function xboxEntities() {
  const x = config.entities.xboxAccount;
  if (!configured()) return [];
  const acc = x ? [`sensor.${x}_gamerscore`, `sensor.${x}_now_playing`, `sensor.${x}_status`, `binary_sensor.${x}`, `binary_sensor.${x}_in_game`, `image.${x}_gamerpic`, `image.${x}_now_playing`] : [];
  const free = config.entities.xboxStorage;
  return [config.entities.xbox, config.entities.xboxScene, config.entities.xboxArt, free, free && free.replace('free_space', 'total_space'), ...acc].filter(Boolean);
}

async function loadPlayed() {
  if (played) return played;
  try { played = JSON.parse(await readFile(PLAYED_FILE, 'utf8')) || {}; } catch { played = {}; }
  return played;
}
async function markPlayed(id) {
  await loadPlayed();
  played[id] = Date.now();
  try { await mkdir(dirname(PLAYED_FILE), { recursive: true }); await writeFile(PLAYED_FILE, JSON.stringify(played)); }
  catch (e) { console.warn('[xbox] could not save recently played:', e.message); }
}

async function browse(ha, type, id) {
  const r = await ha.request({ type: 'media_player/browse_media', entity_id: config.entities.xbox, media_content_type: type, media_content_id: id });
  return (r?.children || []).filter((c) => c.can_play).map((c) => ({
    id: c.media_content_id, title: c.title.replace(/[™®]/g, '').replace(/\s+for Xbox One$|\s+\(Xbox One\)$/i, '').trim(),
    kind: type, thumb: c.thumbnail ? extImage(c.thumbnail) : null,
  }));
}

// Installed games (recently played first, then A-Z) and apps. Cached for 10 minutes; the console
// has to have been seen by the integration, but it does not need to be on.
export async function xboxLibrary(ha) {
  if (!configured()) return { configured: false, games: [], apps: [] };
  if (!library || Date.now() - library.at > 600e3) {
    const [games, apps] = await Promise.all([browse(ha, 'game', 'Game').catch(() => []), browse(ha, 'app', 'App').catch(() => [])]);
    if (games.length || apps.length) library = { at: Date.now(), games, apps };
    else if (!library) return { configured: true, games: [], apps: [], error: 'The Xbox did not list its games. Is Remote features on?' };
  }
  const p = await loadPlayed();
  const order = (a, b) => (p[b.id] || 0) - (p[a.id] || 0) || a.title.localeCompare(b.title);
  const tag = (g) => ({ ...g, playedAt: p[g.id] || null });
  return { configured: true, games: [...library.games].sort(order).map(tag), apps: [...library.apps].sort(order).map(tag) };
}

// A state change on the console: a library title that is now playing moves to the front.
export function observe(changed) {
  const s = changed[config.entities.xbox];
  const title = s?.attributes?.media_title;
  if (!title || !library) return;
  const hit = [...library.games, ...library.apps].find((g) => g.title.toLowerCase() === String(title).replace(/[™®]/g, '').trim().toLowerCase());
  if (hit && Date.now() - ((played || {})[hit.id] || 0) > 600e3) markPlayed(hit.id).catch(() => {});
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The panel's Xbox buttons. 'start' runs the gaming start (Xbox Scene on). 'launch' opens a game
// or app, starting the room first when Xbox mode is off (the start sequence brings the Denon up on
// the Xbox input before the console, which the Xbox needs for a picture). 'home' goes to the dashboard.
export async function xboxAction(ha, body) {
  const e = config.entities;
  if (!configured()) throw httpError(400, 'No Xbox configured');
  const sceneOn = () => !e.xboxScene || ha.states[e.xboxScene]?.state === 'on';
  const startRoom = () => e.xboxScene
    ? ha.callService('input_boolean', 'turn_on', {}, { target: { entity_id: e.xboxScene } })
    : ha.callService('media_player', 'turn_on', {}, { target: { entity_id: e.xbox } });
  if (body.cmd === 'start') { await startRoom(); return { ok: true }; }
  if (body.cmd === 'home') {
    return ha.callService('media_player', 'play_media', { media_content_type: 'app', media_content_id: 'Home' }, { target: { entity_id: e.xbox } });
  }
  if (body.cmd === 'launch') {
    const id = String(body.id || '');
    if (!/^[A-Za-z0-9]{6,20}$/.test(id)) throw httpError(400, 'Bad title id');
    const kind = body.kind === 'game' ? 'game' : 'app';
    const open = async () => {
      // The Denon may still be on the Streamer (the Xbox was started some other way).
      const avr = ha.states[e.avr];
      if (avr?.state === 'on' && avr.attributes?.source !== XBOX_INPUT) {
        await ha.callService('media_player', 'select_source', { source: XBOX_INPUT }, { target: { entity_id: e.avr } }).catch(() => {});
      }
      await ha.callService('media_player', 'play_media', { media_content_type: kind, media_content_id: id }, { target: { entity_id: e.xbox } });
      await markPlayed(id);
    };
    const up = () => ha.states[e.xbox]?.state === 'on';
    if (up() && sceneOn()) { await open(); return { ok: true }; }
    if (!sceneOn()) await startRoom();
    // Answer at once; open the title when the console is up (the start takes ~40 s).
    (async () => {
      const until = Date.now() + 150e3;
      while (!up() && Date.now() < until) await wait(2000);
      if (!up()) return console.warn('[xbox] the console did not come on in time');
      await wait(8000); // a console that has just woken ignores launches for a moment
      await open().catch((err) => console.warn('[xbox] launch:', err.message));
    })();
    return { ok: true, starting: true };
  }
  throw httpError(400, 'Unknown Xbox command');
}

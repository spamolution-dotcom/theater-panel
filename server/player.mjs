// The cinema's player: the Google TV Streamer or the NVIDIA Shield. One choice for the whole
// house (wall panel, iPad, phones), kept on disk. App tiles, Watch, Now Playing, the TV pad and
// the cinema start all follow it, through getters on config.entities: appleTv, appleTvRemote,
// streamerCast, playerInput and player follow the chosen box; roomOn and warmupScript follow
// whichever box's start is on or running (else the chosen one, for turning the cinema on).
//
// Changing the player while the cinema is on moves the room over: the new box on, the Denon to
// its input, the old box off, then the projector restarted (it misses a new signal otherwise,
// see the HA start scripts). Kids mode can't change it (server/seat.mjs).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, SETTINGS_FILE, onBuild } from './config.mjs';
import { httpError } from './admin.mjs';
import * as tidal from './tidal.mjs';

const FILE = join(dirname(SETTINGS_FILE), 'player.json');
let ctx = null;
let player = (() => { try { return JSON.parse(readFileSync(FILE, 'utf8')).player; } catch { return null; } })() || 'shield';
let moving = null;   // { to, at } while the room is being moved to the other box

const boxes = () => ({ streamer: config.entities.streamer, shield: config.entities.shield });
const current = () => (player === 'shield' && config.entities.shield ? 'shield' : 'streamer');
const states = () => ctx?.ha.states || {};
const isOn = (id) => Boolean(id) && states()[id]?.state === 'on';
const up = (id) => Boolean(id) && !['off', 'standby', 'unavailable', 'unknown', undefined].includes(states()[id]?.state);
export const NAMES = { streamer: 'Google TV Streamer', shield: 'Shield' };

function attach(c) {
  const e = c.entities;
  const box = () => e[current()] || e.streamer;
  const all = () => [e.shield, e.streamer].filter(Boolean);
  const musicList = Array.isArray(e.musicPlayers) ? [...e.musicPlayers] : [];
  const defs = {
    player: () => current(),
    players: () => (e.shield ? ['shield', 'streamer'] : ['streamer']),
    playerMoving: () => (moving ? moving.to : null),
    appleTv: () => box().tv,
    appleTvRemote: () => box().remote,
    streamerCast: () => box().cast,
    playerInput: () => box().input,
    musicPlayer: () => box().music || e.streamer.music,
    // The chosen player's music player first: the screens' Music tab starts on it.
    musicPlayers: () => {
      const m = box().music || e.streamer.music;
      const list = m ? [m, ...musicList.filter((x) => x !== m)] : [...musicList];
      // TIDAL on the Shield, while it has something on: first while it plays, else last.
      if (tidal.active()) return states()[tidal.ID]?.state === 'playing' ? [tidal.ID, ...list] : [...list, tidal.ID];
      return list;
    },
    roomOn: () => (all().find((b) => isOn(b.room)) || box()).room,
    warmupScript: () => (all().find((b) => isOn(b.script)) || box()).script,
  };
  for (const [k, get] of Object.entries(defs)) Object.defineProperty(e, k, { get, enumerable: true, configurable: true });
}
onBuild(attach);

// Either box's cinema is on (its scene switch), or a start is running.
export const roomOn = () => Object.values(boxes()).filter(Boolean).some((b) => isOn(b.room) || isOn(b.script));
export const startRunning = () => Object.values(boxes()).filter(Boolean).some((b) => isOn(b.script));
export const get = () => ({ player: current(), moving: moving ? moving.to : null });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(test, ms) {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await wait(1000);
  return test();
}
const call = (domain, service, id, data = {}) => ctx.ha.callService(domain, service, data, { target: { entity_id: id } });

// Projector off and on again, retrying while it is busy (it refuses commands for a few seconds
// after an input change, and while cooling down). Same steps as the HA start scripts.
export async function restartProjector() {
  const p = config.entities.projectorPower;
  if (!p) return;
  for (let i = 0; i < 6 && states()[p]?.state !== 'off'; i++) { await call('media_player', 'turn_off', p).catch(() => {}); await wait(5000); }
  for (let i = 0; i < 6 && states()[p]?.state !== 'on'; i++) { await call('media_player', 'turn_on', p).catch(() => {}); await until(() => states()[p]?.state === 'on', 10000); }
}

async function moveRoom(from, to) {
  const e = config.entities;
  const next = e[to], prev = e[from];
  try {
    if (!up(next.tv)) {
      await call('media_player', 'turn_on', next.tv).catch(() => {});
      await until(() => up(next.tv), 30000);
      await wait(10000);
    }
    await call('media_player', 'select_source', e.avr, { source: next.input }).catch(() => {});
    if (prev && up(prev.tv)) await call('media_player', 'turn_off', prev.tv).catch(() => {});
    await wait(20000);   // the Denon and the box agree on the sound (Atmos) before the projector restarts
    await restartProjector();
  } catch (err) {
    console.warn('[player] moving the cinema:', err.message);
  } finally {
    moving = null;
    ctx.broadcast('settings', {});
  }
}

export async function set(to) {
  if (!['shield', 'streamer'].includes(to) || !boxes()[to]) throw httpError(400, 'Unknown player');
  const from = current();
  if (to === from) return get();
  if (moving) throw httpError(409, 'Still moving the cinema to the ' + NAMES[moving.to]);
  player = to;
  try { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify({ player })); } catch (err) { console.warn('[player] not saved:', err.message); }
  // A start that's running carries on with the box it started; the next start uses the new one.
  if (roomOn() && !startRunning()) {
    moving = { to, at: Date.now() };
    moveRoom(from, to);
  }
  ctx.broadcast('settings', {});
  syncHa();
  return get();
}

// HA's copy of the choice (input_select.theater_player: Shield / Streamer): the panel writes it
// when the player changes, and a change made in HA (a dashboard, a script) changes the player.
const LABEL = { shield: 'Shield', streamer: 'Streamer' };
let written = null, writtenAt = 0;
function syncHa() {
  const id = config.entities.playerSelect;
  const st = id && states()[id];
  if (!st || st.state === LABEL[current()]) return;
  written = LABEL[current()]; writtenAt = Date.now();
  ctx.ha.callService('input_select', 'select_option', { option: written }, { target: { entity_id: id } }).catch((err) => console.warn('[player] HA helper:', err.message));
}
function fromHa() {
  const id = config.entities.playerSelect;
  const v = id && states()[id]?.state;
  if (!v || v === LABEL[current()]) { written = null; return; }
  if (written && Date.now() - writtenAt < 10000) return;   // our own write still on its way
  const to = Object.keys(LABEL).find((k) => LABEL[k] === v);
  if (to && boxes()[to]) set(to).catch((err) => console.warn('[player] from HA:', err.message));
}

export function init(context) {
  ctx = context;
  let synced = false;
  ctx.ha.on('states', () => {
    if (!synced && config.entities.playerSelect && states()[config.entities.playerSelect]) { synced = true; syncHa(); return; }
    if (synced) fromHa();
  });
  // The cinema's on/running state changes which scene switch and start script the panels watch.
  let last = '';
  ctx.ha.on('states', () => {
    const e = config.entities;
    const sig = `${e.roomOn}|${e.warmupScript}`;
    if (sig !== last) { last = sig; ctx.broadcast('settings', {}); }
  });
}

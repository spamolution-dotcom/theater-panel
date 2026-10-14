// The seat phone's kids mode. A phone kept at the cinema seats (opened with ?seat=1) is in kids
// mode whenever a seat PIN is set and nobody has unlocked it: no device power, input or blind,
// no Pre-show or Movie time, and only titles rated G or PG in Australia (C and P for children's
// TV; unrated titles stay hidden). Grown-up mode comes from the PIN on the phone, or from a
// grown-up's phone: "Ask a grown-up" fires an HA event (theater_panel_seat_ask) for an
// automation to turn into a notification, and its Unlock action turns on a helper the panel
// watches (input_boolean.theater_seat_unlock by default). Grown-up mode lasts while the phone is
// in use and ends 20 minutes after the last touch, or when someone taps the badge.
//
// The server holds the lock and checks every seat-phone action, so hiding buttons is not the
// only guard. Other phones and the wall panels are never affected.

import { timingSafeEqual } from 'node:crypto';
import { config } from './config.mjs';
import * as tmdb from './tmdb.mjs';
import { httpError } from './admin.mjs';

const UNLOCK_MS = 20 * 60e3;
const KIDS = new Set(['G', 'PG', 'C', 'P']);
let until = 0;
let timer = null;
let fails = [];
let lastAsk = 0;
let ctx = null;

const pinSet = () => /^\d{4}$/.test(String(config.seat.pin || ''));
export const locked = () => pinSet() && Date.now() >= until;
export const state = () => ({ enabled: pinSet(), locked: locked(), until: pinSet() && !locked() ? until : null });
const publish = () => ctx?.broadcast('seat', state());

function arm(ms) {
  until = Date.now() + ms;
  clearTimeout(timer);
  timer = setTimeout(() => { until = 0; publish(); }, ms);
  timer.unref?.();
  publish();
}

export function init(context) {
  ctx = context;
  ctx.ha.on('states', (changed) => {
    const id = config.entities.seatUnlock;
    if (!id || changed[id]?.state !== 'on') return;
    arm(UNLOCK_MS);
    ctx.ha.callService('input_boolean', 'turn_off', {}, { target: { entity_id: id } }).catch(() => {});
  });
}

function same(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function unlock(pin) {
  if (!pinSet()) return state();
  fails = fails.filter((t) => Date.now() - t < 60e3);
  if (fails.length >= 5) throw httpError(429, 'Too many tries. Wait a minute.');
  if (!same(pin, config.seat.pin)) { fails.push(Date.now()); throw httpError(403, 'Wrong PIN'); }
  fails = [];
  arm(UNLOCK_MS);
  return state();
}

// Someone is using the phone in grown-up mode: the 20 minutes start again.
export function touch() { if (pinSet() && !locked()) arm(UNLOCK_MS); return state(); }
export function lock() { until = 0; clearTimeout(timer); publish(); return state(); }

export async function ask() {
  if (!pinSet()) return { ok: false };
  if (Date.now() - lastAsk < 60e3) return { ok: true, again: true };
  lastAsk = Date.now();
  await ctx.ha.request({ type: 'fire_event', event_type: 'theater_panel_seat_ask', event_data: { minutes: UNLOCK_MS / 60e3 } });
  return { ok: true };
}

const kindOf = (type) => (type === 'show' || type === 'episode' ? 'show' : type === 'movie' ? 'movie' : '');
export async function kidsOk(id, type) {
  const imdb = String(id || '').split(':')[0];
  if (!config.tmdb.apiKey) return false;
  const cert = await tmdb.auRating(imdb, kindOf(type)).catch(() => undefined);
  return KIDS.has(cert);
}

// Which of these titles kids mode shows: { id: true | false }. A few at a time, so a page of
// posters doesn't fire dozens of TMDB lookups at once.
export async function ratings(list) {
  const items = (Array.isArray(list) ? list : []).slice(0, 120).filter((x) => x && typeof x.id === 'string');
  const out = {};
  for (let i = 0; i < items.length; i += 6) {
    await Promise.all(items.slice(i, i + 6).map(async (x) => { out[x.id] = await kidsOk(x.id, x.type); }));
  }
  return out;
}

// Every action from the seat phone passes through here first.
export async function guard(body) {
  if (!body?.seat || !locked()) return;
  const no = (what) => { throw httpError(403, `${what} needs grown-up mode`); };
  if (body.action === 'cinema' && ['device', 'source', 'blind'].includes(body.cmd)) no('That');
  if (body.action === 'scene' && ['pre_show', 'movie_time'].includes(body.name)) no('That scene');
  if (body.action === 'play' && !(await kidsOk(String(body.ratingKey || ''), body.type))) no('That title');
}

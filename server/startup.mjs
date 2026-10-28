// The start-up status every screen shows while the room comes up: the wall panel's warm-up screen,
// the iPad's full-screen takeover and the phone's bar. One record for the whole house, so a screen
// opened halfway through (the iPad when you walk in) shows the same steps and countdown.
//
// A start-up begins when Home Assistant runs a start script (the Shield's, the Streamer's or the
// Xbox's), however it was started (panel, Hue switch, voice), or when the panel moves the cinema to
// the other player. Its steps tick off from the devices' real states. What is being opened (a
// film, an app, a game, Pre-show) comes from the panel action that asked for it.
//
// The countdown is learned: each kind of start remembers how long its last few runs took, and the
// estimate is their median. A step that runs well past that turns the status "late", naming the
// device still being waited for.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, SETTINGS_FILE } from './config.mjs';
import * as player from './player.mjs';

const FILE = join(dirname(SETTINGS_FILE), 'startup.json');
const XBOX_INPUT = 'Xbox One';
// First guesses until real runs are learned (measured 28 Oct 2026).
const DEFAULT_MS = { 'cinema:shield': 100e3, 'cinema:streamer': 95e3, xbox: 60e3, move: 45e3 };
// After the room is up: opening what was asked for (stream list + first stream, an app, a game).
const OPEN_MS = { film: 20e3, app: 8e3, game: 25e3, preshow: 0 };
const KEEP = 5;                 // runs remembered per kind
const LATE_AFTER = 30e3;        // past the usual time by this much: late
const GIVE_UP = 6 * 60e3;       // a start-up older than this is dropped
const PICK_WAIT = 60e3;         // stream list up, nothing playing yet: finish after this anyway
const SHOW_DONE = 6e3;          // "Ready" stays up this long before the status clears
const APP_PKG = { netflix: /netflix/, prime: /amazon/, youtube: /youtube|videomanager/, stremio: /stremio/ };
const APP_NAME = { netflix: 'Netflix', prime: 'Prime Video', youtube: 'YouTube', stremio: 'Stremio' };
const FROM = { wall: 'the wall panel', ipad: 'the iPad', phone: 'a phone' };

let ctx = null;
let job = null;          // the start-up in progress (see snapshot() for what screens get)
let intent = null;       // { what, from, at }: asked for just before its start-up began
let learned = (() => { try { return JSON.parse(readFileSync(FILE, 'utf8')) || {}; } catch { return {}; } })();
let lastSent = '';

const st = () => ctx?.ha.states || {};
const state = (id) => (id ? st()[id]?.state : undefined);
const up = (id) => Boolean(id) && !['off', 'standby', 'unavailable', 'unknown', undefined].includes(state(id));
const isOn = (id) => state(id) === 'on';
const boxes = () => ['shield', 'streamer'].filter((k) => config.entities[k]);
const NAME = { shield: 'Shield', streamer: 'Streamer' };

function usual(kind) {
  const runs = learned[kind] || [];
  if (!runs.length) return DEFAULT_MS[kind] || 90e3;
  const s = [...runs].sort((a, b) => a - b);
  return Math.min(240e3, Math.max(30e3, s[Math.floor(s.length / 2)]));
}
function learn(kind, ms) {
  if (!(ms > 15e3 && ms < 300e3)) return;
  learned[kind] = [...(learned[kind] || []), Math.round(ms)].slice(-KEEP);
  try { mkdirSync(dirname(FILE), { recursive: true }); writeFileSync(FILE, JSON.stringify(learned)); } catch (err) { console.warn('[startup] not saved:', err.message); }
}

// ---------- what each kind of start-up waits for ----------

// Each step: { id, label, test(j) } in order; a step is done the first time its test passes with
// the steps before it done (so a device that was already on still ticks off in order).
function cinemaSteps(j) {
  const b = config.entities[j.box];
  const e = config.entities;
  return [
    e.projectorPower && { id: 'projector', label: 'Projector on', test: () => up(e.projectorPower) },
    { id: 'box', label: `${NAME[j.box]} on`, test: () => up(b.tv) },
    { id: 'denon', label: `Denon on · ${b.input === 'GoogleTVStreamer' ? 'Streamer' : b.input}`, test: () => up(e.avr) },
    // The start script waits ~20 s for the sound to settle, then restarts the projector.
    { id: 'settle', label: 'Settling the picture and sound', test: () => j.projOffSeen || !isOn(b.script) },
    e.projectorPower && { id: 'restart', label: 'Projector restart', test: () => !isOn(b.script) && up(e.projectorPower), start: true },
    ...openSteps(j, b),
  ].filter(Boolean);
}
function xboxSteps(j) {
  const e = config.entities;
  return [
    e.projectorPower && { id: 'projector', label: 'Projector on', test: () => up(e.projectorPower) },
    { id: 'xbox', label: 'Xbox on', test: () => up(e.xbox) },
    { id: 'denon', label: 'Denon on · Xbox', test: () => up(e.avr) && st()[e.avr]?.attributes?.source === XBOX_INPUT },
    { id: 'ready', label: 'Getting the room ready', test: () => !isOn(e.xboxScript), start: true },
    ...(j.what?.type === 'game' ? [{
      id: 'open', label: `Opening ${j.what.title || 'the game'}`,
      test: () => { const t = String(st()[e.xbox]?.attributes?.media_title || '').toLowerCase(); return (j.what.title && t.includes(j.what.title.toLowerCase())) || Date.now() - (j.doneAt.ready || Infinity) > 40e3; },
    }] : []),
  ].filter(Boolean);
}
function moveSteps(j) {
  const e = config.entities;
  const to = e[j.box], from = e[j.fromBox];
  return [
    { id: 'box', label: `${NAME[j.box]} on`, test: () => up(to.tv) },
    { id: 'denon', label: `Denon to the ${NAME[j.box]}`, test: () => st()[e.avr]?.attributes?.source === to.input },
    from && { id: 'old', label: `${NAME[j.fromBox]} off · settling`, test: () => !up(from.tv) },
    { id: 'restart', label: 'Projector restart', test: () => !player.get().moving, start: true },
    ...openSteps(j, to),
  ].filter(Boolean);
}
function openSteps(j, b) {
  const w = j.what;
  if (!w || w.type === 'preshow') return [];
  const pkg = () => String(st()[b.tv]?.attributes?.app_id || '');
  if (w.type === 'app') return [{ id: 'open', label: `Opening ${APP_NAME[w.id] || 'the app'}`, test: () => (APP_PKG[w.id] || /^$/).test(pkg()) }];
  if (w.type !== 'film') return [];
  const playing = () => state(b.cast) === 'playing';
  const autoplay = isOn(config.entities.autoplay);
  return [
    { id: 'open', label: `Opening ${w.title || 'the film'} in Stremio`, test: () => /stremio/.test(pkg()) },
    { id: 'play', label: autoplay ? 'Starting the first stream' : 'Pick a stream on the TV with the remote', test: () => playing() || Date.now() - (j.doneAt.open || Infinity) > PICK_WAIT },
  ];
}
const stepsOf = (j) => (j.kind === 'xbox' ? xboxSteps(j) : j.kind === 'move' ? moveSteps(j) : cinemaSteps(j));

// ---------- the record ----------

function begin(kind, box, startedAt, extra = {}) {
  const key = kind === 'cinema' ? `cinema:${box}` : kind;
  const fresh = intent && Date.now() - intent.at < 90e3 ? intent : null;
  intent = null;
  job = { id: `${kind}-${startedAt}`, kind, key, box, startedAt, usualMs: usual(key), doneAt: {}, projOffSeen: false, what: fresh?.what || null, from: fresh?.from || null, ...extra };
  tick();
}

// Called by the panel's actions when a start is asked for with something to open.
export function want(what, from) {
  const item = { what: clean(what), from: FROM[from] ? from : null, at: Date.now() };
  if (job && !job.finishedAt) { job.what = item.what; job.from = job.from || item.from; tick(); } else intent = item;
}
function clean(w) {
  if (!w || typeof w !== 'object') return null;
  const s = (v, n) => (v == null ? null : String(v).slice(0, n));
  const poster = typeof w.poster === 'string' && w.poster.startsWith('/') && !w.poster.startsWith('//') ? w.poster.slice(0, 400) : null;
  return { type: ['film', 'app', 'game', 'preshow'].includes(w.type) ? w.type : 'film', id: s(w.id, 20), title: s(w.title, 120), sub: s(w.sub, 80), poster };
}

// What the screens get. `etaAt` is when it should be done (null once late); `serverNow` lets a
// screen with a wrong clock count down correctly.
function snapshot() {
  if (!job) return null;
  const steps = stepsOf(job);
  return {
    id: job.id, kind: job.kind, box: job.box, from: job.from ? FROM[job.from] : null,
    what: job.what, startedAt: job.startedAt, usualMs: job.usualMs, etaAt: job.etaAt, late: job.late, waiting: job.waiting,
    done: Boolean(job.finishedAt), steps: steps.map((s) => ({ id: s.id, label: s.label, ok: Boolean(job.doneAt[s.id]), at: job.doneAt[s.id] ? job.doneAt[s.id] - job.startedAt : null })),
    current: steps.find((s) => !job.doneAt[s.id])?.id || null, serverNow: Date.now(),
  };
}
export const current = snapshot;

function send(force) {
  const snap = snapshot();
  const { serverNow, ...rest } = snap || {};
  const sig = snap ? JSON.stringify(rest) : 'null';
  if (!force && sig === lastSent) return;
  lastSent = sig;
  ctx.broadcast('startup', snap);
}

function tick() {
  if (!job) return;
  const now = Date.now();
  const steps = stepsOf(job);
  if (state(config.entities.projectorPower) === 'off' && job.doneAt.denon) job.projOffSeen = true;
  for (const s of steps) {
    if (job.doneAt[s.id]) continue;
    if (!s.test(job)) break;
    job.doneAt[s.id] = now;
    if (s.start) learn(job.key, now - job.startedAt);
  }
  // Time left: the usual start time (or what is left of it), plus opening what was asked for.
  const startStep = steps.find((s) => s.start);
  const startDone = startStep && job.doneAt[startStep.id];
  const openLeft = steps.some((s) => s.id === 'open' && !job.doneAt.open) ? OPEN_MS[job.what?.type] || 0 : 0;
  let due = startDone ? startDone + openLeft : job.startedAt + job.usualMs + openLeft;
  // Stream list up: the first stream usually starts within ~12 s.
  if (job.doneAt.open && steps.some((s) => s.id === 'play')) due = Math.max(due, job.doneAt.open + 12e3);
  job.late = !startDone ? now > job.startedAt + job.usualMs + LATE_AFTER : now > due + LATE_AFTER;
  job.etaAt = job.late ? null : due;
  job.waiting = job.late ? steps.find((s) => !job.doneAt[s.id])?.label || null : null;
  if (!job.finishedAt && steps.every((s) => job.doneAt[s.id])) job.finishedAt = now;
  send();
  if (job.finishedAt && now - job.finishedAt > SHOW_DONE) { job = null; send(); }
}

// A start-up ends early when the room is turned off part-way (All off), and is dropped when old.
function abandoned() {
  if (Date.now() - job.startedAt > GIVE_UP) return true;
  const e = config.entities;
  if (job.kind === 'cinema') return !isOn(e[job.box].room) && !isOn(e[job.box].script);
  if (job.kind === 'xbox') return e.xboxScene && !isOn(e.xboxScene) && !isOn(e.xboxScript);
  return false;
}

function watch() {
  const e = config.entities;
  if (job && !job.finishedAt && abandoned()) { job = null; send(); }
  if (!job || job.finishedAt) {
    const box = boxes().find((k) => isOn(e[k].script));
    const moving = player.get().moving;
    const started = (id) => Date.parse(st()[id]?.attributes?.last_triggered || '') || Date.now();
    const fresh = (at) => Date.now() - at < GIVE_UP;
    if (box && fresh(started(e[box].script)) && job?.id !== `cinema-${started(e[box].script)}`) begin('cinema', box, Math.min(Date.now(), started(e[box].script)));
    else if (e.xboxScript && isOn(e.xboxScript) && job?.id !== `xbox-${started(e.xboxScript)}`) begin('xbox', null, Math.min(Date.now(), started(e.xboxScript)));
    else if (moving && !job) begin('move', moving, Date.now(), { fromBox: boxes().find((k) => k !== moving) });
  }
  if (job) tick();
}

export function init(context) {
  ctx = context;
  ctx.ha.on('states', watch);
  setInterval(watch, 1000).unref();
}

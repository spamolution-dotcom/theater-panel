// The baby camera's own PIN, separate from the seat PIN and from the panel key. Set (four
// digits, CAMERA_PIN on the settings page), nobody gets the picture without entering it, however
// they reach the panel. The PIN is exchanged for a token held in the iPad page's memory; every
// camera start needs a live token, and stopping the camera revokes it, so the next start asks
// again. A reload of the page forgets it. Blank PIN: no gate. A PIN that is not four digits
// fails closed (the camera stays locked) rather than quietly leaving it open.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.mjs';
import { httpError } from './admin.mjs';

const TOKEN_MS = 12 * 3600e3;
const tokens = new Map();   // token -> expiry
let fails = [];

export const mode = () => {
  const p = String(config.camera.pin || '');
  return !p ? 'none' : /^\d{4}$/.test(p) ? 'set' : 'bad';
};

const same = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const sweep = () => { for (const [t, until] of tokens) if (until < Date.now()) tokens.delete(t); };

export function unlock(pin) {
  const m = mode();
  if (m === 'none') return { token: '' };
  if (m === 'bad') throw httpError(403, 'The camera PIN on the settings page must be four digits');
  fails = fails.filter((t) => Date.now() - t < 60e3);
  if (fails.length >= 5) throw httpError(429, 'Too many tries. Wait a minute.');
  if (!same(pin, config.camera.pin)) { fails.push(Date.now()); throw httpError(403, 'Wrong PIN'); }
  fails = [];
  sweep();
  const token = randomBytes(18).toString('hex');
  tokens.set(token, Date.now() + TOKEN_MS);
  return { token };
}

// Throws unless the camera may start for this token.
export function require(token) {
  const m = mode();
  if (m === 'none') return;
  if (m === 'bad') throw httpError(403, 'The camera PIN on the settings page must be four digits');
  sweep();
  if (!token || !tokens.has(String(token))) throw httpError(403, 'Enter the camera PIN');
}

export function lock(token) { tokens.delete(String(token || '')); return { ok: true }; }
// A changed PIN (or removing it) must not leave old unlocks working.
export function reset() { tokens.clear(); fails = []; }

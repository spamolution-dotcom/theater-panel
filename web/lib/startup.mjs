// The start-up status (server/startup.mjs) for the wall panel and the phone: the record from the
// live store, a clock that ticks while it is up, and the words both screens use.

import { useState, useEffect } from 'preact/hooks';
import { useStore } from './api.mjs';

const PLAYER = { shield: 'Shield', streamer: 'Streamer' };

// The record (null when nothing is starting) and the current time, re-rendered twice a second.
export function useStartup() {
  const job = useStore((s) => s.startup);
  const [, tick] = useState(0);
  useEffect(() => { if (!job) return undefined; const t = setInterval(() => tick((x) => x + 1), 500); return () => clearInterval(t); }, [Boolean(job)]);
  return { job, now: Date.now() + (job?.skew || 0) };
}

export const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.max(0, sec) % 60).padStart(2, '0')}`;

// Seconds left (null once late), seconds so far, the usual length, and how far along (0-100).
export function timing(job, now) {
  const so = Math.max(0, Math.round((now - job.startedAt) / 1000));
  const left = job.etaAt ? Math.max(0, Math.round((job.etaAt - now) / 1000)) : null;
  const total = job.etaAt ? Math.max(1, job.etaAt - job.startedAt) : job.usualMs;
  const pct = job.done ? 100 : Math.min(98, ((now - job.startedAt) / total) * 100);
  return { so, left, usual: Math.round(job.usualMs / 1000), pct };
}

// "Getting the cinema ready · Shield", "Moving the cinema to the Streamer", ...
export function eyebrow(job) {
  if (job.done) return 'Ready';
  if (job.late) return `Taking longer than usual${job.box ? ` · ${PLAYER[job.box]}` : ''}`;
  if (job.kind === 'move') return `Moving the cinema to the ${PLAYER[job.box]}`;
  if (job.kind === 'xbox') return 'Starting the room for gaming · Xbox';
  return `Getting the cinema ready · ${PLAYER[job.box]}`;
}

// The big title: what is being opened, else what is starting.
const APP = { netflix: 'Netflix', prime: 'Prime Video', youtube: 'YouTube', stremio: 'Stremio' };
export function heading(job) {
  const w = job.what;
  if (w?.type === 'app') return APP[w.id] || 'The cinema';
  if (w?.title) return w.title;
  return job.kind === 'xbox' ? 'Xbox' : job.kind === 'move' ? PLAYER[job.box] : 'The cinema';
}

// One line for the phone's bar: the step in progress, and what comes after.
export function stepLine(job) {
  const s = job.steps.find((x) => x.id === job.current);
  if (job.done) return 'Ready';
  if (job.late) return `Waiting for: ${job.waiting || s?.label || 'the room'}`;
  const next = job.what && job.what.type !== 'preshow' ? ` · ${heading(job)} next` : '';
  return `${s ? s.label.replace(/ the picture and sound$/, '') : 'Starting'}${next}`;
}

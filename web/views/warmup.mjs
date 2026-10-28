// Getting the cinema ready: the wall panel's (and hallway tablet's) screen while a start-up runs.
// It shows the shared start-up status (server/startup.mjs), the same record the iPad and the phones
// show: what is opening, the steps ticking off as Home Assistant reports the devices coming up, and
// a countdown learned from the last few runs. When it is done it hands over to Showtime (a film or
// an app), the Games screen (the Xbox) or Home.

import { useEffect } from 'preact/hooks';
import { html, Icon, Poster } from '../lib/ui.mjs';
import { useStore, getState } from '../lib/api.mjs';
import { useStartup, timing, clock, eyebrow, heading } from '../lib/startup.mjs';
import { go, route } from '../app.mjs';

const up = (st) => Boolean(st) && !['off', 'unavailable', 'unknown', 'standby'].includes(st.state);

export function Warmup() {
  const { job, now } = useStartup();
  const p = route.params;
  const playing = useStore((s) => s.sessions?.[0]?.state === 'playing');

  // Done (or never came): move on. A film or an app goes to Showtime, the Xbox to Games, else Home.
  const id = job?.id || null;
  const done = Boolean(job?.done);
  useEffect(() => {
    if (job && !done) return undefined;
    const where = job?.kind === 'xbox' ? 'games' : job?.what && job.what.type !== 'preshow' ? 'showtime' : 'lobby';
    // No start-up at all after a while (the cinema was already up, or it never started): Home.
    const wait = job ? (playing ? 1500 : 4000) : 20000;
    const t = setTimeout(() => { if (route.name === 'warmup') go(job ? where : (getState().sessions?.length ? 'showtime' : 'lobby'), { auto: true }); }, wait);
    return () => clearTimeout(t);
  }, [id, done, playing]);

  // Tapped Play a moment ago and the start script has not begun yet: what was tapped, "Starting".
  if (!job) {
    return html`<main class="warmup dark tx-suede">
      <div class="wu-poster">${p.poster ? html`<${Poster} src=${p.poster} title=${p.title || ''} />` : html`<div class="wu-blank"><${Icon} name="film" size=${64} /></div>`}</div>
      <div class="wu-body">
        <div class="eyebrow">Getting the cinema ready</div>
        <h1>${p.title || 'The cinema'}</h1>
        ${p.sub && html`<div class="wu-sub">${p.sub}</div>`}
        <div class="wu-big"><${Icon} name="power" size=${40} /> Starting…</div>
        <div class="wu-actions"><button type="button" class="btn ghost" onClick=${() => go('lobby')}>Back to home</button></div>
      </div>
    </main>`;
  }

  const w = job.what || {};
  const t = timing(job, now);
  const poster = w.poster || (w.title && w.title === p.title ? p.poster : '');
  const icon = w.type === 'preshow' ? 'music' : job.kind === 'xbox' ? 'pad' : w.type === 'app' ? 'app' : 'film';
  return html`<main class="warmup dark tx-suede">
    <div class="wu-poster">${poster ? html`<${Poster} src=${poster} title=${w.title || ''} />` : html`<div class="wu-blank"><${Icon} name=${icon} size=${64} /></div>`}</div>
    <div class="wu-body">
      <div class="eyebrow">${eyebrow(job)}</div>
      <h1>${heading(job)}</h1>
      ${(w.sub || job.from) && html`<div class="wu-sub">${[w.sub, job.from && `Started from ${job.from}`].filter(Boolean).join(' · ')}</div>`}

      ${job.done
        ? html`<div class="wu-big"><${Icon} name="check" size=${44} /> Ready</div>`
        : job.late
          ? html`<div class="wu-count"><span class="n late">${clock(t.so)}</span><span class="l">so far · usually ${clock(t.usual)}</span></div>
            <div class="wu-big warn">Still waiting for: ${job.waiting || 'the room'}. If it stays stuck, check the Media Control Switch plug, or tap All off and start again.</div>`
          : html`<div class="wu-count"><span class="n">${clock(t.left)}</span><span class="l">${t.left > 0 ? 'to go, roughly' : 'any moment now'}</span></div>
            <div class="bar"><i style=${`width:${t.pct}%`}></i></div>`}

      <ul class="wu-list" style=${`grid-template-rows:repeat(${Math.ceil(job.steps.length / 2)},auto)`}>${job.steps.map((s, i) => html`<li key=${s.id} class=${s.ok ? 'ok' : s.id === job.current ? (job.late ? 'late' : 'now') : ''}>
        <span class="ic">${s.ok ? '✓' : s.id === job.current ? '' : i + 1}</span>${s.label}
        <span class="t">${s.ok ? clock(Math.round(s.at / 1000)) : s.id === 'settle' && s.id === job.current ? '~20 s' : ''}</span></li>`)}</ul>

      <div class="wu-actions">
        ${job.done && job.what?.type === 'film' && html`<button type="button" class="btn primary" onClick=${() => go('showtime')}>Now playing</button>`}
        ${!job.what && job.kind !== 'xbox' && html`<button type="button" class="btn primary" onClick=${() => go('watch')}>Browse while you wait</button>`}
        <button type="button" class="btn ghost" onClick=${() => go('lobby')}>Back to home</button>
      </div>
    </div>
  </main>`;
}

// Whether Play should show this screen: a start-up is under way, or the room (or the player) is
// off so Play will start it.
export function needsWarmup() {
  const s = getState();
  const e = s.entities || {};
  if (s.startup && !s.startup.done) return true;
  if (s.states[e.warmupScript]?.state === 'on') return true;
  const room = e.roomOn ? s.states[e.roomOn]?.state : 'on';
  return room !== 'on' || !up(s.states[e.appleTv]);
}

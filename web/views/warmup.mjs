// Getting the cinema ready: after Play from a cold room, the movie scene takes about two minutes
// (plug, Denon, projector, Streamer, then the title opens in Stremio). This screen shows what the
// film is, a live checklist of the devices as Home Assistant reports them coming up, and a
// countdown, then tells people to pick a stream on the TV and moves on to Showtime.

import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Poster } from '../lib/ui.mjs';
import { useStore, getState } from '../lib/api.mjs';
import { go, route } from '../app.mjs';

// Your theatre sequence: 1:45 wait, Denon, 5 s, projector, 10 s, Streamer, then the panel's 5 s
// before it sends the title.
export const WARMUP_SECONDS = 130;
const GIVE_UP_SECONDS = 210;   // the HA script's own timeout
const STREMIO_APP = 'com.stremio.one';

const up = (st) => Boolean(st) && !['off', 'unavailable', 'unknown', 'standby'].includes(st.state);

export function Warmup() {
  const e = useStore((s) => s.entities) || {};
  const states = useStore((s) => s.states);
  const p = route.params;
  const startedAt = Number(p.at) || Date.now();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, []);

  const tv = states[e.appleTv];
  const inStremio = tv?.attributes?.app_id === STREMIO_APP;
  const steps = [
    { name: 'Cinema power', ok: up(states[e.plug]) || up(states[e.avr]) },
    { name: 'Denon', ok: up(states[e.avr]) },
    { name: 'Projector', ok: up(states[e.projectorPower]) },
    { name: 'Streamer', ok: up(tv) },
    { name: 'Stremio', ok: inStremio },
  ].filter((s, i) => i !== 2 || e.projectorPower);

  const elapsed = Math.floor((now - startedAt) / 1000);
  const left = Math.max(0, WARMUP_SECONDS - elapsed);
  const ready = inStremio;
  const stuck = !ready && elapsed > GIVE_UP_SECONDS;
  const late = steps.filter((s) => !s.ok).map((s) => s.name);

  // Ready: give people a moment to read "pick a stream", then hand over to Showtime.
  useEffect(() => {
    if (!ready) return undefined;
    const t = setTimeout(() => { if (route.name === 'warmup') go('showtime', { auto: true }); }, 20000);
    return () => clearTimeout(t);
  }, [ready]);

  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, '0');
  const pct = Math.min(100, (elapsed / WARMUP_SECONDS) * 100);

  return html`<main class="warmup dark tx-suede">
    <div class="wu-poster">${p.poster ? html`<${Poster} src=${p.poster} title=${p.title || ''} />` : html`<div class="wu-blank"><${Icon} name="film" size=${64} /></div>`}</div>
    <div class="wu-body">
      <div class="eyebrow">${ready ? 'Ready' : stuck ? 'Taking longer than usual' : 'Getting the cinema ready'}</div>
      <h1>${p.title || 'Your film'}</h1>
      ${p.sub && html`<div class="wu-sub">${p.sub}</div>`}

      ${ready
        ? html`<div class="wu-big"><${Icon} name="remote" size=${44} /> Pick a stream on the TV with the remote</div>`
        : stuck
          ? html`<div class="wu-big warn">Still waiting for ${late.join(', ')}. Check the Media Control Switch plug, or turn the movie scene off and on again.</div>`
          : html`<div class="wu-count"><span class="n">${mm}:${ss}</span><span class="l">${left > 0 ? 'to go, roughly' : 'any moment now'}</span></div>
            <div class="bar"><i style=${`width:${pct}%`}></i></div>`}

      <ul class="wu-steps">
        ${steps.map((s) => html`<li class=${s.ok ? 'ok' : ''}><span class="tick">${s.ok ? '✓' : '…'}</span>${s.name}</li>`)}
      </ul>

      <div class="wu-actions">
        ${ready && html`<button type="button" class="btn primary" onClick=${() => go('showtime')}>Now playing</button>`}
        <button type="button" class="btn ghost" onClick=${() => go('lobby')}>Back to home</button>
      </div>
    </div>
  </main>`;
}

// Whether Play should show this screen: the room was off (or the Streamer was) when it was pressed.
export function needsWarmup() {
  const s = getState();
  const e = s.entities || {};
  const room = e.roomOn ? s.states[e.roomOn]?.state : 'on';
  return room !== 'on' || !up(s.states[e.appleTv]);
}

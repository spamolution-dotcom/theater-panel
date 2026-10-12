// Games, for an Xbox (Home Assistant's Xbox integration). Off: one big Play Xbox (the gaming start
// in HA), the last game to jump back into, and every installed game. On: what is playing with its
// artwork and achievements, Xbox home and All off, the games to switch to, and the Denon's input.

import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Header, H2 } from '../lib/ui.mjs';
import { get, act, useLoad, useStore, useEntity, toast } from '../lib/api.mjs';
import { soundFormat } from '../lib/sound.mjs';
import { XBOX_INPUT } from '../lib/gaming.mjs';

const ART = ['#2f6b3b,#122a17', '#3b4f7a,#151d33', '#7a3b2f,#2a120e', '#6b5b2f,#2a2210', '#4f2f6b,#1d1029', '#2f6b6b,#0f2929', '#7a2f4f,#2a0f1b', '#5b5b5b,#1e1e1e'];
const tint = (id) => ART[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % ART.length];
const live = (st) => Boolean(st) && !['unknown', 'unavailable', '', null, undefined].includes(st.state);
const haImg = (id, st) => (st?.attributes?.entity_picture ? `/api/ha-image?e=${encodeURIComponent(id)}&v=${encodeURIComponent(st.attributes.entity_picture)}&s=${encodeURIComponent(st.state || '')}` : null);

function ago(ms) {
  if (!ms) return '';
  const d = new Date(ms); const now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  if (days <= 0) return 'Played today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function Tile({ g, on, onPick }) {
  return html`<button type="button" class="xb-tile" aria-pressed=${on ? 'true' : 'false'} onClick=${() => onPick(g)} aria-label=${`Open ${g.title}`}>
    <div class="sq" style=${`background:linear-gradient(160deg,${tint(g.id)})`}>
      ${g.thumb ? html`<img src=${g.thumb} alt="" loading="lazy" decoding="async" onError=${(e) => { e.currentTarget.style.display = 'none'; }} />` : html`<span>${g.title}</span>`}
    </div>
    <span class="n ellipsis">${g.title}</span><span class="d">${g.kind === 'app' ? 'App' : ago(g.playedAt) || 'Game'}</span>
  </button>`;
}

function OffChip({ big }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return undefined; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);
  return html`<button type="button" class=${big ? `btn big ghost ${armed ? 'warn' : ''}` : `chip ${armed ? 'warn' : ''}`} onClick=${() => { if (!armed) { setArmed(true); return; } setArmed(false); act({ action: 'scene', name: 'all_off' }); toast('Turning everything off'); }}>
    <${Icon} name="power" size=${big ? 26 : 20} />${armed ? 'Tap again to turn off' : 'All off'}</button>`;
}

function Me({ e, dark }) {
  const x = e.xboxAccount;
  const pic = useEntity(x && `image.${x}_gamerpic`);
  const score = useEntity(x && `sensor.${x}_gamerscore`);
  const online = useEntity(x && `binary_sensor.${x}`);
  const status = useEntity(x && `sensor.${x}_status`);
  const tag = online?.attributes?.display_name || 'Xbox';
  const src = haImg(`image.${x}_gamerpic`, pic);
  return html`<div class=${`xb-me ${dark ? '' : 'xb-light'}`}>
    ${src ? html`<img class="pic" src=${src} alt="" />` : html`<div class="pic">${tag.slice(0, 2).toUpperCase()}</div>`}
    <div class="grow" style="min-width:0"><b class="ellipsis">${tag}</b><span class="ellipsis">${online?.state === 'on' ? 'Online' : live(status) ? status.state : 'Offline'}</span></div>
    ${live(score) && html`<div class="score"><b>${score.state}</b><span>Gamerscore</span></div>`}
  </div>`;
}

function Storage({ e }) {
  const free = useEntity(e.xboxStorage);
  const total = useEntity(e.xboxStorage && e.xboxStorage.replace('free_space', 'total_space'));
  const f = Number(free?.state); const t = Number(total?.state);
  if (!Number.isFinite(f)) return null;
  const used = Number.isFinite(t) && t > 0 ? Math.min(100, Math.max(0, (1 - f / t) * 100)) : null;
  return html`<div class="xb-store"><${Icon} name="server" size=${20} />Storage
    ${used != null && html`<div class="bar"><i style=${`width:${used}%`}></i></div>`}
    <span>${Math.round(f)} GB free${Number.isFinite(t) ? ` of ${Math.round(t)}` : ''}</span></div>`;
}

export function Xbox() {
  const e = useStore((s) => s.entities) || {};
  const box = useEntity(e.xbox);
  const scene = useEntity(e.xboxScene);
  const avr = useEntity(e.avr);
  const now = useEntity(e.xboxAccount && `sensor.${e.xboxAccount}_now_playing`);
  const art = useEntity(e.xboxArt);
  const [lib, err] = useLoad(() => get('/api/xbox/library'), []);
  const [busy, setBusy] = useState(null);
  const on = box?.state === 'on';
  const starting = !on && (scene?.state === 'on' || busy === 'start');
  const games = lib?.games || [];
  const apps = lib?.apps || [];
  const last = games.find((g) => g.playedAt);

  const playing = live(now) ? now.state : (on && box?.attributes?.media_title && box.attributes.media_title !== 'Home' ? box.attributes.media_title : null);
  const norm = (t) => String(t || '').replace(/[™®]/g, '').trim().toLowerCase();
  const current = playing && [...games, ...apps].find((g) => norm(g.title) === norm(playing) || norm(playing).startsWith(norm(g.title)));

  async function start() { setBusy('start'); if (await act({ action: 'xbox', cmd: 'start' })) toast('Starting the room for gaming'); setTimeout(() => setBusy(null), 60000); }
  async function pick(g) {
    const r = await act({ action: 'xbox', cmd: 'launch', id: g.id, kind: g.kind });
    if (r) toast(r.starting ? `Starting the room · ${g.title} opens when the Xbox is up` : `Opening ${g.title}`);
    if (r?.starting) setBusy('start');
  }
  const home = async () => { if (await act({ action: 'xbox', cmd: 'home' })) toast('Xbox home'); };

  const status = on ? 'Xbox on' : starting ? 'Starting…' : 'Off';
  const statusLine = !on && !starting && e.xboxAccount ? html`<${StatusText} id=${`sensor.${e.xboxAccount}_status`} />` : null;
  const fmt = soundFormat(avr?.attributes?.sound_mode_raw);
  const genres = now?.attributes?.genres; const dev = now?.attributes?.developer;
  const progress = parseFloat(String(now?.attributes?.progress ?? ""));
  const ach = now?.attributes?.achievements;
  const artSrc = playing ? haImg(e.xboxArt, art) : null;

  return html`<main class="view">
    <${Header} title="Games" kicker="Xbox">
      <span class="chip info"><span class=${`dot ${on || starting ? 'on' : ''}`}></span>${status}${statusLine && html` · ${statusLine}`}</span>
      ${(on || starting) && html`<${OffChip} />`}
    <//>
    ${on ? html`<div class="xb-body xb-on">
      <section class="dark xb-hero row">
        <div class="art">${artSrc && html`<img src=${artSrc} alt="" onError=${(ev) => { ev.currentTarget.style.display = 'none'; }} />`}</div>
        <div class="grow" style="display:flex;flex-direction:column;gap:14px;min-width:0">
          <div class="eyebrow">${playing ? 'Now playing on Xbox' : 'Xbox is on'}</div>
          <div class="xb-title ellipsis">${playing || 'Xbox home'}</div>
          <div class="xb-sub">${playing ? [Array.isArray(genres) ? genres.join(', ') : genres, dev].filter(Boolean).join(' · ') : 'Pick a game below, or use the controller'}</div>
          ${Number.isFinite(progress) && html`<div class="xb-ach"><span>Achievements</span><div class="bar"><i style=${`width:${Math.min(100, progress)}%`}></i></div><span>${ach != null ? `${ach} · ` : ''}${Math.round(progress)} %</span></div>`}
        </div>
        <div class="xb-actions">
          <button type="button" class="btn big gold" onClick=${home}><${Icon} name="pad" size=${26} />Xbox home</button>
          <${OffChip} big=${true} />
        </div>
      </section>
      <section class="card xb-lib">
        <${H2} title="Your games"><span class="aside">${games.length ? 'Recently played first · tap to open' : ''}</span><//>
        ${err ? html`<div class="empty">${err.message}</div>` : html`<div class="xb-strip">${[...games, ...apps].map((g) => html`<${Tile} key=${g.id} g=${g} on=${current?.id === g.id} onPick=${pick} />`)}</div>`}
      </section>
      <div class="xb-foot">
        <section class="card"><${Me} e=${e} /></section>
        <section class="card xb-mid"><${Storage} e=${e} /></section>
        <section class="card xb-mid xb-avr"><${Icon} name="receiver" size=${28} color="var(--acc)" />
          <div class="grow" style="min-width:0"><b>Denon · ${avr?.state === 'on' ? (avr.attributes?.source || '') : 'off'}</b>
            <div class="muted">${avr?.state === 'on' ? [fmt?.label, avr.attributes?.volume_level != null ? `volume ${Math.round(avr.attributes.volume_level * 100)}` : ''].filter(Boolean).join(' · ') : 'Starts with Play Xbox'}</div></div>
          ${avr?.state === 'on' && avr.attributes?.source !== XBOX_INPUT && html`<button type="button" class="chip" onClick=${() => act({ action: 'cinema', cmd: 'source', source: XBOX_INPUT })}>To Xbox</button>`}
        </section>
      </div>
    </div>` : html`<div class="xb-body xb-off">
      <section class="dark tx-suede xb-hero">
        <div class="xb-start">
          <button type="button" class=${`power ${starting ? 'on' : ''}`} disabled=${starting} onClick=${start} aria-label="Play Xbox">
            <${Icon} name="pad" size=${64} color=${starting ? '#F4F0E8' : 'var(--acc)'} w=${1.8} /></button>
          <div><div class="eyebrow">${starting ? 'Starting the room' : 'Xbox is off'}</div><div class="xb-big">${starting ? 'Starting…' : 'Play Xbox'}</div>
            <div class="xb-sub" style="margin-top:10px">${starting ? 'Denon, projector, then the Xbox · about 40 seconds' : 'Starts the room for gaming · about 40 seconds'}</div></div>
        </div>
        ${last && html`<div class="xb-me xb-last">
          <div class="sq" style=${`background:linear-gradient(160deg,${tint(last.id)})`}>${last.thumb && html`<img src=${last.thumb} alt="" />`}</div>
          <div class="grow" style="min-width:0"><div class="eyebrow">Jump back in</div><b class="xb-lt ellipsis">${last.title}</b><span>${ago(last.playedAt)}</span></div>
          <button type="button" class="btn big gold" onClick=${() => pick(last)}><${Icon} name="pad" size=${26} />Play</button></div>`}
        <div><div class="label" style="color:#C7B39E;margin-bottom:10px">What Play Xbox does</div>
          <div class="xb-steps"><span>Lights</span><span>Blind 20 % by day</span><span>Denon on · Xbox input</span><span>Projector on</span><span>Xbox on</span></div></div>
        <${Me} e=${e} dark=${true} />
      </section>
      <div class="xb-col">
        <section class="card xb-lib scroll">
          <${H2} title="Your games"><span class="aside">${games.length ? `${games.length} installed` : ''}</span><//>
          ${err ? html`<div class="empty">${err.message}</div>` : !lib ? html`<div class="empty">Loading…</div>` : lib.error ? html`<div class="empty">${lib.error}</div>`
            : html`<div class="xb-grid">${games.map((g) => html`<${Tile} key=${g.id} g=${g} onPick=${pick} />`)}</div>
              <div class="muted" style="font-size:15px;margin-top:14px">Tap a game: the room starts and the game opens.</div>`}
        </section>
        <section class="card" style="padding:16px 26px"><${Storage} e=${e} /></section>
      </div>
    </div>`}
  </main>`;
}

function StatusText({ id }) {
  const st = useEntity(id);
  return live(st) ? html`<span>${st.state}</span>` : null;
}

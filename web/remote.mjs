// The cinema remote for a phone (/remote): the wall panel's controls and its Watch screen at phone
// width. Home has what's playing, Continue, Just added, the scenes, the devices and the blind; Watch
// browses and searches Stremio and plays a title in the cinema (starting it first if it's off).
// Same server, same actions as the wall panel; only the layout is new. Home network only (it
// relies on the panel's trusted networks, like the wall tablet does).

import { gamingOn, XBOX_INPUT } from './lib/gaming.mjs';
import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Play, Pause, Prev, Next, Poster } from './lib/ui.mjs';
import { get, post, act, getState, useLoad, useStore, useEntity, startLive, toast, livePosition, playbackState, runtime, mmss } from './lib/api.mjs';
import { soundFormat } from './lib/sound.mjs';
import { usePicked } from './lib/picked.mjs';
import { streamerNow } from './lib/streamer.mjs';

// Kids mode and the seat behaviours (dark theme, follow the room) belong to the iPad's /lite page
// only. The phone remote used to become a "seat phone" once opened with ?seat=1 and remembered it,
// which left phones stuck in kids mode; it no longer does, and forgets any phone it marked.
try { localStorage.removeItem('theaterSeat'); } catch { /* storage blocked: nothing to forget */ }
const seat = false;
const SEAT_IDLE_MS = 3 * 60e3; // untouched this long: back to the tab that fits what's on
const SEAT_SWITCH_MS = 60e3;   // a change (Xbox on, a film playing) moves the page if untouched this long

const SCENES = [
  { name: 'pre_show', label: 'Pre-show', desc: 'Warm lights · music', icon: 'music' },
  { name: 'movie_time', label: 'Movie time', desc: 'Lights down', icon: 'film' },
  { name: 'intermission', label: 'Intermission', desc: 'Pause · lights 30%', icon: 'cup' },
  { name: 'lights_up', label: 'Lights up', desc: 'Lights 100%', icon: 'sun' },
];
const SCENE_OF = { 'Pre-show': 'pre_show', 'Movie time': 'movie_time', Intermission: 'intermission', 'Lights up': 'lights_up' };
const APPS = [
  { id: 'netflix', name: 'Netflix' },
  { id: 'prime', name: 'Prime Video' },
  { id: 'youtube', name: 'YouTube' },
  { id: 'stremio', name: 'Stremio' },
];
const FILTERS = [
  { key: 'unwatched', label: 'Unwatched' },
  { key: 'short', label: 'Under 2h', movieOnly: true },
  { key: 'family', label: 'Family' },
];
const SORTS = [
  { value: 'added', label: 'Recently added' },
  { value: 'released', label: 'Newest' },
  { value: 'rating', label: 'Top rated' },
  { value: 'random', label: 'Random' },
];
const PAGE = 36;
const MAX_ITEMS = 360;

const isUp = (st) => Boolean(st) && !['off', 'unavailable', 'unknown', 'standby'].includes(st.state);
const useRoomOn = () => useStore((s) => s.states[s.entities?.roomOn]?.state === 'on');
const useGaming = () => useStore((s) => gamingOn(s.states, s.entities));
const nameOf = (m) => m.showTitle || m.title;

// Short tab names under Movies | TV Shows, as on the wall panel.
function shortTab(l) {
  if (l.source === 'library') return l.type === 'show' ? 'My shows' : 'My movies';
  const t = String(l.title || '').replace(/\s*·\s*(films|series)$/i, '').replace(/\s+(films|series|movies|shows|tv)$/i, '').trim();
  return t || l.title;
}
const kindOf = (l) => (l?.type === 'show' ? 'show' : 'movie');

// A tap that turns something off needs a second tap within 4 s, like on the wall panel.
function useArmed() {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return undefined; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);
  return [armed, setArmed];
}

// Play in the cinema. A cold room starts first (about a minute); the server handles the order.
async function playItem(item, roomOn, resume = true) {
  const r = await act({ action: 'play', ratingKey: item.id, type: item.type, title: nameOf(item), offset: resume ? item.viewOffset : 0 });
  if (!r) return false;
  toast(!roomOn ? `Starting the cinema · ${nameOf(item)} opens in about a minute`
    : r.preroll ? `Lights down… ${nameOf(item)} in ${r.preroll}s` : `Opening ${nameOf(item)} on the TV · pick a stream with the remote`);
  return true;
}
async function openApp(app) {
  const r = await act({ action: 'app', id: app.id });
  if (r?.warming) toast(`Starting the cinema · ${app.name} opens once it's up`);
  else if (r) toast(`Opening ${app.name} on the TV`);
}

// ---------- Home ----------

function Top({ title, kicker, children }) {
  return html`<header class="r-top"><div><div class="r-kick">${kicker}</div><h1>${title}</h1></div>
    <div class="r-topr">${seat && html`<${SeatBadge} />`}${children}</div></header>`;
}

// ---------- kids mode (the seat phone only; server/seat.mjs) ----------

// Kids mode: this is the seat phone, a grown-up PIN is set, and nobody has unlocked it.
const useKids = () => useStore((s) => Boolean(seat && s.seat?.enabled && s.seat?.locked));

// Which titles kids mode shows, asked of the server (TMDB's Australian rating: G and PG) and
// remembered for the session. A list shows all at once when its ratings are in (Watch keeps the
// previous posters up meanwhile, so there is no blank). Returns [list, checking]: the list is
// unchanged outside kids mode, null until its ratings are known.
const kidsOk = {};
const kidsAsked = new Set();
const kidsHeard = new Set();   // every list waiting on ratings hears when an answer comes back
function useKidsFilter(items) {
  const kids = useKids();
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((x) => x + 1); kidsHeard.add(f); return () => kidsHeard.delete(f); }, []);
  const need = kids && items ? items.filter((m) => m?.id && !(m.id in kidsOk)) : [];
  const key = need.map((m) => m.id).join(',');
  useEffect(() => {
    if (!key) return undefined;
    const ask = need.filter((m) => !kidsAsked.has(m.id));
    if (!ask.length) return undefined;
    ask.forEach((m) => kidsAsked.add(m.id));
    post('/api/ratings', { items: ask.map((m) => ({ id: m.id, type: m.type })) })
      .then((r) => Object.assign(kidsOk, r.ok || {}))
      .catch(() => ask.forEach((m) => { kidsOk[m.id] = false; }))
      .finally(() => { ask.forEach((m) => kidsAsked.delete(m.id)); kidsHeard.forEach((f) => f()); });
    return undefined;
  }, [key]);
  if (!kids || !items) return [items, false];
  if (need.length) return [null, true];
  return [items.filter((m) => kidsOk[m.id]), false];
}

// The lock in the corner. Kids: a tap opens the PIN pad (the PIN still guards grown-up mode).
// Grown-up: the minutes left; a tap goes back to kids mode.
function SeatBadge() {
  const st = useStore((s) => s.seat);
  const [pad, setPad] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30e3); return () => clearInterval(t); }, []);
  if (!st?.enabled) return null;
  if (!st.locked) {
    const mins = Math.max(1, Math.ceil(((st.until || 0) - Date.now()) / 60e3));
    return html`<button type="button" class="r-lock open" aria-label="Grown-up mode, tap to go back to kids mode"
      onClick=${() => post('/api/seat/lock', {}).then(() => toast('Back to kids mode')).catch(() => {})}><${Icon} name="unlock" size=${14} w=${2.4} />${mins}m</button>`;
  }
  return html`<button type="button" class="r-lock" aria-label="Kids mode, tap to unlock" onClick=${() => setPad(true)}><${Icon} name="lock" size=${14} w=${2.4} />Kids</button>
    ${pad && html`<${PinPad} onClose=${() => setPad(false)} />`}`;
}

function PinPad({ onClose }) {
  const [pin, setPin] = useState('');
  const [bad, setBad] = useState(false);
  const press = (d) => {
    if (pin.length >= 4) return;
    const next = pin + d;
    setPin(next); setBad(false);
    if (next.length === 4) {
      post('/api/seat/unlock', { pin: next })
        .then(() => { toast('Grown-up mode · 20 minutes'); onClose(); })
        .catch((e) => { setBad(true); setPin(''); toast(e.message, true); });
    }
  };
  const ask = () => post('/api/seat/ask', {}).then((r) => { toast(r.again ? 'Already asked · check your phones' : 'Asked · a grown-up\'s phone will buzz'); onClose(); }).catch((e) => toast(e.message, true));
  return html`<div class="r-sheet-back" onClick=${(ev) => { if (ev.target === ev.currentTarget) onClose(); }}>
    <div class="r-sheet r-pin" role="dialog" aria-label="Grown-up PIN">
      <div class="r-grab"></div>
      <h3>Grown-up mode</h3><p>Enter the PIN · unlocks for 20 minutes</p>
      <div class=${`r-dots${bad ? ' bad' : ''}`}>${[0, 1, 2, 3].map((i) => html`<i class=${i < pin.length ? 'f' : ''}></i>`)}</div>
      <div class="r-pinkeys">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => html`<button type="button" onClick=${() => press(String(n))}>${n}</button>`)}
        <button type="button" class="x" onClick=${onClose}>Cancel</button>
        <button type="button" onClick=${() => press('0')}>0</button>
        <button type="button" class="x" aria-label="Delete" onClick=${() => setPin(pin.slice(0, -1))}>⌫</button>
      </div>
      <button type="button" class="r-ask" onClick=${ask}>Ask a grown-up</button>
    </div>
  </div>`;
}

// The player switch: which box the cinema plays on (server/player.mjs). Shown when both boxes exist.
const PLAYER_NAMES = { shield: 'Shield', streamer: 'Google TV Streamer' };
const PLAYER_SHORT = { shield: 'Shield', streamer: 'Streamer' };
const PLAYER_WHY = { shield: 'Lossless Dolby Atmos (TrueHD) for Stremio films', streamer: 'Google TV home screen · Assistant' };
const playerIcon = (p) => (p === 'shield' ? 'shield' : 'cast');
const usePlayers = () => useStore((s) => (s.entities?.players || []).filter((p) => s.entities[p] && s.states[s.entities[p].tv]).join(',')).split(',').filter(Boolean);

function PlayerChip() {
  const players = usePlayers();
  const e = useStore((s) => s.entities) || {};
  const roomOn = useRoomOn();
  const kids = useKids();
  const [open, setOpen] = useState(false);
  if (players.length < 2) return null;
  const pick = (to) => {
    setOpen(false);
    if (to === e.player) return;
    act({ action: 'player', to }).then((r) => { if (r) toast(roomOn ? `Moving the cinema to the ${PLAYER_NAMES[to]} · the projector restarts` : `Playing on the ${PLAYER_NAMES[to]}`); });
  };
  const label = e.playerMoving ? `Moving to ${PLAYER_SHORT[e.playerMoving]}…` : PLAYER_SHORT[e.player] || e.player;
  return html`<button type="button" class=${`r-chip pl${kids ? ' ro' : ''}`} disabled=${kids} aria-label=${`Player: ${PLAYER_NAMES[e.player]}`}
      onClick=${() => !kids && setOpen(true)}><${Play} size=${12} />${label}${!kids && html`<${Icon} name="down" size=${14} />`}</button>
    ${open && html`<div class="r-sheet-back" onClick=${(ev) => { if (ev.target === ev.currentTarget) setOpen(false); }}>
      <div class="r-sheet" role="dialog" aria-label="Play on">
        <div class="r-grab"></div>
        <h3>Play on</h3><p class="r-plot" style="margin-top:4px">Apps, films and the remote use this box</p>
        <div class="r-plopts">${players.map((p) => html`<button type="button" class="r-scn" key=${p} aria-pressed=${p === e.player ? 'true' : 'false'} onClick=${() => pick(p)}>
          <${Icon} name=${playerIcon(p)} size=${22} /><span><b>${PLAYER_NAMES[p]}</b><s>${PLAYER_WHY[p]}</s></span>${p === e.player && html`<i>✓</i>`}</button>`)}</div>
        ${roomOn && html`<p class="r-plnote">Cinema is on: switching moves the Denon to the other box and restarts the projector (about 30 s of black screen).</p>`}
      </div></div>`}`;
}

function StatusChip() {
  const roomOn = useRoomOn();
  const gaming = useGaming();
  const warming = useStore((s) => s.states[s.entities?.warmupScript]?.state === 'on');
  const cls = warming ? 'warm' : roomOn || gaming ? 'on' : '';
  return html`<${PlayerChip} /><span class=${`r-chip ${cls}`}><span class="dot"></span>${warming ? 'Starting…' : roomOn ? 'Cinema on' : gaming ? 'Xbox on' : 'Cinema off'}</span>`;
}

// What the Streamer is showing: a Stremio session first; otherwise what Cast reports (YouTube,
// Spotify...), else the TV itself. `active` = a film or show is playing or paused (not the home
// screen or a stream list), which is when the Remote tab leads with Now playing.
function useMedia() {
  const e = useStore((s) => s.entities) || {};
  const roomOn = useRoomOn();
  const tv = useEntity(e.appleTv);
  const castSt = useEntity(e.streamerCast);
  const session = useStore((s) => (s.ui?.theaterSessions ? s.sessions?.[0] : undefined));
  const now = streamerNow(tv, castSt);
  const state = useStore((s) => (session ? playbackState(s) : now.state || playbackState(s)));
  const shown = roomOn && Boolean(session || isUp(tv));
  const active = shown && ['playing', 'paused'].includes(state) && (Boolean(session) || !now.home);
  return { e, tv, session, now, state, shown, active };
}

function NowPlaying({ onTab, inRemote }) {
  const { e, tv, session, now, state, shown } = useMedia();
  const avr = useEntity(e.avr);
  const sessionsAt = useStore((s) => s.sessionsAt) || Date.now();
  const playing = state === 'playing';
  const [, tick] = useState(0);
  useEffect(() => { if (!playing) return undefined; const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, [playing]);
  if (!shown) return null;

  const a = tv?.attributes || {};
  const app = session?.app || now.key;
  const title = session?.showTitle || session?.title || now.title || a.media_title || now.name;
  const sub = session?.showTitle ? `S${session.season} · E${session.episode} ${session.title}` : now.title ? [now.artist, now.name].filter(Boolean).join(' · ') : '';
  const dur = session?.duration ? session.duration / 1000 : now.cast?.attributes?.media_duration || a.media_duration || null;
  let pos = null;
  if (session?.viewOffset != null) pos = session.viewOffset / 1000 + (playing ? (Date.now() - sessionsAt) / 1000 : 0);
  else pos = livePosition(now.cast || tv);
  const left = dur && pos != null && dur - pos > 1 ? dur - pos : null;
  const fmt = soundFormat(avr?.attributes?.sound_mode_raw);
  const label = playing ? 'Now playing' : state === 'paused' ? 'Paused' : state === 'choosing' ? 'Pick a stream on the TV' : now.home ? 'Nothing playing' : 'On the TV';
  const vol = avr?.attributes?.volume_level;
  const muted = Boolean(avr?.attributes?.is_volume_muted);
  const t = (cmd, extra) => act({ action: 'transport', cmd, ...extra });

  return html`<section class="r-np">
    <div class="r-np-art">${session?.poster ? html`<img src=${session.poster} alt="" />` : app ? html`<img class="app" src=${`/assets/apps/${app}.png`} alt="" />` : html`<${Icon} name="tv" size=${30} color="#C7B39E" />`}</div>
    <div class="r-np-body">
      <div class="r-kick light">${label}${playing && fmt ? html`<span class=${`r-fmt ${fmt.kind}`}>${fmt.label}</span>` : null}</div>
      <div class="r-np-title">${title}</div>
      <div class="r-np-sub">${[sub, left != null ? `${runtime(left * 1000) || mmss(left)} left` : ''].filter(Boolean).join(' · ')}</div>
      ${dur && pos != null && html`<div class="r-bar"><i style=${`width:${Math.min(100, (pos / dur) * 100)}%`}></i></div>`}
      <div class="r-ctl">
        <button type="button" aria-label="Back 10 seconds" onClick=${() => t('seek_rel', { seconds: -10 })}>−10</button>
        <button type="button" class="pp" aria-label=${playing ? 'Pause' : 'Play'} onClick=${() => t('play_pause')}>${playing ? html`<${Pause} size=${22} />` : html`<${Play} size=${22} />`}</button>
        <button type="button" aria-label="Forward 30 seconds" onClick=${() => t('seek_rel', { seconds: 30 })}>+30</button>
        ${!inRemote && html`<button type="button" class="pad" aria-label="TV remote" onClick=${() => onTab('remote')}><${Icon} name="remote" size=${20} /></button>`}
      </div>
      ${isUp(avr) && html`<div class="r-vol">
        <span class="k">${muted ? 'Muted' : `Vol ${vol == null ? '–' : Math.round(vol * 200) / 2}`}</span>
        <div class="r-bar thin"><i style=${`width:${vol != null ? Math.min(100, vol * 100) : 0}%`}></i></div>
        <button type="button" aria-label="Volume down" onClick=${() => t('vol_down')}>−</button>
        <button type="button" aria-label="Volume up" onClick=${() => t('vol_up')}>+</button>
      </div>`}
    </div>
  </section>`;
}

// The apps on the Streamer. Kids mode on the seat phone keeps Netflix only (its profiles have
// PINs); the server refuses the others too (server/seat.mjs).
function Apps() {
  const kids = useKids();
  const list = kids ? APPS.filter((a) => a.id === 'netflix') : APPS;
  return html`<div class="r-h2"><h2>Apps</h2></div>
    <div class="r-apps">${list.map((a) => html`<button type="button" key=${a.id} onClick=${() => openApp(a)} aria-label=${`Open ${a.name}`}><img src=${`/assets/apps/${a.id}.png`} alt="" /></button>`)}</div>`;
}

function Shelf({ title, link, items, onOpen, empty }) {
  return html`<section>
    <div class="r-h2"><h2>${title}</h2>${link}</div>
    ${!items ? html`<div class="r-empty">Loading…</div>`
      : !items.length ? html`<div class="r-empty">${empty}</div>`
      : html`<div class="r-shelf">${items.map((m) => {
        const pct = m.duration && m.viewOffset ? Math.min(100, Math.round((m.viewOffset / m.duration) * 100)) : 0;
        return html`<button type="button" class="r-poster" key=${m.id} onClick=${() => onOpen(m)} aria-label=${nameOf(m)}>
          <${Poster} src=${m.poster} title=${nameOf(m)}>
            ${m.rating ? html`<span class="rating">★ ${Number(m.rating).toFixed(1)}</span>` : null}
            ${pct > 0 && html`<span class="prog"><i style=${`width:${pct}%`}></i></span>`}
          <//>
          <span class="t">${nameOf(m)}</span>
          <span class="y">${m.type === 'episode' && m.season ? `S${m.season} · E${m.episode}` : m.year || ''}</span>
        </button>`;
      })}</div>`}
  </section>`;
}

// The sleep timer (server/sleep.mjs): the cinema turns itself off when the film ends, or after
// 30, 60 or 90 minutes. The server keeps it, so it holds whatever this page does.
const SLEEP_OPTS = [
  { mode: 'end', label: 'After this', desc: 'When the film ends' },
  { mode: 'timer', minutes: 30, label: '30 min' },
  { mode: 'timer', minutes: 60, label: '60 min' },
  { mode: 'timer', minutes: 90, label: '90 min' },
];
const sleepText = (sl) => (!sl ? 'Set a timer' : sl.mode === 'end' ? 'Off after this' : `Off in ${Math.max(1, Math.ceil(((sl.at || 0) - Date.now()) / 60e3))} min`);
function SleepButton() {
  const sl = useStore((s) => s.sleep);
  const [open, setOpen] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { if (!sl) return undefined; const t = setInterval(() => tick((x) => x + 1), 20e3); return () => clearInterval(t); }, [Boolean(sl)]);
  const pick = (opt) => {
    setOpen(false);
    post('/api/sleep', opt).then((r) => toast(r.mode ? (r.mode === 'end' ? 'The cinema turns off when the film ends' : `The cinema turns off in ${r.minutes} minutes`) : 'Sleep timer off'))
      .catch((e) => toast(e.message, true));
  };
  return html`<button type="button" class=${`r-sleep${sl ? ' on' : ''}`} aria-pressed=${sl ? 'true' : 'false'} onClick=${() => setOpen(true)}><${Icon} name="moon" size=${18} /><span><b>Sleep</b><s>${sleepText(sl)}</s></span></button>
    ${open && html`<div class="r-sheet-back" onClick=${(ev) => { if (ev.target === ev.currentTarget) setOpen(false); }}>
      <div class="r-sheet" role="dialog" aria-label="Sleep timer">
        <div class="r-grab"></div>
        <h3>Sleep timer</h3><p class="r-plot" style="margin-top:4px">Turn the cinema off</p>
        <div class="r-scn-grid">${SLEEP_OPTS.map((o) => html`<button type="button" class="r-scn" key=${o.label}
          aria-pressed=${sl && sl.mode === o.mode && (o.mode === 'end' || sl.minutes === o.minutes) ? 'true' : 'false'} onClick=${() => pick({ mode: o.mode, minutes: o.minutes })}>
          <span><b>${o.label}</b>${o.desc && html`<s>${o.desc}</s>`}</span></button>`)}</div>
        ${sl && html`<button type="button" class="r-play2" onClick=${() => pick({ mode: 'off' })}>Cancel the timer</button>`}
      </div></div>`}`;
}

function Scenes() {
  const kids = useKids();
  const roomOn = useRoomOn();
  const gaming = useGaming();
  const tracked = useEntity('input_select.theater_scene')?.state;
  const [active, pick] = usePicked(roomOn ? SCENE_OF[tracked] : undefined);
  const [armed, setArmed] = useArmed();
  const allOff = () => {
    if (!armed) { setArmed(true); return; }
    setArmed(false); act({ action: 'scene', name: 'all_off' }); toast('Turning the cinema off');
  };
  return html`<section>
    <div class="r-h2"><h2>Scenes</h2></div>
    <div class="r-scn-grid">${SCENES.filter((sc) => !kids || !['pre_show', 'movie_time'].includes(sc.name)).map((sc) => html`<button type="button" class="r-scn" key=${sc.name} aria-pressed=${sc.name === active ? 'true' : 'false'}
      onClick=${() => { pick(sc.name); act({ action: 'scene', name: sc.name }); }}><${Icon} name=${sc.icon} size=${22} /><span><b>${sc.label}</b><s>${sc.desc}</s></span></button>`)}</div>
    ${(roomOn || gaming) && html`<button type="button" class=${`r-alloff ${armed ? 'armed' : ''}`} onClick=${allOff}><${Icon} name="power" size=${20} />${armed ? 'Tap again to turn everything off' : 'All off'}</button>`}
  </section>`;
}

function DevButton({ d }) {
  const [armed, setArmed] = useArmed();
  const tap = () => {
    if (d.ok && !armed) { setArmed(true); return; }
    setArmed(false);
    act({ action: 'cinema', cmd: 'device', dev: d.id, on: !d.ok });
    toast(`${d.name} ${d.ok ? 'off' : 'on'}`);
  };
  return html`<button type="button" class=${`r-dev ${d.ok ? 'ok' : ''} ${armed ? 'armed' : ''}`} aria-pressed=${d.ok ? 'true' : 'false'} onClick=${tap}
    aria-label=${`${d.name}: ${d.ok ? 'on, tap to turn off' : 'off, tap to turn on'}`}>
    <${Icon} name=${d.icon} size=${24} /><b>${d.name}</b><span>${armed ? 'Tap again' : d.note}</span></button>`;
}

function Devices() {
  const e = useStore((s) => s.entities) || {};
  const avr = useEntity(e.avr);
  const proj = useEntity(e.projectorPower);
  const tv = useEntity(e.appleTv);
  const vol = Math.round((avr?.attributes?.volume_level || 0) * 100);
  const cast = useEntity(e.streamerCast);
  const devices = [
    { id: 'projector', name: 'Projector', icon: 'projector', ok: isUp(proj), note: isUp(proj) ? 'On' : 'Off' },
    { id: 'denon', name: 'Denon', icon: 'receiver', ok: isUp(avr), note: isUp(avr) ? `On · ${vol}` : 'Off' },
    { id: 'chromecast', name: PLAYER_SHORT[e.player] || 'Streamer', icon: playerIcon(e.player), ok: isUp(tv), note: streamerNow(tv, cast).name },
  ];
  return html`<section>
    <div class="r-h2"><h2>Devices</h2></div>
    <div class="r-devs">${devices.map((d) => html`<${DevButton} d=${d} key=${d.id} />`)}</div>
    ${isUp(avr) && html`<${Source} avr=${avr} />`}
  </section>`;
}

// The Denon's input (only while it is on): a player (which switches the player too) or the Xbox.
function Source({ avr }) {
  const e = useStore((st) => st.entities) || {};
  const players = usePlayers();
  const SOURCES = (players.length ? players : ['streamer']).filter((p) => e[p]).map((p) => [e[p].input, PLAYER_SHORT[p], playerIcon(p)]).concat([[XBOX_INPUT, 'Xbox', 'pad']]);
  const [want, setWant] = useState(null);
  const src = avr?.attributes?.source;
  useEffect(() => { setWant(null); }, [src]);
  const cur = want || src;
  return html`<div class="r-h2"><h2>Source</h2><span class="r-aside">Denon input</span></div>
    <div class="r-seg">${SOURCES.map(([id, name, icon]) => html`<button type="button" key=${id} aria-pressed=${cur === id ? 'true' : 'false'}
      onClick=${() => { if (cur === id) return; setWant(id); act({ action: 'cinema', cmd: 'source', source: id }); }}><${Icon} name=${icon} size=${18} />${name}</button>`)}</div>`;
}

function Blind() {
  const id = useStore((s) => s.entities?.blind);
  const st = useEntity(id);
  if (!id || !st) return null;
  const pos = st.attributes?.current_position ?? (st.state === 'open' ? 100 : 0);
  const gone = ['unavailable', 'unknown'].includes(st.state);
  const moving = ['opening', 'closing'].includes(st.state);
  const label = gone ? 'Unavailable' : moving ? `${st.state === 'opening' ? 'Opening' : 'Closing'}…` : pos <= 0 ? 'Closed' : pos >= 100 ? 'Open' : `${pos}% open`;
  const to = (data) => act({ action: 'cinema', cmd: 'blind', ...data });
  return html`<section>
    <div class="r-h2"><h2>Blind</h2><span class="r-aside">${label}</span></div>
    <div class="r-seg">
      <button type="button" aria-pressed=${pos >= 100 ? 'true' : 'false'} disabled=${gone} onClick=${() => to({ to: 'open' })}><${Icon} name="blindOpen" size=${18} />Open</button>
      <button type="button" aria-pressed=${pos === 20 ? 'true' : 'false'} disabled=${gone} onClick=${() => to({ position: 20 })}><${Icon} name="blindMovie" size=${18} />Movie</button>
      <button type="button" aria-pressed=${pos <= 0 ? 'true' : 'false'} disabled=${gone} onClick=${() => to({ to: 'close' })}><${Icon} name="blindClose" size=${18} />Close</button>
    </div>
  </section>`;
}

function Home({ onOpen, onTab }) {
  const [deck] = useLoad(() => get('/api/plex/ondeck?size=12'), []);
  const [recent] = useLoad(() => get('/api/plex/recent?size=24'), []);
  const seen = new Set();
  const [added] = useKidsFilter(recent && recent.filter((m) => { const k = m.showTitle || m.id; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 14));
  const [deckShown] = useKidsFilter(deck);
  const kids = useKids();
  const d = new Date();
  const part = d.getHours() < 12 ? 'morning' : d.getHours() < 17 ? 'afternoon' : 'evening';
  return html`<div class="r-page">
    <${Top} title="Home Theater" kicker=${`${d.toLocaleDateString('en-AU', { weekday: 'long' })} ${part}`}><${StatusChip} /><//>
    <${NowPlaying} onTab=${onTab} />
    <${Apps} />
    <${Shelf} title="Continue" items=${deckShown} onOpen=${onOpen} empty=${kids ? 'Nothing for kids mode here.' : 'Nothing in progress.'} />
    <${Shelf} title="Just added" items=${added} onOpen=${onOpen} empty="Nothing new."
      link=${html`<button type="button" class="r-link" onClick=${() => onTab('watch')}>Browse</button>`} />
    <${Scenes} />
    ${!kids && html`<${Devices} />`}
    ${!kids && html`<${Blind} />`}
  </div>`;
}

// ---------- Watch ----------

function Watch({ onOpen }) {
  const [libs] = useLoad(() => get('/api/plex/libraries'), []);
  const [lib, setLib] = useState(null);
  const [kind, setKind] = useState('movie');
  const [filters, setFilters] = useState(['unwatched']);
  const [sort, setSort] = useState('added');
  const [seed, setSeed] = useState(0);
  const [query, setQuery] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(query.trim()), 350); return () => clearTimeout(t); }, [query]);
  const [items, setItems] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const sentinel = useRef();
  const listGen = useRef(0);   // goes up each time the list starts over (filter, tab, search)

  const kindLibs = (libs || []).filter((l) => kindOf(l) === kind && !['foryou', 'networks'].includes(l.id));
  const open = kindLibs.find((l) => l.id === lib) || kindLibs[0];
  const libId = open?.id;
  const libType = open?.type;
  const isCatalog = open?.source === 'catalog';
  const sorts = isCatalog ? [{ value: 'added', label: 'Catalogue order' }, { value: 'random', label: 'Random' }] : SORTS;
  const sortNow = isCatalog && sort !== 'random' ? 'catalog' : sort;
  const shown = FILTERS.filter((f) => !(f.movieOnly && libType !== 'movie'));
  const activeFilters = filters.filter((f) => shown.some((x) => x.key === f)).join(',');

  useEffect(() => {
    if (!libId && !q) return undefined;
    let live = true;
    setItems(null); setCursor(null); listGen.current += 1;
    const req = q ? get(`/api/plex/search?q=${encodeURIComponent(q)}`).then((r) => ({ items: r, total: r.length }))
      : get(`/api/plex/library/${libId}?filters=${activeFilters}&sort=${sortNow}&size=${PAGE}`);
    req.then((r) => { if (!live) return; setItems(r.items); setTotal(r.total); setCursor(r.next != null ? { next: r.next, more: r.more } : null); window.scrollTo(0, 0); })
      .catch((e) => { if (live) { setItems([]); toast(e.message, true); } });
    return () => { live = false; };
  }, [libId, activeFilters, sortNow, q, seed]);

  const hasMore = !q && items && items.length < MAX_ITEMS && (cursor ? cursor.more : items.length < total);
  async function more() {
    if (busy || !hasMore) return;
    setBusy(true);
    try {
      const r = await get(`/api/plex/library/${libId}?filters=${activeFilters}&sort=${sortNow}&size=${PAGE}&start=${cursor ? cursor.next : items.length}`);
      setItems((prev) => [...(prev || []), ...r.items]);
      if (r.next != null) { setCursor({ next: r.next, more: r.more }); setTotal(items.length + r.items.length + (r.more ? PAGE : 0)); }
    } catch {} finally { setBusy(false); }
  }
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return undefined;
    const io = new IntersectionObserver((es) => { if (es[0].isIntersecting) more(); }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  });

  const kids = useKids();
  const [visible] = useKidsFilter(items);
  // While a new filter, tab or search loads, the previous posters stay up (dimmed) instead of the
  // grid emptying to "Loading…" and refilling, which flickered on slower phones.
  // (A next page being added to the same list keeps them up undimmed.)
  const lastShown = useRef({ list: null, gen: 0 });
  if (visible) lastShown.current = { list: visible, gen: listGen.current };
  const grid = visible ?? lastShown.current.list;
  const stale = visible === null && grid !== null && lastShown.current.gen !== listGen.current;
  const toggle = (k) => setFilters(filters.includes(k) ? filters.filter((f) => f !== k) : [...filters, k]);
  const kicker = q ? `Stremio search · ${total} results` : `${kind === 'show' ? 'TV Shows' : 'Movies'}${open ? ` · ${shortTab(open)}` : ''}`;

  return html`<div class="r-page">
    <${Top} title="Watch" kicker=${kicker}>
      ${!q && html`<label class="r-sort"><span class="sr">Sort</span>
        <select value=${isCatalog && sort !== 'random' ? 'added' : sort} onChange=${(ev) => { setSort(ev.target.value); if (ev.target.value === 'random') setSeed(seed + 1); }}>
          ${sorts.map((s) => html`<option value=${s.value}>${s.label}</option>`)}
        </select><${Icon} name="down" size=${16} w=${2.4} /></label>`}
    <//>
    <label class="r-search"><${Icon} name="search" size=${20} color="var(--muted)" /><span class="sr">Search Stremio</span>
      <input type="search" placeholder="Search movies and TV shows" value=${query} onInput=${(ev) => setQuery(ev.target.value)} />
      ${query && html`<button type="button" aria-label="Clear search" onClick=${() => setQuery('')}><${Icon} name="x" size=${18} /></button>`}
    </label>
    ${!q && html`
      ${kids && html`<div class="r-kidsnote">Kids mode · G and PG only</div>`}
      <div class="r-seg kind">${[['movie', 'Movies'], ['show', 'TV Shows']].map(([k, label]) => html`<button type="button" aria-pressed=${kind === k ? 'true' : 'false'} onClick=${() => { if (k !== kind) { setKind(k); setLib(null); } }}>${label}</button>`)}</div>
      <div class="r-pills">${kindLibs.map((l) => html`<button type="button" class="r-pill tab" key=${l.id} aria-pressed=${l.id === libId ? 'true' : 'false'} onClick=${() => setLib(l.id)}>${shortTab(l)}</button>`)}</div>
      <div class="r-pills">${shown.map((f) => html`<button type="button" class="r-pill" key=${f.key} aria-pressed=${filters.includes(f.key) ? 'true' : 'false'} onClick=${() => toggle(f.key)}>
        ${filters.includes(f.key) && html`<${Icon} name="check" size=${15} w=${2.6} />`}${f.label}</button>`)}</div>`}
    <div class=${`r-grid${stale ? ' stale' : ''}`} aria-busy=${stale ? 'true' : 'false'}>
      ${grid === null ? html`<div class="r-empty wide">Loading…</div>`
        : !grid.length ? html`<div class="r-empty wide">${kids && items?.length ? (hasMore ? 'Looking for G and PG titles…' : 'Nothing rated G or PG here. Try another tab or a search.') : q ? 'Nothing found.' : 'Nothing matches. Try removing a filter.'}</div>`
        : grid.map((m) => {
          const name = m.type === 'episode' ? m.showTitle : m.title;
          return html`<button type="button" class="r-poster" key=${m.id} onClick=${() => onOpen(m)} aria-label=${name}>
            <${Poster} src=${m.poster} title=${name}>${m.rating ? html`<span class="rating">★ ${Number(m.rating).toFixed(1)}</span>` : null}<//>
            <span class="t">${name}</span><span class="y">${m.year || ''}</span>
          </button>`;
        })}
    </div>
    ${hasMore && html`<div class="r-empty" ref=${sentinel}>${busy ? 'Loading more…' : ''}</div>`}
    ${!q && html`<${Apps} />`}
  </div>`;
}

// ---------- the title sheet ----------

function TitleSheet({ start, onClose }) {
  const roomOn = useRoomOn();
  const id = start.type === 'show' && start.showKey ? start.showKey : start.id;
  const [it, err] = useLoad(() => get(`/api/plex/item/${encodeURIComponent(id)}`), [id]);
  const [season, setSeason] = useState(null);
  const [eps] = useLoad(() => (season ? get(`/api/plex/episodes/${encodeURIComponent(season)}`) : Promise.resolve(null)), [season]);
  useEffect(() => { document.body.classList.add('locked'); return () => document.body.classList.remove('locked'); }, []);
  const go = async (item, resume) => { if (await playItem(item, roomOn, resume)) onClose(true); };

  const m = it || start;
  const isShow = m.type === 'show' || m.type === 'season';
  const target = isShow ? it?.next : it;
  const heading = m.type === 'episode' ? m.showTitle : m.title;
  const meta = m.type === 'episode' ? [`S${m.season} · E${m.episode}`, m.title, runtime(m.duration)] : [m.year, runtime(m.duration), m.contentRating];
  return html`<div class="r-sheet-back" onClick=${() => onClose()}>
    <div class="r-sheet" role="dialog" aria-label=${heading} onClick=${(ev) => ev.stopPropagation()}>
      <div class="r-grab"></div>
      <button type="button" class="r-close" aria-label="Close" onClick=${() => onClose()}><${Icon} name="x" size=${20} /></button>
      <div class="r-dt">
        <div class="r-dt-poster"><${Poster} src=${m.poster} title=${heading} /></div>
        <div style="min-width:0">
          <h3>${heading}</h3>
          <div class="r-meta">${meta.filter(Boolean).join(' · ')}</div>
          ${m.rating ? html`<div class="r-meta">★ ${Number(m.rating).toFixed(1)} IMDb</div>` : null}
          ${m.genres?.length ? html`<div class="r-meta">${m.genres.slice(0, 3).join(' · ')}</div>` : null}
        </div>
      </div>
      ${err ? html`<div class="r-empty">${err.message}</div>` : !it ? html`<div class="r-empty">Loading…</div>` : html`
        ${it.summary && html`<p class="r-plot">${it.summary}</p>`}
        ${isShow && it.next && html`<div class="r-next">Up next: S${it.next.season} · E${it.next.episode} ${it.next.title}</div>`}
        ${target ? html`<button type="button" class="r-play" onClick=${() => go(target, true)}><${Play} size=${20} />${target.viewOffset ? 'Resume in the cinema' : 'Play in the cinema'}</button>`
          : html`<button type="button" class="r-play" disabled>Nothing to play</button>`}
        ${target && target.viewOffset > 0 && html`<button type="button" class="r-play2" onClick=${() => go(target, false)}>Start over</button>`}
        ${!roomOn && target && html`<div class="r-note">The cinema is off · it starts first (about a minute)</div>`}
        ${isShow && it.seasons?.length && html`
          <div class="r-h2"><h2>Episodes</h2></div>
          <div class="r-pills">${it.seasons.map((s) => html`<button type="button" class="r-pill" key=${s.id} aria-pressed=${season === s.id ? 'true' : 'false'} onClick=${() => setSeason(season === s.id ? null : s.id)}>${s.title}</button>`)}</div>
          ${season && !eps && html`<div class="r-empty">Loading…</div>`}
          ${eps && html`<div class="r-eps">${eps.map((e) => html`<button type="button" class="r-ep" key=${e.id} onClick=${() => go(e, true)}>
            <span class="n">${e.episode}</span><span class="tt"><b>${e.title}</b><s>${[runtime(e.duration), e.viewOffset ? 'in progress' : ''].filter(Boolean).join(' · ')}</s></span><${Play} size=${16} color="var(--acc)" /></button>`)}</div>`}`}
      `}
    </div>
  </div>`;
}

// ---------- the TV remote ----------

function TvRemote({ onTab }) {
  const { e, tv, session, now, active } = useMedia();
  const avr = useEntity(e.avr);
  const roomOn = useRoomOn();
  const appName = now.name;
  const key = (k) => act({ action: 'tv_key', key: k });
  const t = (cmd) => act({ action: 'transport', cmd });
  const vol = avr?.attributes?.volume_level;
  const muted = Boolean(avr?.attributes?.is_volume_muted);
  // While a film or show plays: Now playing first (pause and volume are what people reach for),
  // then the pad (menus, Next episode), then what it is and who's in it.
  return html`<div class="r-page">
    <${Top} title=${active ? 'Now playing' : 'TV Remote'} kicker=${`${active ? `${appName} · ` : ''}${PLAYER_NAMES[e.player] || 'Google TV Streamer'}${active ? '' : ` · ${appName}`}`}><${StatusChip} /><//>
    ${!isUp(tv) && html`<div class="r-note" style="margin:0 0 6px">The Streamer is off. ${roomOn ? 'Turn it on under Devices on Home.' : 'Start the cinema first.'}</div>`}
    ${active && html`<${NowPlaying} onTab=${onTab} inRemote />`}
    ${active && session && /^tt\d+:\d+:\d+$/.test(session.id || '') && html`<${EpisodeNav} id=${session.id} key=${session.id} />`}
    ${active && !session && now.key === 'youtube' && html`<${VideoNav} />`}
    <div class=${`r-pad${active ? ' sm' : ''}`}>
      <button type="button" class="up" aria-label="Up" onClick=${() => key('up')}><${Icon} name="chev" size=${30} w=${2.6} /></button>
      <button type="button" class="left" aria-label="Left" onClick=${() => key('left')}><${Icon} name="left" size=${30} w=${2.6} /></button>
      <button type="button" class="ok" aria-label="OK" onClick=${() => key('ok')}>OK</button>
      <button type="button" class="right" aria-label="Right" onClick=${() => key('right')}><${Icon} name="chev" size=${30} w=${2.6} /></button>
      <button type="button" class="down" aria-label="Down" onClick=${() => key('down')}><${Icon} name="chev" size=${30} w=${2.6} /></button>
    </div>
    <div class=${`r-keys n${2 + (active ? 0 : 1) + (roomOn ? 1 : 0)}`}>
      <button type="button" onClick=${() => key('back')}><${Icon} name="left" size=${18} />Back</button>
      <button type="button" onClick=${() => key('home')}><${Icon} name="home" size=${18} />Home</button>
      ${!active && html`<button type="button" onClick=${() => t('play_pause')}><${Play} size=${15} />Play / Pause</button>`}
      ${roomOn && html`<${SleepButton} />`}
    </div>
    ${!active && isUp(avr) && html`<div class="r-vol r-vol-card">
      <span class="k">${muted ? 'Muted' : `Vol ${vol == null ? '–' : Math.round(vol * 200) / 2}`}</span>
      <div class="r-bar thin"><i style=${`width:${vol != null ? Math.min(100, vol * 100) : 0}%`}></i></div>
      <button type="button" aria-label="Volume down" onClick=${() => t('vol_down')}>−</button>
      <button type="button" aria-label="Volume up" onClick=${() => t('vol_up')}>+</button>
    </div>`}
    ${active && session && /^tt\d+/.test(session.id || '') && html`<${AboutPlaying} id=${session.id} key=${session.id} />`}
  </div>`;
}

// Previous / Next episode of a Stremio show (across seasons). Two taps, as switching ends what's
// on: the first arms the button for a few seconds. It opens the episode like Watch does, so the
// stream list comes up (or the first stream plays, with auto-play on).
function EpisodeNav({ id }) {
  const roomOn = useRoomOn();
  const [nb] = useLoad(() => get(`/api/plex/neighbours/${encodeURIComponent(id)}`).catch(() => null), [id]);
  const [armed, setArmed] = useState(null);
  useEffect(() => { if (!armed) return undefined; const t = setTimeout(() => setArmed(null), 4000); return () => clearTimeout(t); }, [armed]);
  if (!nb?.prev && !nb?.next) return null;
  const go = (which) => {
    const ep = nb[which];
    if (!ep) return;
    if (armed !== which) { setArmed(which); return; }
    setArmed(null);
    playItem({ id: ep.id, type: 'episode', title: ep.title, showTitle: ep.showTitle }, roomOn, false);
  };
  const num = (ep) => `${ep.season !== Number(id.split(':')[1]) ? `S${ep.season} ` : ''}E${ep.episode}`;
  const label = (ep) => (ep ? `${num(ep)} · ${ep.title}` : '');
  const btn = (which, text, icon) => {
    const ep = nb[which];
    const on = armed === which;
    return html`<button type="button" class=${`${which === 'next' ? 'nx' : ''}${on ? ' armed' : ''}`} disabled=${!ep} onClick=${() => go(which)}
      aria-label=${ep ? `${text}: ${label(ep)}` : `No ${text.toLowerCase()} episode`}>
      ${which === 'prev' && icon}<span><s>${on ? 'Tap again' : text}</s>${on ? `to play ${num(ep)}` : ep ? label(ep) : '—'}</span>${which === 'next' && icon}
    </button>`;
  };
  return html`<div class="r-eprow">
    ${btn('prev', 'Previous', html`<${Prev} size=${15} />`)}
    ${btn('next', 'Next', html`<${Next} size=${15} />`)}
  </div>`;
}

// YouTube: Previous / Next video. One tap: a skipped video is easy to go back to.
function VideoNav() {
  const go = (cmd) => act({ action: 'transport', cmd }).then((r) => { if (r) toast(cmd === 'next' ? 'Next video' : 'Previous video'); });
  return html`<div class="r-eprow">
    <button type="button" onClick=${() => go('prev')} aria-label="Previous video"><${Prev} size=${15} /><span><s>YouTube</s>Previous video</span></button>
    <button type="button" class="nx" onClick=${() => go('next')} aria-label="Next video"><span><s>YouTube</s>Next video</span><${Next} size=${15} /></button>
  </div>`;
}

// What's playing (Stremio titles): the synopsis, genres and the cast with characters and photos
// (TMDB, when the panel has a key; Stremio's names otherwise).
function AboutPlaying({ id }) {
  const imdb = id.split(':')[0];
  const episode = id.includes(':');
  const [it] = useLoad(() => get(`/api/plex/item/${encodeURIComponent(id)}`).catch(() => null), [id]);
  const [cr] = useLoad(() => get(`/api/credits/${imdb}?kind=${episode ? 'show' : 'movie'}`).catch(() => null), [imdb]);
  const cast = cr?.cast?.length ? cr.cast : (it?.cast || []).map((name) => ({ name: typeof name === 'string' ? name : name?.tag || name?.name || '' })).filter((c) => c.name);
  if (!it && !cast.length) return null;
  const facts = episode && it ? [`S${it.season} · E${it.episode}`, runtime(it.duration)] : [it?.year, runtime(it?.duration)];
  return html`<section class="r-about">
    ${it?.summary && html`<div class="r-h2"><h2>${episode ? 'About this episode' : 'About this film'}</h2><span class="r-aside">${facts.filter(Boolean).join(' · ')}</span></div>
      <p class="r-syn">${it.summary}</p>`}
    ${it?.genres?.length ? html`<div class="r-meta2">${it.genres.map((g) => (typeof g === 'string' ? g : g.tag || g.name)).join(' · ')}</div>` : null}
    ${cast.length > 0 && html`<div class="r-h2"><h2>Cast</h2></div>
      <div class="r-cast">${cast.map((c) => html`<div class="r-person" key=${c.name}>
        <div class="ph">${c.photo ? html`<img src=${c.photo} alt="" loading="lazy" />` : html`<span>${c.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</span>`}</div>
        <b>${c.name}</b>${c.character && html`<s>${c.character}</s>`}
      </div>`)}</div>`}
  </section>`;
}

// ---------- the app ----------

function Toast() {
  const t = useStore((s) => s.toast);
  return t ? html`<div class=${`r-toast ${t.err ? 'err' : ''}`} role="status">${t.text}</div>` : null;
}

// The seat phone follows the room: Games when the Xbox comes on, Remote (Now playing) when a film
// or show plays, Home otherwise. It moves when that changes, and after a few minutes untouched it
// goes back there (sheet closed, scrolled to the top). It never moves while someone is using it. Does nothing on any other phone.
function useSeatFollow({ tab, setTab, sheet, close, hasXbox }) {
  const gaming = useGaming();
  const roomOn = useRoomOn();
  const { active } = useMedia();
  const mode = gaming ? 'xbox' : active ? 'playing' : roomOn ? 'on' : 'off';
  const now = useRef({});
  now.current = { tab, sheet, close, target: gaming && hasXbox ? 'games' : active ? 'remote' : 'home' };
  const touched = useRef(Date.now());
  const prev = useRef(mode);
  const goHome = () => {
    const c = now.current;
    if (c.sheet) c.close();
    if (c.tab !== c.target) setTab(c.target); else window.scrollTo(0, 0);
  };
  useEffect(() => {
    if (!seat) return undefined;
    const t = () => { touched.current = Date.now(); };
    window.addEventListener('pointerdown', t, true);
    window.addEventListener('keydown', t, true);
    const i = setInterval(() => {
      const c = now.current;
      if (Date.now() - touched.current >= SEAT_IDLE_MS && (c.sheet || c.tab !== c.target || window.scrollY > 0)) goHome();
    }, 10e3);
    return () => { window.removeEventListener('pointerdown', t, true); window.removeEventListener('keydown', t, true); clearInterval(i); };
  }, []);
  useEffect(() => {
    if (!seat) return;
    if (mode !== prev.current && mode !== 'off' && Date.now() - touched.current >= SEAT_SWITCH_MS) goHome();
    prev.current = mode;
  }, [mode]);
}

function Remote() {
  const [tab, setTab] = useState(() => (['#watch', '#remote', '#games'].includes(location.hash) ? location.hash.slice(1) : 'home'));
  const hasXbox = useStore((s) => Boolean(s.entities?.xbox && s.states[s.entities.xbox]));
  const [sheet, setSheet] = useState(null);
  const connected = useStore((s) => s.connected);
  useEffect(() => { history.replaceState(null, '', `#${tab}`); window.scrollTo(0, 0); }, [tab]);
  // Back on the phone closes the sheet rather than leaving the page.
  useEffect(() => {
    if (!sheet) return undefined;
    history.pushState({ sheet: true }, '');
    const pop = () => setSheet(null);
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [Boolean(sheet)]);
  const close = (played) => {
    if (history.state?.sheet) history.back(); else setSheet(null);
    if (played) setTab('home');
  };
  useSeatFollow({ tab, setTab, sheet, close, hasXbox });
  // Grown-up mode lasts 20 minutes from the last touch: tell the server someone is using it
  // (at most once a minute).
  useEffect(() => {
    if (!seat) return undefined;
    let last = 0;
    const t = () => {
      const st = getState().seat;
      if (!st?.enabled || st.locked || Date.now() - last < 60e3) return;
      last = Date.now();
      post('/api/seat/touch', {}).catch(() => {});
    };
    window.addEventListener('pointerdown', t, true);
    return () => window.removeEventListener('pointerdown', t, true);
  }, []);
  return html`<div class="r-app">
    ${connected === false && html`<div class="r-offline">Can't reach the cinema panel. Are you on the home Wi-Fi or Tailscale?</div>`}
    ${tab === 'games' && hasXbox ? html`<${Games} />` : tab === 'remote' ? html`<${TvRemote} onTab=${setTab} />` : tab === 'watch' ? html`<${Watch} onOpen=${setSheet} />` : html`<${Home} onOpen=${setSheet} onTab=${setTab} />`}
    <nav class="r-tabs">
      <button type="button" aria-pressed=${tab === 'home' ? 'true' : 'false'} onClick=${() => setTab('home')}><${Icon} name="home" size=${24} />Home</button>
      <button type="button" aria-pressed=${tab === 'watch' ? 'true' : 'false'} onClick=${() => setTab('watch')}><${Icon} name="film" size=${24} />Watch</button>
      ${hasXbox && html`<button type="button" aria-pressed=${tab === 'games' ? 'true' : 'false'} onClick=${() => setTab('games')}><${Icon} name="pad" size=${24} />Games</button>`}
      <button type="button" aria-pressed=${tab === 'remote' ? 'true' : 'false'} onClick=${() => setTab('remote')}><${Icon} name="remote" size=${24} />Remote</button>
    </nav>
    ${sheet && html`<${TitleSheet} start=${sheet} key=${sheet.id} onClose=${close} />`}
    <${Toast} />
  </div>`;
}

// ---------- Games (Xbox) ----------
// Off: Play Xbox (the gaming start in HA), the last game, every installed game. On: what is
// playing, Denon volume, Xbox home, All off, games to switch to and the Denon's input.
const G_ART = ['#2f6b3b,#122a17', '#3b4f7a,#151d33', '#7a3b2f,#2a120e', '#6b5b2f,#2a2210', '#4f2f6b,#1d1029', '#2f6b6b,#0f2929', '#7a2f4f,#2a0f1b', '#5b5b5b,#1e1e1e'];
const gTint = (id) => G_ART[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % G_ART.length];
const gLive = (st) => Boolean(st) && !['unknown', 'unavailable', ''].includes(st.state);
function gAgo(ms) {
  if (!ms) return '';
  const days = Math.round((new Date(new Date().toDateString()) - new Date(new Date(ms).toDateString())) / 864e5);
  if (days <= 0) return 'Played today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(ms).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}
function GTile({ g, on, onPick }) {
  return html`<button type="button" class="rg-tile" aria-pressed=${on ? 'true' : 'false'} onClick=${() => onPick(g)}>
    <div class="sq" style=${`background:linear-gradient(160deg,${gTint(g.id)})`}>${g.thumb ? html`<img src=${g.thumb} alt="" loading="lazy" onError=${(ev) => { ev.currentTarget.style.display = 'none'; }} />` : html`<span>${g.title}</span>`}</div>
    <b>${g.title}</b><span>${g.kind === 'app' ? 'App' : gAgo(g.playedAt) || 'Game'}</span></button>`;
}

function Games() {
  const kids = useKids();
  const e = useStore((s) => s.entities) || {};
  const box = useEntity(e.xbox);
  const scene = useEntity(e.xboxScene);
  const avr = useEntity(e.avr);
  const now = useEntity(e.xboxAccount && `sensor.${e.xboxAccount}_now_playing`);
  const [lib, err] = useLoad(() => get('/api/xbox/library'), []);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useArmed();
  const on = box?.state === 'on';
  const starting = !on && (scene?.state === 'on' || busy);
  const games = lib?.games || [];
  const apps = lib?.apps || [];
  const last = games.find((g) => g.playedAt);
  // A game left running behind a film (the Denon on another input) is not on screen.
  const offInput = avr?.state === 'on' && avr.attributes?.source && avr.attributes.source !== XBOX_INPUT;
  const playing = offInput ? null : gLive(now) ? now.state : (on && box?.attributes?.media_title && box.attributes.media_title !== 'Home' ? box.attributes.media_title : null);
  const norm = (t) => String(t || '').replace(/[™®]/g, '').trim().toLowerCase();
  const current = playing && [...games, ...apps].find((g) => norm(g.title) === norm(playing) || norm(playing).startsWith(norm(g.title)));
  const progress = parseFloat(String(now?.attributes?.progress ?? ""));
  const genres = now?.attributes?.genres;
  const vol = avr?.attributes?.volume_level;
  const muted = Boolean(avr?.attributes?.is_volume_muted);
  const t = (cmd, extra = {}) => act({ action: 'transport', cmd, ...extra });

  async function start() { setBusy(true); if (await act({ action: 'xbox', cmd: 'start' })) toast('Starting the room for gaming'); setTimeout(() => setBusy(false), 60000); }
  async function pick(g) {
    const r = await act({ action: 'xbox', cmd: 'launch', id: g.id, kind: g.kind });
    if (r) toast(r.starting ? `Starting the room · ${g.title} opens when the Xbox is up` : `Opening ${g.title}`);
    if (r?.starting) setBusy(true);
  }
  const allOff = () => { if (!armed) { setArmed(true); return; } setArmed(false); act({ action: 'scene', name: 'all_off' }); toast('Turning everything off'); };

  return html`<div class="r-page">
    <${Top} title="Games" kicker="Xbox"><span class=${`r-chip ${on ? 'on' : starting ? 'warm' : ''}`}><span class="dot"></span>${on ? 'Xbox on' : starting ? 'Starting…' : 'Xbox off'}</span><//>
    ${on ? html`
      <section class="rg-hero playing">
        <div class="rg-kick"><span class="rg-pill"><${Icon} name="pad" size=${18} w=${2} />Xbox</span><span class="rg-eye">${playing ? 'Now playing' : 'On'}</span></div>
        <div class="rg-big">${playing || (offInput ? 'Not on screen' : 'Xbox home')}</div>
        <div class="rg-sub">${playing ? [Array.isArray(genres) ? genres.join(', ') : genres, now?.attributes?.developer].filter(Boolean).join(' · ') : offInput ? (kids ? 'The Denon is on the Chromecast · tap the game below to switch to it' : 'The Denon is on the Chromecast · switch Source to Xbox below') : 'Pick a game below, or use the controller'}</div>
        ${playing && Number.isFinite(progress) && html`<div class="rg-ach"><span>Achievements</span><div class="bar"><i style=${`width:${Math.min(100, progress)}%`}></i></div><span>${Math.round(progress)} %</span></div>`}
        ${isUp(avr) && html`<div class="rg-vol">
          <button type="button" aria-label="Volume down" onClick=${() => t('vol_down')}><${Icon} name="volm" size=${20} /></button>
          <span class="k">${muted ? 'Muted' : `Denon · ${vol == null ? '–' : Math.round(vol * 200) / 2}`}</span>
          <button type="button" aria-label="Volume up" onClick=${() => t('vol_up')}><${Icon} name="volp" size=${20} /></button>
          <button type="button" aria-label=${muted ? 'Unmute' : 'Mute'} onClick=${() => t('mute', { muted: !muted })}><${Icon} name="mute" size=${20} /></button>
        </div>`}
        <div class="rg-row2">
          <button type="button" onClick=${async () => { if (await act({ action: 'xbox', cmd: 'home' })) toast('Xbox home'); }}><${Icon} name="pad" size=${20} />Xbox home</button>
          <button type="button" class=${armed ? 'armed' : ''} onClick=${allOff}><${Icon} name="power" size=${20} />${armed ? 'Tap again' : 'All off'}</button>
        </div>
      </section>
      <div class="r-h2"><h2>Switch game</h2><span class="r-aside">${games.length ? 'Recent first' : ''}</span></div>
      ${err ? html`<div class="r-empty">${err.message}</div>` : html`<div class="rg-strip">${[...games, ...apps].map((g) => html`<${GTile} key=${g.id} g=${g} on=${current?.id === g.id} onPick=${pick} />`)}</div>`}
      ${isUp(avr) && !kids && html`<${Source} avr=${avr} />`}`
    : html`
      <section class="rg-hero">
        <div class="rg-eye">${starting ? 'Starting the room' : 'Xbox is off'}</div>
        <div class="rg-big">${starting ? 'Starting…' : 'Play Xbox'}</div>
        <div class="rg-sub">${starting ? 'Denon, projector, then the Xbox · about 40 seconds' : 'Starts the room for gaming · about 40 seconds'}</div>
        <button type="button" class="rg-play" disabled=${starting} onClick=${start}><${Icon} name="pad" size=${24} />Play Xbox</button>
        ${last && html`<div class="rg-last"><div class="sq" style=${`background:linear-gradient(160deg,${gTint(last.id)})`}>${last.thumb && html`<img src=${last.thumb} alt="" />`}</div>
          <div style="min-width:0;flex:1"><span class="rg-eye" style="font-size:10px">Jump back in</span><b>${last.title}</b><span>${gAgo(last.playedAt)}</span></div>
          <button type="button" onClick=${() => pick(last)}>Play</button></div>`}
      </section>
      <div class="r-h2"><h2>Your games</h2><span class="r-aside">${games.length ? `${games.length} installed` : ''}</span></div>
      ${err ? html`<div class="r-empty">${err.message}</div>` : !lib ? html`<div class="r-empty">Loading…</div>` : lib.error ? html`<div class="r-empty">${lib.error}</div>`
        : html`<div class="rg-grid">${games.map((g) => html`<${GTile} key=${g.id} g=${g} onPick=${pick} />`)}</div>
          <div class="r-empty">Tap a game: the room starts and the game opens.</div>`}`}
  </div>`;
}

startLive({ navigate: () => {} });
render(html`<${Remote} />`, document.getElementById('app'));

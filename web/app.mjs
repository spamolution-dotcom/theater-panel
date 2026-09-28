// App shell: fixed 1920x1080 stage scaled to the screen, the walnut rail, a tiny router, and
// the playback rule: when the Apple TV starts playing the panel goes to Showtime by itself,
// and back to the Lobby when playback ends.

import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { html, Icon } from './lib/ui.mjs';
import { startLive, useStore, useEntity, clock, getState, setTheater, subscribe, post, get, useLoad, toast, playbackState, openTweaks, closeTweaks, closeTonight, closeGuest, openSound, closeSound } from './lib/api.mjs';
import { Emblem } from './lib/emblems.mjs';
import { Particles } from './lib/particles.mjs';
import { RailGlow } from './lib/effects.mjs';
import { onTheater, detectTheater } from './lib/ks.mjs';
import { hallway } from './lib/role.mjs';
import { Lobby } from './views/lobby.mjs';
import { Watch } from './views/watch.mjs';
import { Request } from './views/request.mjs';
import { Music } from './views/music.mjs';
import { Showtime } from './views/showtime.mjs';
import { Games } from './views/games.mjs';
import { Stats } from './views/stats.mjs';
import { Showing } from './views/showing.mjs';
import { Pick } from './views/pick.mjs';
import { Year } from './views/year.mjs';
import { Intermission } from './views/intermission.mjs';
import { TweaksSheet } from './views/tweaks.mjs';
import { TonightSheet, GuestSheet } from './views/tonight.mjs';
import { SoundSheet } from './views/soundbar.mjs';

const VIEWS = { lobby: Lobby, watch: Watch, request: Request, music: Music, games: Games, showtime: Showtime, stats: Stats, showing: Showing, pick: Pick, year: Year, intermission: Intermission };
const NAV = [['lobby', 'Home', 'home'], ['watch', 'Watch', 'film'], ['request', 'Request', 'plus'], ['music', 'Music', 'music'], ['games', 'Games', 'pad']];

// Hash routes, with optional query params: #/watch?lib=networks&brand=netflix
function parseHash() {
  const [name, qs] = location.hash.slice(2).split('?');
  return { name: name || 'lobby', params: Object.fromEntries(new URLSearchParams(qs || '')) };
}
export const route = parseHash();
let setRoute = () => {};
// When the panel was last touched (or navigated by hand). It starts at the moment the page
// loads, not 0: at 0 every "has it been idle for N minutes" test is true straight away, so a
// panel that reloaded and was not touched fell to the Now Showing screen within 15 seconds.
let lastManual = Date.now();
let tvGoneSince = null;   // when the Apple TV entity last went unavailable, or null
export function go(name, params = {}) {
  setRender(params.render);
  setTheme(params.theme);
  setAccent(params.accent);
  setCinema(params.cinema);
  route.name = VIEWS[name] ? name : 'lobby';
  route.params = params;
  if (!params.auto) lastManual = Date.now();
  const qs = new URLSearchParams(Object.entries(params).filter(([k, v]) => k !== 'auto' && k !== 'manual' && typeof v === 'string')).toString();
  history.replaceState(null, '', `#/${route.name}${qs ? `?${qs}` : ''}`);
  setRoute({ ...route });
}

// Scale the stage to fit whatever screen we are on (exactly 1:1 on the 1920x1080 panel).
// On the wall panel (Kiosk Satellite, or framed in HA's dashboard) the stage fills the screen.
// In an ordinary browser it never grows past 100%, so a big monitor shows it at the panel's own
// size; ?fit=1 scales it to the window anyway.
const onPanel = Boolean(window.kioskSatellite) || window.parent !== window || new URLSearchParams(location.search).has('fit');
//
// At exactly 1:1 (the panel) the stage is drawn in place with no transform: a transformed
// full-screen layer made the panel's Android WebView sprinkle black specks along shadows. Other
// sizes use CSS zoom (real layout at that size, no scaled layer); render=transform brings back
// the old scaled layer.
//
// Render switches for chasing GPU glitches on the panel, set from HA without a redeploy:
// rest_command.theater_panel_navigate with route "#/lobby?render=noshadow,notex" (comma list of
// transform, noshadow, notex, noanim). They stick until another render= arrives; "render=" clears them.
let renderFlags = new Set();
export function setRender(value) {
  if (value === undefined) return;
  renderFlags = new Set(String(value).split(',').map((x) => x.trim()).filter(Boolean));
  for (const f of ['noshadow', 'notex', 'noanim', 'shadows']) document.documentElement.classList.toggle(`r-${f}`, renderFlags.has(f));
  fit();
}
// Theme: the settings page picks it (Display > Theme, arrives with the rest of /api/state);
// "#/lobby?theme=sofa" overrides it on this panel until "theme=" clears the override.
const THEMES = ['classic', 'sofa'];
let themeOverride = null;
let themeSetting = 'classic';
function applyTheme() {
  const t = themeOverride || themeSetting;
  for (const name of THEMES) document.documentElement.classList.toggle(`t-${name}`, t === name && name !== 'classic');
}
export function setTheme(value) {
  if (value === undefined) return;
  themeOverride = THEMES.includes(value) ? value : null;
  applyTheme();
}
subscribe(() => { const t = getState().ui?.theme; if (THEMES.includes(t) && t !== themeSetting) { themeSetting = t; applyTheme(); } });

// Holiday accent (server/accents.mjs): the server resolves the calendar and sends { id, glyph,
// glow, gold }; "?accent=halloween" tries one on this panel, "accent=" clears the override.
const ACCENT_IDS = ['halloween', 'thanksgiving', 'christmas', 'newyear', 'valentines', 'birthday', 'winter', 'spring', 'summer', 'fall'];
// Idle glow and weather per accent, for a route override (the server sends these with its pick).
const ACCENT_DEFS = {
  halloween: { id: 'halloween', name: 'Halloween', glow: 'Halloween Eyes', weather: 'bats' },
  thanksgiving: { id: 'thanksgiving', name: 'Thanksgiving', glow: 'Ember Ring', weather: 'leaves' },
  christmas: { id: 'christmas', name: 'Christmas', glow: 'Fairytwinkle', weather: 'xmas' },
  newyear: { id: 'newyear', name: 'New Year', glow: 'Fireworks Burst', weather: 'confetti' },
  valentines: { id: 'valentines', name: "Valentine's", glow: 'Heartbeat Pulse', weather: 'hearts' },
  birthday: { id: 'birthday', name: 'Birthday', glow: 'Confetti', weather: 'confetti' },
  winter: { id: 'winter', name: 'Winter', glow: 'Rolling Fog', weather: 'snow' },
  spring: { id: 'spring', name: 'Spring', glow: 'Aurora (Pastel Dream)', weather: 'petals' },
  summer: { id: 'summer', name: 'Summer', glow: 'Firefly Jar', weather: 'fireflies' },
  fall: { id: 'fall', name: 'Fall', glow: 'Ember Ring', weather: 'leaves' },
};
// The accent in effect for the rail and the weather layer: a route override or the server's pick.
export function currentAccent() {
  const s = getState().ui?.accent;
  return accentOverride ? ACCENT_DEFS[accentOverride] : s?.id && s.id !== 'none' ? s : null;
}

// Cinema mode: the room is dark, but nothing is playing. Showtime and the idle board look after
// themselves; every other screen would sit there at full brightness, lighting the room from the
// wall, so the whole palette drops instead (see html.cinema in styles.css). It follows the room:
// the downlights under a quarter, or off.
// "?cinema=1" pins it on this panel, "cinema=" clears the override, and the settings page can
// turn the whole idea off.
let cinemaOverride = null;
export function setCinema(value) {
  if (value === undefined) return;
  cinemaOverride = hallway ? false : value === '1' || value === 'on' ? true : value === '0' || value === 'off' ? false : null;
  applyCinema();
}
// The lights decide, not the scene helper: the helper only changes when a scene runs, so
// switching the downlights on at the wall (or in HA) left it saying "Intermission" and the panel
// dark in a lit room. The downlights are the room's light: under a quarter, or off, is dark,
// whatever the accent lights and the scene are doing (they used to have a say, which left the
// panel bright in a room with the downlights barely on and the accents off).
function roomIsDark(s) {
  const [downlights] = s.entities?.lights || [];
  const down = s.states[downlights];
  if (!down || down.state === 'unavailable') return false;
  const pct = down.state === 'on' ? ((down.attributes?.brightness ?? 255) / 255) * 100 : 0;
  return pct < 25;
}
function applyCinema() {
  const s = getState();
  const on = cinemaOverride ?? (s.ui?.cinema !== false && roomIsDark(s));
  document.documentElement.classList.toggle('cinema', Boolean(on));
}
subscribe(applyCinema);

// "How was it?" - the film finished and ran to the end, so the panel asks on its way out and
// writes the answer back to Plex as a star rating. Everyone on the sofa can tap: the card keeps
// the tally and Plex is told the average, so one person's five does not stand for the room. It
// shows over whatever screen is up, the way the dog does, and takes no for an answer.
function RateCard() {
  if (hallway) return null;
  const live = useStore((s) => s.rate);
  const [hover, setHover] = useState(0);
  const [mine, setMine] = useState(0);
  // "?rate=1" puts the card up for a look without sitting through a film first.
  const v = route.params.rate === '1' ? { id: 'demo', title: 'Dune: Part Two', year: 2024, poster: null, votes: [5, 4] } : live;
  useEffect(() => { setMine(0); setHover(0); }, [v?.id]);
  // Sequel radar: the next film in the series, in the library or a tap away from a request.
  const [related] = useLoad(() => (v?.id && v.id !== 'demo' ? get(`/api/plex/related/${v.id}`) : Promise.resolve(null)), [v?.id]);
  if (!v?.id) return null;
  const votes = v.votes || [];
  const next = related?.next;
  const average = votes.length ? votes.reduce((a, b) => a + b, 0) / votes.length : 0;
  const send = async (stars) => {
    setMine(stars);
    try { await post('/api/rate', { id: v.id, stars, title: v.title, year: v.year }); }
    catch (e) { toast(e.message, true); }
    setTimeout(() => { setMine(0); setHover(0); }, 1200);       // ready for the next person
  };
  return html`<div class="rate" role="dialog" aria-label=${`How was ${v.title}?`}>
    ${v.poster && html`<img src=${v.poster} alt="" />`}
    <div class="t">
      <b>How was it?</b>
      <span>${v.title}${v.year ? ` · ${v.year}` : ''}</span>
      <div class="stars" onPointerLeave=${() => setHover(0)}>
        ${[1, 2, 3, 4, 5].map((n) => html`<button type="button" class="star" aria-label=${`${n} out of 5`}
          onPointerEnter=${() => setHover(n)} onClick=${() => send(n)}>
          <${Icon} name="star" size=${46} w=${1.6} color="var(--gold)" fill=${n <= (hover || mine) ? 'var(--gold)' : 'none'} /></button>`)}
      </div>
      <span class="tally">${votes.length
        ? `${average.toFixed(1)} from ${votes.length} ${votes.length === 1 ? 'person' : 'people'} · anyone else?`
        : 'Everyone gets a say'}</span>
      ${next && html`<div class="sequel">
        <span><b>Next in the series:</b> ${next.title}${next.year ? ` (${next.year})` : ''}${!next.released ? ' · not out yet' : next.owned?.watched ? ' · seen' : ''}</span>
        ${next.owned ? html`<button type="button" class="btn ghost" onClick=${() => post('/api/tonight', { ratingKey: next.owned.id }).then(() => toast(`${next.title} is up for tonight`)).catch((e) => toast(e.message, true))}>Queue it</button>`
          : next.released ? html`<button type="button" class="btn ghost" onClick=${() => post('/api/seerr/request', { mediaType: 'movie', mediaId: next.tmdb }).then(() => toast(`Asked for ${next.title}`)).catch((e) => toast(e.message, true))}>Request it</button>` : null}
      </div>`}
    </div>
    <button type="button" class="skip" onClick=${() => post('/api/rate', { dismiss: true }).catch(() => {})}>${votes.length ? 'Done' : 'Skip'}</button>
  </div>`;
}

// Snow, leaves, petals, confetti... falling over the lobby and settling on the tops of the cards.
function Weather({ decor = '' }) {
  const acc = useStore((s) => s.ui?.accent?.id);
  const setting = useStore((s) => s.ui?.accentIntensity);
  const theater = useStore((s) => Boolean(s.theater?.active));
  const hol = currentAccent();
  // 0..100 from the settings page: 25 is the original amount, 100 four times it (MORE BATS).
  // "?intensity=100" tries a level on this panel.
  const intensity = Math.max(0, Math.min(100, Number(route.params.intensity ?? setting ?? 50))) / 25;
  if (!hol?.weather || !intensity || renderFlags.has('noanim')) return null;
  return html`<${Particles} kind=${hol.weather} intensity=${intensity} decor=${decor} key=${`${hol.weather}-${acc}-${intensity}-${decor}`} paused=${theater} />`;
}
// The dog wants to come in: UniFi hears barking or sees an animal on the deck camera, and the
// panel says so with a snapshot - over a film too, which a doorbell would not earn. Dismiss it,
// or it clears itself once the sensors go quiet and a couple of minutes have passed.
function DogAtDoor() {
  const ents = useStore((s) => s.entities);
  const name = useStore((s) => s.ui?.dogName) || 'The dog';
  const states = useStore((s) => (ents.dogSensors || []).map((id) => s.states[id]?.state).join(','));
  const ids = ents.dogSensors || [];
  // "?dog=1" puts the card up for a look without waiting for the real thing.
  const barking = route.params.dog === '1' || ids.some((id, i) => states.split(',')[i] === 'on');
  const [since, setSince] = useState(0);
  const [hidden, setHidden] = useState(0);
  const [shot, setShot] = useState(0);
  useEffect(() => { if (barking) { setSince(Date.now()); setShot(Date.now()); } }, [barking]);
  // refresh the snapshot every few seconds while it is up
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setShot(Date.now()), 4000);
    const off = setTimeout(() => setSince(0), 150000);
    return () => { clearInterval(t); clearTimeout(off); };
  }, [since]);
  if (!ids.length || !since || hidden > since) return null;
  return html`<div class="dog" role="status">
    <img src=${`/api/camera.jpg?t=${shot}`} alt="" onError=${(e) => { e.target.style.display = 'none'; }} />
    <div class="t"><b>${name} is at the deck door</b><span>${barking ? 'Barking now' : 'Heard a moment ago'}</span></div>
    <button type="button" onClick=${() => setHidden(Date.now())}>Dismiss</button>
  </div>`;
}

// A request landing in Plex is worth ten seconds of confetti, whatever the season.
function Celebration() {
  const at = useStore((s) => s.celebrateAt) || 0;
  const [, tick] = useState(0);
  useEffect(() => { if (!at) return; const timer = setTimeout(() => tick((n) => n + 1), 10500); return () => clearTimeout(timer); }, [at]);
  if (!at || Date.now() - at > 10000) return null;
  return html`<${Particles} kind="confetti" intensity=${2.5} key=${`cheer-${at}`} />`;
}

// Halloween only: every minute or so the room's lights gutter, the way a bulb does before it
// goes. One overlay, opacity only - no blur or transform, which the panel's GPU dislikes.
function useHaunting(on) {
  const [flicker, setFlicker] = useState(0);
  useEffect(() => {
    if (!on) return;
    let timer;
    const again = () => { timer = setTimeout(() => { setFlicker(Date.now()); again(); }, 45000 + Math.random() * 75000); };
    again();
    return () => clearTimeout(timer);
  }, [on]);
  return flicker;
}

let accentOverride = null;
let accentSetting = { id: 'none' };
const accentNow = () => (accentOverride ? { id: accentOverride } : accentSetting);
function applyAccent() {
  const id = accentNow().id;
  for (const a of ACCENT_IDS) document.documentElement.classList.toggle(`a-${a}`, id === a);
}
export function setAccent(value) {
  if (value === undefined) return;
  accentOverride = ACCENT_IDS.includes(value) ? value : null;
  applyAccent();
}
subscribe(() => { const a = getState().ui?.accent; if (a && a.id !== accentSetting.id) { accentSetting = a; applyAccent(); } });

// The panel's GPU sprinkles specks along blurred box-shadows (confirmed with render=noshadow),
// and a crisp 2px version still speckled on pages that repaint often, so on the panel every
// blurred shadow is dropped and only hairlines (0 blur) and inset shadows are kept.
// render=shadows puts them back for testing.
const SHADOW_PART = /((?:[^,(]|\([^)]*\))+)/g;
function flatShadow(value) {
  const keep = value.match(SHADOW_PART).map((p) => p.trim()).filter((part) => {
    if (/inset/.test(part)) return true;
    const color = (part.match(/rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8}\b|var\([^)]*\)/i) || [''])[0];
    const lengths = part.replace(color, '').match(/-?[\d.]+/g)?.map(Number) || [];
    return lengths.length < 3 || lengths[2] === 0;   // no blur radius
  });
  return keep.length ? keep.join(', ') : 'none';
}
let crisped = false;
function crispShadows() {
  if (crisped || !onPanel || renderFlags.has('shadows')) return;
  crisped = true;
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) if (r.style?.boxShadow && r.style.boxShadow !== 'none') r.style.boxShadow = flatShadow(r.style.boxShadow);
  }
}

function fit() {
  document.documentElement.classList.toggle('r-panel', onPanel);
  crispShadows();
  const s = Math.min(innerWidth / 1920, innerHeight / 1080, onPanel ? Infinity : 1);
  const st = document.getElementById('stage');
  const legacy = renderFlags.has('transform');
  document.documentElement.classList.toggle('r-zoom', !legacy);
  st.style.transform = legacy ? `translate(-50%, -50%) scale(${s})` : '';
  st.style.zoom = legacy || s === 1 ? '' : String(s);
}
addEventListener('resize', fit);
addEventListener('hashchange', () => {
  const r = parseHash();
  if (r.name !== route.name || JSON.stringify(r.params) !== JSON.stringify(route.params)) go(r.name, r.params);
});

function Rail({ current }) {
  const [now, setNow] = useState(clock());
  // The rail glows with whatever the accent lights are doing (see lib/effects.mjs).
  const ents = useStore((s) => s.entities);
  const accent = useEntity(ents.lights?.find((id) => /accent/.test(id)) || '');
  const speedEnt = useEntity(ents.accentSpeed);
  const speed = Math.max(0.05, Math.min(1, (Number(speedEnt?.state) || 128) / 255));
  // The glow tracks the accents' brightness: 0.15 when they are barely on, 0.65 at full.
  const bright = Math.max(0, Math.min(1, (Number(accent?.attributes?.brightness) || 0) / 255));
  const glow = 0.15 + 0.5 * bright;
  const theater = useStore((s) => Boolean(s.theater?.active));
  // Seven taps on the version number, within a few seconds, open the panel's settings sheet.
  const taps = useRef([]);
  const tapVersion = () => {
    const now = Date.now();
    taps.current = [...taps.current.filter((t) => now - t < 4000), now];
    if (taps.current.length >= 7) { taps.current = []; openTweaks(); }
  };
  const build = useStore((s) => s.build) || {};
  const ha = useStore((s) => ({ ok: s.haConnected, configured: s.haConfigured, live: s.connected }));
  // The holiday accent: its glow fills the rail while the accents are off, and its glyph sits
  // over the clock. An override from the route only knows the id, so look the rest up.
  useStore((s) => s.ui?.accent?.id);              // re-render when the server's pick changes
  const hol = currentAccent();
  const lightsOn = accent?.state === 'on';
  useEffect(() => { const t = setInterval(() => setNow(clock()), 15000); return () => clearInterval(t); }, []);
  return html`<nav class="rail tx-planks-rail" aria-label="Sections">
    <${RailGlow} name=${route.params.glow || (lightsOn ? accent.attributes?.effect : hol?.glow || null)} speed=${lightsOn ? speed : 0.3}
      opacity=${Number(route.params.glowop) || (theater ? glow * 0.4 : lightsOn ? glow : 0.3)} paused=${theater} />
    ${NAV.map(([name, label, icon]) => html`<a href=${`#/${name}`} aria-current=${current === name ? 'page' : undefined}
      onClick=${(e) => { e.preventDefault(); go(name); }}><${Icon} name=${icon} size=${32} /><span>${label}</span></a>`)}
    <a href="#/lobby?mystery=1" title="Mystery box" onClick=${(e) => { e.preventDefault(); go('lobby', { mystery: '1' }); }}><${Icon} name="sparkle" size=${32} /><span>Mystery</span></a>
    <div class="grow"></div>
    ${ha.live === false ? html`<div class="offline">Server offline</div>` : ha.live && !ha.ok ? html`<div class="offline">${ha.configured ? 'HA offline' : 'HA not set up'}</div>` : null}
    <a href="#/showtime" class="to-showtime" onClick=${(e) => { e.preventDefault(); go('showtime'); }}><${Icon} name="moon" size=${30} /><span>Showtime</span></a>
    ${hol && html`<div class="glyph" title=${hol.who ? `${hol.who}'s birthday` : hol.name}><${Emblem} id=${hol.id} size=${68} />${hol.who && html`<span>${hol.who}</span>`}</div>`}
    <div class="clock">${now.hm}</div><div class="ampm">${now.ampm}</div>
    ${build.version && html`<div class="build" title=${build.time ? `built ${build.time}` : ''} onClick=${tapVersion}>
      <span>${build.version.split('.').slice(0, 3).join('.')}</span>
      <span>${build.version.split('.').slice(3).join('.')}</span>
    </div>`}
  </nav>`;
}

function App() {
  const [r, setR] = useState(route);
  setRoute = setR;
  // The Plex session first (Plezy on the projector), the Apple TV otherwise; see playbackState.
  const tvState = useStore((s) => playbackState(s));
  const toast = useStore((s) => s.toast);

  // Playback drives the screen: start playing -> Showtime; stop -> Lobby. If someone leaves
  // Showtime while a movie plays, return there after 90 s without a touch.
  useEffect(() => {
    if (tvState === 'playing' && route.name !== 'showtime' && Date.now() - lastManual > 90000) go('showtime', { auto: true });
    // The Streamer reports only on/off: with nothing on it (no session) Showtime has nothing to show.
    const nothingOn = tvState === 'on' && !getState().sessions?.length;
    if ((['idle', 'off', 'standby'].includes(tvState) || nothingOn) && route.name === 'showtime') go('lobby', { auto: true });
  }, [tvState]);
  // Intermission is a screen as well as a scene: whoever calls for the break - the panel, a Pico
  // remote, "hey Jarvis, intermission" - gets the snack bar on the wall, and leaving the scene
  // takes it away again.
  const scene = useStore((s) => s.states['input_select.theater_scene']?.state);
  const wasScene = useRef(undefined);
  useEffect(() => {
    const before = wasScene.current;
    wasScene.current = scene;
    if (before === undefined || before === scene) return;        // first look, not a change
    if (scene === 'Intermission' && route.name !== 'intermission') go('intermission', { auto: true });
    if (before === 'Intermission' && route.name === 'intermission') go(scene === 'Movie time' ? 'showtime' : 'lobby', { auto: true });
  }, [scene]);
  // Untouched for a while: drift to the Now Showing screen (a cinema lobby board). Any touch
  // brings the panel straight back to Home. Nothing happens during Showtime.
  useEffect(() => {
    const t = setInterval(() => {
      const idleMin = getState().idleMinutes ?? 8;
      if (idleMin > 0 && !['showtime', 'showing', 'intermission'].includes(route.name) && Date.now() - lastManual > idleMin * 60000) go('showing', { auto: true });
    }, 15000);
    const back = () => { if (route.name === 'showing') go('lobby'); };
    addEventListener('pointerdown', back, true);
    return () => { clearInterval(t); removeEventListener('pointerdown', back, true); };
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const { states, entities } = getState();
      const st = playbackState(getState());
      const tv = states[entities.appleTv]?.state;
      if (st === 'playing' && route.name !== 'showtime' && Date.now() - lastManual > 90000) go('showtime', { auto: true });
      // The Apple TV entity gone (unavailable, unknown, missing) for over a minute mid-film: leave
      // Showtime too, or the panel stays dark with the backlight down until someone reloads it.
      // (a Plezy film on the projector keeps Showtime up whatever the Apple TV entity does)
      const gone = Boolean(entities.appleTv) && !getState().sessions?.[0] && (tv == null || tv === 'unavailable' || tv === 'unknown');
      tvGoneSince = gone ? (tvGoneSince || Date.now()) : null;
      if (gone && route.name === 'showtime' && Date.now() - tvGoneSince > 60000) go('lobby', { auto: true });
    }, 5000);
    // Theater mode switched on from HA, a ks:// link or a reload mid-film: show Showtime.
    const offTheater = hallway ? () => {} : onTheater((d) => { if (d.active && route.name !== 'showtime') go('showtime', { auto: true }); });
    const touch = () => { lastManual = Date.now(); };
    addEventListener('pointerdown', touch, true);
    return () => { clearInterval(t); offTheater(); removeEventListener('pointerdown', touch, true); };
  }, []);

  // A new build is out: reload once nobody is using the panel - never in the middle of a film,
  // a break, or someone's tap.
  useEffect(() => {
    const t = setInterval(() => {
      if (!getState().stale) return;
      if (['showtime', 'intermission'].includes(route.name)) return;
      if (Date.now() - lastManual < 60000) return;
      location.reload();
    }, 15000);
    return () => clearInterval(t);
  }, []);
  // The swell or the march, when the room's speaker is asleep: only the panel on the wall plays
  // it, not every laptop that happens to have the page open.
  const sound = useStore((s) => s.sound);
  useEffect(() => {
    if (!sound?.url || !onPanel || Date.now() - sound.at > 5000) return;
    const a = new Audio(sound.url);
    a.play().catch((e) => console.warn('[sound]', e.message));
    return () => { a.pause(); };
  }, [sound?.at]);

  const haunt = useHaunting(currentAccent()?.id === 'halloween');
  const tweaks = useStore((s) => s.tweaks);
  const tonightOpen = useStore((s) => s.tonightOpen);
  const guestOpen = useStore((s) => s.guestOpen);
  const soundOpen = useStore((s) => s.soundOpen);
  // "?sound=1" opens the Sound sheet straight away, for a look or a screenshot.
  useEffect(() => { if (route.params.sound === '1') openSound(); }, []);
  const View = VIEWS[r.name] || Lobby;
  // Showtime, the idle screen and the intermission snack bar fill the panel on their own.
  // The idle board is mostly empty floor, so it gets the weather and, at Christmas, a lit tree.
  if (r.name === 'showtime' || r.name === 'showing' || r.name === 'intermission') return html`<${View} key=${r.name} />
    ${r.name === 'showing' && html`<${Weather} decor="tree" />`}
    <${DogAtDoor} />
    <${RateCard} />
    ${toast && html`<div class=${`toast ${toast.err ? 'err' : ''}`}>${toast.text}</div>`}`;
  return html`<div class="app tx-plaster">
    <${Rail} current=${r.name} />
    <${View} key=${r.name + JSON.stringify(r.params)} />
    ${tweaks && html`<${TweaksSheet} onClose=${closeTweaks} />`}
    ${tonightOpen && html`<${TonightSheet} item=${tonightOpen.item} onClose=${closeTonight} />`}
    ${guestOpen && html`<${GuestSheet} onClose=${closeGuest} />`}
    ${soundOpen && html`<${SoundSheet} onClose=${closeSound} />`}
    <${Weather} key=${`fx-${r.name}`} />
    <${Celebration} />
    <${DogAtDoor} />
    <${RateCard} />
    ${haunt > 0 && html`<div class="haunt" key=${haunt}></div>`}
    ${toast && html`<div class=${`toast ${toast.err ? 'err' : ''}`}>${toast.text}</div>`}
  </div>`;
}

// "#/watch?brand=netflix" or "watch?brand=netflix" -> go('watch', {brand: 'netflix'})
function goRoute(r) {
  const [name, qs] = String(r || '').replace(/^#?\/?/, '').split('?');
  go(name || 'lobby', Object.fromEntries(new URLSearchParams(qs || '')));
}

setRender(route.params.render ?? '');
setTheme(route.params.theme ?? '');
setAccent(route.params.accent ?? '');
setCinema(route.params.cinema ?? '');
startLive({ navigate: goRoute });
// Is Kiosk Satellite's theater mode reachable (directly, or relayed by the HA page around us)?
if (!hallway) detectTheater().then((t) => {
  setTheater(t);
  if (t?.active && route.name !== 'showtime') go('showtime', { auto: true });
});
render(html`<${App} />`, document.getElementById('stage'));

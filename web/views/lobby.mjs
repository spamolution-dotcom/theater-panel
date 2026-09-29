// Lobby: continue watching, scenes, projector, lights, just added and the pre-show music bar.

import { useState, useRef, useEffect } from 'preact/hooks';
import { html, Icon, Play, Pause, Prev, Next, Poster, Seg, Range, Header, H2 } from '../lib/ui.mjs';
import { get, act, useLoad, useStore, useEntity, runtime, endsAt, toast, celebrate, clearMystery, christmasCountdown, openTonight, openGuest, openSound } from '../lib/api.mjs';
import { go, route } from '../app.mjs';
import { EffectPreview, EffectTile, byMood, familyOf, curated } from '../lib/effects.mjs';
import { StreamsChip, StreamsSheet } from './streams.mjs';
import { MysterySheet } from './mystery.mjs';
import { SleepChip } from './sleep.mjs';
import { needsWarmup } from './warmup.mjs';

const SCENES = [
  { name: 'pre_show', label: 'Pre-show', desc: 'Warm lights · music', icon: 'music' },
  { name: 'movie_time', label: 'Movie time', desc: 'Lights fade · projector on', icon: 'film' },
  { name: 'intermission', label: 'Intermission', desc: 'Pause · lights 30%', icon: 'cup' },
  { name: 'lights_up', label: 'Lights up', desc: 'Full bright · music off', icon: 'sun' },
];

export function Lobby() {
  const ents = useStore((s) => s.entities);
  const temp = useEntity(ents.temperature);
  const occ = useEntity(ents.occupancy);
  const plan = useStore((s) => s.tonight);
  const soundbar = useStore((s) => s.entities.soundbar);
  // A rear speaker left off its dock is the thing that goes wrong with detachable rears.
  const undocked = useStore((s) => (s.entities.soundbar?.rears || []).filter((r) => s.states[r.docked]?.state === 'off').map((r) => r.channel));
  const tv = useEntity(ents.appleTv);
  const [requests] = useLoad(() => get('/api/seerr/requests?take=10').catch(() => null), []);
  const downloading = requests?.results?.filter((r) => r.label === 'Downloading').length || 0;
  const arrivals = useArrivals();
  const [streamsOpen, setStreamsOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  // "#/lobby?mystery=1" opens the box straight away - handy from a Home Assistant automation
  // ("surprise me") and for screenshots.
  const [mystery, setMystery] = useState(route.params.mystery === '1');
  // "Hey Jarvis, surprise me": the server picked and pushed it to every panel.
  const spoken = useStore((s) => s.mystery);
  useEffect(() => { if (spoken) setMystery(true); }, [spoken]);
  const services = useStore((s) => s.services) || {};
  const countdown = christmasCountdown(new Date(), route.params.countdown === '1');
  const weekday = new Date().toLocaleDateString('en-US', { weekday: 'long' });
  const part = new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening';

  return html`<main class="view">
    <${Header} title="Home Theater" kicker=${countdown ? `${weekday} ${part} · ${countdown.text}` : `${weekday} ${part}`}>
      ${arrivals.list.length > 0 && html`<button type="button" class="chip arrival" onClick=${() => go('watch', { item: arrivals.list[0].plexId })}>
        ${arrivals.list[0].poster && html`<img src=${arrivals.list[0].poster} alt="" />`}
        <span><b>New in your library</b> ${arrivals.list[0].title}</span>${arrivals.list.length > 1 && html`<span class="more">+${arrivals.list.length - 1}</span>`}
        <span class="x" role="button" aria-label="Dismiss" onClick=${(e) => { e.stopPropagation(); arrivals.dismiss(arrivals.list[0].id); }}>×</span></button>`}
      <${StreamsChip} onClick=${() => setStreamsOpen(true)} />
      ${occ && html`<span class="chip"><${Icon} name="user" size=${20} />${occ.state === 'on' ? 'Occupied' : 'Empty'}</span>`}
      ${tv && html`<span class="chip"><${Icon} name="screen" size=${20} />TV · ${tv.state}</span>`}
      <button type="button" class=${`chip ${plan ? 'on' : ''}`} onClick=${() => openTonight()}><${Icon} name="film" size=${20} />${plan ? `Tonight · ${plan.at ? new Date(plan.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : plan.state === 'feature' ? 'on' : 'ready'}` : 'Tonight'}</button>
      <${AllOffChip} />
      <button type="button" class="chip" onClick=${() => openGuest()}><${Icon} name="remote" size=${20} />Guest remote</button>
      ${soundbar && html`<button type="button" class=${`chip ${undocked.length ? 'warn' : ''}`} onClick=${() => openSound()}><${Icon} name="spk" size=${20} />${undocked.length ? `${undocked.join(' and ')} rear off its dock` : 'Sound'}</button>`}
      <button type="button" class="chip" onClick=${() => go('pick')}><${Icon} name="dice" size=${20} />Movie night</button>
      ${services.plex && html`<button type="button" class="chip" onClick=${() => setMystery(true)}><${Icon} name="sparkle" size=${20} />Mystery box</button>`}
      <${SleepChip} />
      ${services.seerr && html`<button type="button" class="chip" onClick=${() => setScanOpen(true)}><${Icon} name="plus" size=${20} />Scan to request</button>`}
      ${downloading > 0 && html`<button type="button" class="chip warn" onClick=${() => go('request')}><${Icon} name="dl" size=${20} />${downloading} downloading</button>`}
    <//>
    <div class="lobby-grid">
      <${Continue} />
      <${Scenes} />
      <${Cinema} />
      <${Lights} />
      <div class="right-col">
        <${JustAdded} />
      </div>
    </div>
    ${streamsOpen && html`<${StreamsSheet} onClose=${() => setStreamsOpen(false)} />`}
    ${scanOpen && html`<${ScanToRequest} onClose=${() => setScanOpen(false)} />`}
    ${mystery && html`<${MysterySheet} initial=${spoken} key=${spoken?.item?.id || 'box'} onClose=${() => { setMystery(false); clearMystery(); }} />`}
  </main>`;
}

// A guest with a phone can add something to the request queue without borrowing the panel: the
// QR opens Seerr's own search page. The panel only draws the code; Seerr handles the sign-in.
function ScanToRequest({ onClose }) {
  const [url] = useLoad(() => get('/api/seerr/url').catch(() => null), []);
  const link = url?.url || '';
  return html`<div class="sheet dark tx-suede" role="dialog" aria-label="Scan to request">
    <div class="h">
      <div><div class="eyebrow">Anything missing?</div><div class="t">Scan to request</div></div>
      <button type="button" class="icon-btn" style="width:46px;height:46px;background:rgba(0,0,0,.25)" aria-label="Close" onClick=${onClose}><${Icon} name="x" color="#F4F0E8" /></button>
    </div>
    <div class="scan-body">
      ${link
        ? html`<img class="qr" src=${`/api/vote/qr.svg?url=${encodeURIComponent(link)}`} alt="" />
          <div class="scan-text">
            <p>Point a phone at the code, search for the film or show, and ask for it. It lands in the request queue and the panel says so when it arrives in Plex.</p>
            <code>${link.replace(/^https?:\/\//, '')}</code>
          </div>`
        : html`<p class="empty">Seerr is not set up yet.</p>`}
    </div>
  </div>`;
}

// Requested titles that landed in Plex in the last two days, newest first, minus ones dismissed on
// this panel.
function useArrivals() {
  const [all] = useLoad(() => get('/api/seerr/arrivals').catch(() => []), []);
  const [gone, setGone] = useState(() => { try { return JSON.parse(localStorage.getItem('tp-dismissed') || '[]'); } catch { return []; } });
  // The first sight of a new arrival is worth confetti; after that it is just a chip.
  useEffect(() => {
    if (!all?.length) return;
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem('tp-seen-arrivals') || '[]'); } catch {}
    const fresh = all.map((a) => a.id).filter((id) => !seen.includes(id));
    if (!fresh.length) return;
    try { localStorage.setItem('tp-seen-arrivals', JSON.stringify([...seen, ...fresh].slice(-80))); } catch {}
    if (seen.length) celebrate();          // not on this panel's very first load
  }, [all]);
  const dismiss = (id) => {
    const next = [...gone, id].slice(-50);
    setGone(next);
    try { localStorage.setItem('tp-dismissed', JSON.stringify(next)); } catch {}
  };
  return { list: (all || []).filter((a) => !gone.includes(a.id)), dismiss };
}

function Continue() {
  const [deck] = useLoad(() => get('/api/plex/ondeck?size=8'), []);
  const [i, setI] = useState(0);
  const [drag, setDrag] = useState(0);
  const swipe = useRef(null);
  const swallowUntil = useRef(0);
  if (!deck) return html`<section class="hero dark tx-suede"><div class="empty" style="flex-grow:1">Loading Stremio…</div></section>`;
  if (!deck.length) return html`<section class="hero dark tx-suede"><div class="empty" style="flex-grow:1;color:#C7B39E">Nothing in progress. Pick something from Watch.</div></section>`;
  const it = deck[i % deck.length];
  const pct = it.duration ? Math.round((it.viewOffset / it.duration) * 100) : 0;
  // Coming back after days away: when it was, how far in, and who was watching.
  const rewind = it.viewOffset > 0 && it.lastViewedAt && Date.now() - it.lastViewedAt > 36 * 3600e3
    ? `Last time ${ago(it.lastViewedAt)} · ${runtime(it.viewOffset)} in${it.who ? ` · with ${it.who}` : ''}` : '';
  const left = (it.duration || 0) - (it.viewOffset || 0);
  const name = it.showTitle || it.title;
  const n = deck.length;
  const at = i % n;

  // Swipe left/right to move through the deck. A swipe never counts as a tap on the buttons.
  const down = (e) => {
    if (n <= 1) return;
    swipe.current = { x: e.clientX, y: e.clientY, moved: false };
    // Keep the gesture ours even when the finger leaves the card (Fully Kiosk's WebView otherwise
    // hands it to the page as a scroll and the swipe never lands).
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };
  const step = (d) => setI((at + d + n) % n);
  const noSwipe = (e) => e.stopPropagation();
  const move = (e) => {
    const s = swipe.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    if (!s.moved && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(e.clientY - s.y)) s.moved = true;
    if (s.moved) setDrag(dx);
  };
  const up = (e) => {
    const s = swipe.current;
    swipe.current = null;
    if (!s?.moved) return;
    const dx = e.clientX - s.x;
    if (dx < -70) setI((at + 1) % n);
    else if (dx > 70) setI((at - 1 + n) % n);
    setDrag(0);
    swallowUntil.current = Date.now() + 400; // the click that ends a drag is not a tap
  };
  const guard = (e) => { if (Date.now() < swallowUntil.current) { e.stopPropagation(); e.preventDefault(); } };
  const cancel = () => { swipe.current = null; setDrag(0); };

  return html`<section class="hero dark tx-suede swipe" onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${cancel} onClickCapture=${guard}>
    <div class="slide" key=${it.id} style=${drag ? `transform:translateX(${drag * 0.6}px);opacity:${Math.max(0.35, 1 - Math.abs(drag) / 500)};transition:none` : ''}>
    <div class="art">
      <img src=${it.art || it.still} alt="" draggable="false" />
      ${n > 1 && html`<span class="count">${at + 1} / ${n}</span>`}
      ${n > 1 && html`<button type="button" class="deck-arrow prev" aria-label="Previous" onPointerDown=${noSwipe} onClick=${() => step(-1)}><${Icon} name="left" size=${30} w=${2.2} color="#fff" /></button>
        <button type="button" class="deck-arrow next" aria-label="Next" onPointerDown=${noSwipe} onClick=${() => step(1)}><${Icon} name="chev" size=${30} w=${2.2} color="#fff" /></button>`}
      <div class="name">${name}</div>
    </div>
    <div class="body">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="eyebrow" style="white-space:nowrap">Continue watching</div>
        ${n > 1 && html`<div class="deck-dots">${deck.map((_, k) => html`<i class=${k === at ? 'on' : ''} key=${k}></i>`)}</div>`}

      </div>
      <div class="title">${it.title}</div>
      ${it.showTitle && html`<div class="sub">Season ${it.season}, Episode ${it.episode}</div>`}
      <p>${it.summary}</p>
      <div style="flex-grow:1"></div>
      <div>
        <div class="bar"><i style=${`width:${pct}%`}></i></div>
        <div class="times"><span>${[it.year, it.viewOffset ? `${runtime(left)} left` : runtime(left)].filter(Boolean).join(' · ')}</span><span>ends ${endsAt(left)}</span></div>
      </div>
      ${rewind && html`<div class="rewind"><${Icon} name="moon" size=${18} color="var(--gold)" />${rewind}</div>`}
      <div style="display:flex;gap:12px">
        <button type="button" class="btn primary" style="height:66px;flex-grow:1" onClick=${() => play(it, true)}><${Play} />${it.viewOffset ? 'Resume' : 'Play'}</button>
        ${rewind && html`<button type="button" class="btn ghost" style="height:66px;flex-shrink:0" title="Play the last two minutes again first" onClick=${() => play(it, true, { offset: Math.max(0, it.viewOffset - 120000) })}><${Icon} name="back" size=${24} color="#F4F0E8" />Recap</button>`}
        ${it.viewOffset > 0 && html`<button type="button" class="btn ghost" style="height:66px;width:66px;padding:0;flex-shrink:0" aria-label="Start over" title="Start over" onClick=${() => play(it, false)}><${Icon} name="back" size=${28} color="#F4F0E8" /></button>`}
        ${it.type === 'movie' && !it.viewOffset && html`<button type="button" class="btn ghost" style="height:66px;flex-shrink:0" title="Plan the evening around it" onClick=${() => openTonight(it)}><${Icon} name="film" size=${24} color="#F4F0E8" />Tonight</button>`}
      </div>
    </div>
    </div>
  </section>`;
}

const ago = (ms) => { const d = Math.round((Date.now() - ms) / 86400e3); return d <= 1 ? 'yesterday' : d < 14 ? `${d} days ago` : d < 60 ? `${Math.round(d / 7)} weeks ago` : `${Math.round(d / 30)} months ago`; };

export async function play(item, resume = true, extra = {}) {
  // A cold room takes about two minutes to come up: show the warm-up screen instead of Showtime.
  const cold = needsWarmup();
  const r = await act({ action: 'play', ratingKey: item.id, type: item.type, title: item.showTitle || item.title, offset: resume ? item.viewOffset : 0, ...extra });
  if (!r) return;
  const name = `${item.showTitle ? `${item.showTitle}: ` : ''}${item.title}`;
  if (cold) {
    const sub = item.showTitle ? `S${item.season} · E${item.episode} ${item.title}` : [item.year].filter(Boolean).join('');
    go('warmup', { title: item.showTitle || item.title, sub, poster: item.poster || '', at: String(Date.now()) });
    return;
  }
  toast(r.preroll ? `Lights down… ${name} in ${r.preroll}s` : `Opening ${name} on the TV · pick a stream with the remote`);
  go('showtime');
}

// The cinema is on: a way to turn it all off (your End Movie Scene, through the movie scene switch).
// A second tap within 4 s confirms, so a stray touch does nothing.
function AllOffChip() {
  const roomOn = useStore((s) => s.states[s.entities?.roomOn]?.state === 'on');
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return undefined; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);
  if (!roomOn) return null;
  return html`<button type="button" class=${`chip ${armed ? 'warn' : ''}`} onClick=${() => { if (!armed) { setArmed(true); return; } setArmed(false); act({ action: 'scene', name: 'all_off' }); toast('Turning the cinema off'); }}>
    <${Icon} name="power" size=${20} />${armed ? 'Tap again to turn off' : 'All off'}</button>`;
}

function Scenes() {
  // The tracker keeps its last value when the cinema is turned off elsewhere (the toggle, the Hue
  // switch), so no scene is shown as active while the movie scene is off.
  const roomOn = useStore((s) => s.states[s.entities?.roomOn]?.state === 'on');
  const tracked = useEntity('input_select.theater_scene')?.state;
  const scene = roomOn ? tracked : undefined;
  const map = { 'Pre-show': 'pre_show', 'Movie time': 'movie_time', Intermission: 'intermission', 'Lights up': 'lights_up' };
  const active = map[scene];
  return html`<section class="scenes tx-maple" aria-label="Scenes">
    <div class="grid">
      ${SCENES.map((s) => html`<button type="button" class="scene" aria-pressed=${s.name === active ? 'true' : 'false'} onClick=${() => act({ action: 'scene', name: s.name })}>
        <${Icon} name=${s.icon} size=${30} color=${s.name === active ? 'var(--gold)' : 'var(--acc)'} />
        <span><span class="n">${s.label}</span><br /><span class="d">${s.desc}</span></span>
      </button>`)}
    </div>
  </section>`;
}

// Sources: the Apple TV, then what is wired straight to the projector (the Unraid VM), then the
// consoles on the HDMI switcher, all from games.json. Apps open on the projector's own Android.
const SOURCE_ICONS = { tv: 'tv', pad: 'pad', joystick: 'joystick', remote: 'remote', monitor: 'server', server: 'server', steam: 'playc' };
const APP_ICONS = [[/plex|plezy/i, 'plex'], [/you ?tube|smarttube/i, 'youtube'], [/moonlight|parsec|steam link/i, 'pad']];
const appIcon = (a) => a.icon || APP_ICONS.find(([re]) => re.test(a.name))?.[1] || 'app';

// What is on screen: the theater's Plex session (when PLEX_PLAYER_NAME pins it down), else the
// Apple TV's own now-playing when it is the source.
function useNowPlaying(on, current, tv) {
  const sessions = useStore((s) => s.sessions);
  const own = useStore((s) => s.ui?.theaterSessions);
  if (!on) return null;
  const s = own && sessions?.[0];
  if (s) {
    const left = (s.duration || 0) - (s.viewOffset || 0);
    const name = s.type === 'episode' ? `${s.showTitle} S${s.season}·E${s.episode}` : s.title;
    return `${s.state === 'paused' ? 'Paused · ' : ''}${name}${left > 0 ? ` · ${runtime(left)} left` : ''}`;
  }
  if (current === 'appletv' && tv && ['playing', 'paused'].includes(tv.state) && tv.attributes?.media_title) {
    const a = tv.attributes;
    return `${tv.state === 'paused' ? 'Paused · ' : ''}${a.media_series_title ? `${a.media_series_title} · ` : ''}${a.media_title}`;
  }
  return null;
}

function Projector() {
  const ents = useStore((s) => s.entities);
  const apps = useStore((s) => s.projectorApps) || [];
  const proj = useEntity(ents.projector);
  const tv = useEntity(ents.appleTv);
  const [games, , reload] = useLoad(() => get('/api/games').catch(() => null), []);
  const [picked, setPicked] = useState(null);
  const hasProj = Boolean(ents.projector);
  // Until the projector's own entity exists, the Apple TV's power state stands in for it (CEC).
  const on = hasProj ? proj && !['off', 'standby', 'unavailable'].includes(proj.state) : tv && !['off', 'standby', 'unavailable'].includes(tv.state);
  const appId = on ? proj?.attributes?.app_id : null;
  const runningApp = apps.find((a) => a.package === appId);

  // In the order set on the admin page.
  const sources = (games?.sources || []).map((s) => ({ ...s, icon: s.icon?.includes(':') ? s.icon : SOURCE_ICONS[s.icon] || (s.via === 'switcher' ? 'pad' : 'screen') }));
  const current = runningApp ? null : picked || games?.active;
  const picture = useEntity(ents.pictureMode)?.state;
  const nowPlaying = useNowPlaying(on, current, tv);
  // The light engine's temperatures, from the projector plugin: a quiet line, and a nudge when
  // the laser runs hot enough to be worth a break.
  const hotAt = useStore((s) => s.projectorHotC) || 65;
  // Home Assistant reports in the house's unit; the threshold is in °C, so compare in °C.
  const temps = useStore((s) => (s.entities.projectorTemps || []).map((id) => s.states[id]).filter((e) => e && !['unknown', 'unavailable'].includes(e.state))
    .map((e) => { const unit = e.attributes?.unit_of_measurement || '°C'; const value = Number(e.state); return { name: (e.attributes?.friendly_name || '').replace(/^.*?:\s*/, '').replace(/^.*NexiGo Aurora Pro /, '').replace(/ temperature$/i, ''), value, unit, celsius: unit === '°F' ? (value - 32) * 5 / 9 : value }; }));
  const hot = temps.length > 0 && temps[0].celsius >= hotAt;

  async function pickSource(s) {
    setPicked(s.id);
    const ok = await act({ action: 'game_source', id: s.id });
    if (ok) toast(`Projector: ${s.name}`);
    setPicked(null);
    reload();
  }
  async function openApp(a) {
    if (await act({ action: 'projector_app', package: a.package })) toast(on ? `Opening ${a.name}` : `Waking the projector for ${a.name}`);
    reload();
  }

  return html`<section class="card proj">
    <${H2} title="Projector">${on && picture && !['unknown', 'unavailable'].includes(picture)
      ? html`<button type="button" class="aside mode" title="Next picture mode" onClick=${() => act({ action: 'picture_next' })}><span class="dot on"></span>${picture}</button>`
      : html`<span class="aside"><span class=${`dot ${on ? 'on' : ''}`}></span>${on ? 'On' : 'Standby'}</span>`}<//>
    <div class="row">
      <button type="button" class=${`power ${on ? 'on' : ''}`} aria-label=${on ? 'Turn projector off' : 'Turn projector on'}
        onClick=${() => act({ action: 'projector', cmd: on ? 'power_off' : 'power_on' })}>
        <${Icon} name="power" size=${40} color=${on ? '#fff' : 'var(--acc)'} w=${2.4} />
      </button>
      <div style="min-width:0;flex:1"><div style="font-size:21px;font-weight:600">NexiGo Aurora Pro</div>
      <div class="muted ellipsis" style="font-size:16px">${!on ? 'Tap a source or app to start' : nowPlaying || 'Nothing playing'}</div></div>
    </div>
    ${temps.length > 0 && html`<div class=${`temps ${hot ? 'hot' : ''}`} title="Light engine temperatures"><${Icon} name="therm" size=${18} />${temps.slice(0, 4).map((x) => `${x.name} ${Math.round(x.value)}${x.unit === '°F' ? '°F' : '°'}`).join(' · ')}${hot ? ' · running hot, worth a break' : ''}</div>`}
    <div class="label" style="margin:18px 0 8px">Source</div>
    <div class="tiles">${sources.map((s) => html`<button type="button" class="tile" aria-pressed=${current === s.id ? 'true' : 'false'} disabled=${!hasProj} onClick=${() => pickSource(s)}>
      <${Icon} name=${s.icon} size=${30} /><span>${s.name}</span></button>`)}</div>
    ${apps.length > 0 && html`<div class="label" style="margin:16px 0 8px">Apps</div>
    <div class="tiles">${apps.map((a) => html`<button type="button" class="tile" aria-pressed=${runningApp === a ? 'true' : 'false'} disabled=${!hasProj} onClick=${() => openApp(a)}>
      <${Icon} name=${appIcon(a)} size=${30} /><span>${a.name}</span></button>`)}</div>`}
  </section>`;
}

const LIGHT_META = {
  'light.media_room_downlights': { name: 'Downlights', fill: '#B8792F' },
  'light.home_theater_accent_lights': { name: 'Accent lights', fill: '#C9772F' },
  'light.home_theater_wled': { name: 'LED strip', fill: '#9C4A1E' },
};

function Lights() {
  const ids = useStore((s) => s.entities.lights || []);
  const [picking, setPicking] = useState(null);
  return html`<section class="card lights-card">
    <${H2} title="Lights"><button type="button" class="link" onClick=${() => act({ action: 'aisle_glow' })}>Aisle glow</button><//>
    <div style="display:flex;flex-direction:column;gap:16px;margin-top:16px">
      ${ids.map((id) => html`<${LightRow} id=${id} onEffects=${setPicking} />`)}
    </div>
    ${(picking || (route.params.fxopen && ids.find((x) => /accent/.test(x)))) && html`<${EffectSheet} id=${picking || ids.find((x) => /accent/.test(x))} onClose=${() => setPicking(null)} />`}
  </section>`;
}

// Variant B (mockup, #/lobby?fx=b): the row itself is the picker — swipe through effects, the
// neighbours peek at the edges, tap the middle to apply.
function EffectCarousel({ id, effects, current }) {
  const list = effects.filter((e) => e !== 'None' && !/^Calibrate/i.test(e));
  const [i, setI] = useState(() => Math.max(0, list.indexOf(current)));
  const swipe = useRef(null);
  const at = (n) => list[(n + list.length) % list.length];
  const down = (e) => { swipe.current = e.clientX; };
  const up = (e) => {
    const x0 = swipe.current; swipe.current = null;
    if (x0 == null) return;
    const dx = e.clientX - x0;
    if (dx < -40) setI((v) => (v + 1) % list.length);
    else if (dx > 40) setI((v) => (v - 1 + list.length) % list.length);
    else act({ action: 'light_effect', entity_id: id, effect: at(i) });
  };
  return html`<div class="fx-carousel" onPointerDown=${down} onPointerUp=${up}>
    <div class="strip">
      <${EffectPreview} name=${at(i - 1)} h=${40} cls="side" />
      <div class="cur"><${EffectPreview} name=${at(i)} h=${52} />${at(i) === current && html`<span class="live">On</span>`}</div>
      <${EffectPreview} name=${at(i + 1)} h=${40} cls="side" />
    </div>
    <div class="name">${at(i)}<small>${at(i) === current ? 'playing · swipe for more' : 'tap to apply'}</small></div>
  </div>`;
}

// Favourites first, then every effect the light has, grouped by mood; speed and intensity at the
// bottom drive the same helpers the basement card uses.
const FAVOURITES = ['Candle Flicker', '2D Hearth', '2D Pacifica', '2D Aurora (Solar Storm)', 'Rolling Fog', '2D Clouds', 'Heartbeat Pulse', 'TwinkleFox'];

function EffectSheet({ id, onClose }) {
  const st = useEntity(id);
  const ents = useStore((s) => s.entities);
  const speedEnt = useEntity(ents.accentSpeed);
  const chosen = useStore((stt) => stt.effectFavourites);
  const [section, setSection] = useState('Favourites');
  const scroller = useRef();
  // The accent lights carry the room's named moods; other lights (the WLED strip) are offered the
  // same ones rather than WLED's own few hundred.
  const accentList = useStore((stt) => stt.states[(stt.entities.lights || []).find((id) => /accent/.test(id))]?.attributes?.effect_list);
  const all = curated((st?.attributes?.effect_list || []).filter((e) => e !== 'None' && !/^Calibrate/i.test(e)), accentList);
  const current = st?.attributes?.effect;
  const speed = Math.max(0.05, Math.min(1, (Number(speedEnt?.state) || 128) / 255));
  const favs = (chosen?.length ? chosen : FAVOURITES).filter((f) => all.includes(f)).slice(0, 8);
  // One list: favourites first, then every mood, scrolled through a section at a time.
  const sections = [{ id: 'favs', name: 'Favourites', effects: favs }, ...byMood(all)].filter((g) => g.effects.length);
  const pick = (name) => act({ action: 'light_effect', entity_id: id, effect: name });

  // The heading follows whichever section is at the top of the scroller.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)[0];
      if (top) setSection(top.target.dataset.name);
    }, { root, rootMargin: '0px 0px -75% 0px', threshold: 0 });
    root.querySelectorAll('.fx-sec').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sections.length]);

  return html`<div class="fx-sheet" role="dialog" aria-label="Choose an effect">
    <div class="h">
      <div><div class="eyebrow">${(st?.attributes?.friendly_name || 'Lights').replace(/^home theater\s+/i, '')}</div>
        <div class="t">Moods</div></div>
      <button type="button" class="icon-btn" style="width:46px;height:46px;background:rgba(0,0,0,.25)" aria-label="Close" onClick=${onClose}><${Icon} name="x" color="#F4F0E8" /></button>
    </div>
    <div class="fx-scroll scroll" ref=${scroller}>
      ${sections.map((g) => html`<section class="fx-sec" data-name=${g.name}>
        <div class="fx-secname">${g.name}<small>${g.effects.length}</small></div>
        <div class="fx-grid">
          ${g.effects.map((name) => html`<${EffectTile} name=${name} speed=${speed} active=${name === current} onPick=${pick} h=${34} />`)}
        </div>
      </section>`)}
    </div>
  </div>`;
}

function LightRow({ id, onEffects }) {
  const st = useEntity(id);
  const meta = LIGHT_META[id] || { name: st?.attributes?.friendly_name || id, fill: '#B8792F' };
  const on = st?.state === 'on';
  const pct = on ? Math.round(((st.attributes.brightness || 0) / 255) * 100) : 0;
  const rgb = st?.attributes?.rgb_color;
  const detail = !st ? 'Unavailable' : !on ? 'Off'
    : st.attributes.effect && st.attributes.effect !== 'Solid' ? `${pct}% · ${st.attributes.effect}`
    : st.attributes.color_mode === 'color_temp' ? `${pct}% · ${st.attributes.color_temp_kelvin}K` : `${pct}%`;
  const effects = st?.attributes?.effect_list || [];
  const effect = on && st.attributes.effect && st.attributes.effect !== 'Solid' ? st.attributes.effect : null;
  return html`<div class="light">
    <div class="head">
      <button type="button" class="name" onClick=${() => act({ action: 'light', entity_id: id, on: !on })} aria-label=${`${meta.name}: turn ${on ? 'off' : 'on'}`}>
        ${rgb && on && html`<span class="swatch" style=${`background:rgb(${rgb.join(',')})`}></span>`}${meta.name}
      </button>
      <span class="mono muted" style="font-size:15px">${detail}</span>
    </div>
    <${Range} value=${pct} label=${`${meta.name} brightness`} fill=${meta.fill}
      onCommit=${(v) => act({ action: 'light', entity_id: id, ...(v === 0 ? { on: false } : { brightness_pct: v }) })} />
    ${effects.length > 1 && route.params.fx === 'b' ? html`<${EffectCarousel} id=${id} effects=${effects} current=${effect} />`
      : effects.length > 1 && html`<button type="button" class="fx-row" onClick=${() => onEffects(id)} aria-label=${`Choose an effect for ${meta.name}`}>
      ${effect ? html`<${EffectPreview} name=${effect} h=${26} round=${8} />` : html`<span class="none">No effect</span>`}
      <span class="lbl">${effect || 'Choose'}</span><${Icon} name="chev" size=${18} color="var(--muted)" />
    </button>`}
  </div>`;
}

// This fork: the lower half of the lobby is a stack of rows, like Stremio's own Board - your films
// and shows, then every catalog your installed addons offer. Tap a poster for its details.
function Shelves() {
  const [rows, err] = useLoad(() => get('/api/shelves'), []);
  return html`<section class="card shelves">
    <${H2} title="Browse"><button type="button" class="link" onClick=${() => go('watch', { lib: 'library' })}>All of Watch</button><//>
    <div class="shelves-scroll">
      ${!rows && !err && html`<div class="empty">Loading your catalogs…</div>`}
      ${err && html`<div class="empty">Could not load catalogs: ${err.message}</div>`}
      ${(rows || []).map((r) => html`<${ShelfRow} key=${r.id} row=${r} />`)}
    </div>
  </section>`;
}

function ShelfRow({ row }) {
  const [res] = useLoad(() => get(`/api/plex/library/${row.id}?size=20`), [row.id]);
  const items = res?.items;
  if (items && !items.length) return null;   // an empty catalog just isn't shown
  return html`<div class="shelf-row">
    <div class="shelf-head"><button type="button" class="link" onClick=${() => go('watch', { lib: row.id })}>${row.title}</button><span class="muted">${row.addon}</span></div>
    <div class="shelf-track">
      ${!items ? html`<div class="empty" style="padding:30px 0">…</div>` : items.map((m) => html`<button type="button" class="poster-btn" key=${m.id} onClick=${() => go('watch', { lib: row.id, item: m.id })} aria-label=${m.title}>
        <div class="framed"><${Poster} src=${m.poster} title=${m.title} /></div>
      </button>`)}
    </div>
  </div>`;
}

// This fork: the cinema's own devices where the original had its projector. Power comes from your
// movie scene (start it here; All off turns it off), then what HA reports for each device, the
// Denon's volume and its input.
function Cinema() {
  const e = useStore((s) => s.entities) || {};
  const room = useEntity(e.roomOn);
  const plug = useEntity(e.plug);
  const avr = useEntity(e.avr);
  const proj = useEntity(e.projectorPower);
  const tv = useEntity(e.appleTv);
  const warming = useStore((s) => s.states[s.entities?.warmupScript]?.state === 'on');
  const on = room?.state === 'on';
  const isUp = (st) => Boolean(st) && !['off', 'unavailable', 'unknown', 'standby'].includes(st.state);
  const app = tv?.attributes?.app_id;
  const appName = app === 'com.stremio.one' ? 'Stremio' : app === 'com.netflix.ninja' ? 'Netflix' : isUp(tv) ? 'Home screen' : '';
  const vol = Math.round((avr?.attributes?.volume_level || 0) * 100);
  const src = avr?.attributes?.source;
  const devices = [
    { name: 'Power', ok: isUp(plug), note: isUp(plug) ? 'On' : 'Off' },
    { name: 'Denon', ok: isUp(avr), note: isUp(avr) ? `${vol}%` : 'Off' },
    { name: 'Projector', ok: isUp(proj), note: isUp(proj) ? 'On' : 'Off' },
    { name: 'Streamer', ok: isUp(tv), note: appName || 'Off' },
  ];
  const status = warming ? 'Warming up…' : on ? 'On' : 'Off';
  return html`<section class="card cinema-card">
    <${H2} title="Cinema"><span class="aside"><span class=${`dot ${on ? 'on' : ''}`}></span>${status}</span><//>
    <div class="row">
      <button type="button" class=${`power ${on ? 'on' : ''}`} aria-label=${on ? 'Cinema is on' : 'Start the cinema'} disabled=${on || warming}
        onClick=${() => act({ action: 'cinema', cmd: 'on' })}><${Icon} name="power" size=${40} color=${on ? '#F4F0E8' : 'var(--acc)'} /></button>
      <div style="min-width:0"><div style="font-size:21px;font-weight:600">${on ? 'Cinema is on' : warming ? 'Starting up' : 'Start the cinema'}</div>
        <div class="muted" style="font-size:16px">${on ? 'All off is in the top bar' : 'Powers the Denon, projector and Streamer (about 2 min)'}</div></div>
    </div>
    <div class="devs">${devices.map((d) => html`<div class=${`dev ${d.ok ? 'ok' : ''}`}><span class=${`dot ${d.ok ? 'on' : ''}`}></span><b>${d.name}</b><span class="muted">${d.note}</span></div>`)}</div>
    ${isUp(avr) && html`<div class="label" style="margin:14px 0 8px">Volume · ${vol}%</div>
      <${Range} value=${vol} label="Denon volume" onCommit=${(v) => act({ action: 'cinema', cmd: 'volume', value: v })} />
      <div class="label" style="margin:14px 0 8px">Input</div>
      <div class="tiles">${[['GoogleTVStreamer', 'Streamer', 'tv'], ['Xbox One', 'Xbox', 'pad']].map(([id, name, icon]) => html`<button type="button" class="tile" aria-pressed=${src === id ? 'true' : 'false'} onClick=${() => act({ action: 'cinema', cmd: 'source', source: id })}><${Icon} name=${icon} size=${26} /><span>${name}</span></button>`)}</div>`}
  </section>`;
}

// Just added: your newest titles, four big posters at a time.
function JustAdded() {
  const [items] = useLoad(() => get('/api/plex/recent?size=20'), []);
  // One card per movie or show: collapse episodes into their show.
  const seen = new Set();
  const list = (items || []).filter((m) => {
    const k = m.showTitle || m.id;
    if (seen.has(k)) return false; seen.add(k); return true;
  }).slice(0, 12);
  // Four big posters at a time; swipe (or tap a dot) for the next four.
  const PER = 4;
  const pages = Math.max(1, Math.ceil(list.length / PER));
  const [page, setPage] = useState(0);
  const pg = Math.min(page, pages - 1);
  const swipe = useRef(null);
  const swallowUntil = useRef(0);
  const down = (e) => { if (pages > 1) { swipe.current = e.clientX; try { e.currentTarget.setPointerCapture(e.pointerId); } catch {} } };
  const up = (e) => {
    const x0 = swipe.current; swipe.current = null;
    if (x0 == null) return;
    const dx = e.clientX - x0;
    if (Math.abs(dx) < 60) return;
    setPage((pg + (dx < 0 ? 1 : -1) + pages) % pages);
    swallowUntil.current = Date.now() + 400;
  };
  const guard = (e) => { if (Date.now() < swallowUntil.current) { e.stopPropagation(); e.preventDefault(); } };
  const kind = (m) => (m.type === 'show' || m.type === 'episode' || m.showTitle ? 'Series' : 'Film');
  return html`<section class="card just-added">
    <${H2} title="Just added"><button type="button" class="link" onClick=${() => go('watch', { lib: 'library' })}>Browse library</button><//>
    <div class="ja-grid" onPointerDown=${down} onPointerUp=${up} onPointerCancel=${() => { swipe.current = null; }} onClickCapture=${guard}>
      ${list.slice(pg * PER, pg * PER + PER).map((m) => html`<button type="button" class="ja-item" key=${m.id} onClick=${() => go('watch', { item: m.id })} aria-label=${m.showTitle || m.title}>
        <div class="framed"><${Poster} src=${m.poster} title=${m.showTitle || m.title} /></div>
        <div class="ja-name">${m.showTitle || m.title}</div>
        <div class="ja-meta">${[m.year, kind(m)].filter(Boolean).join(' · ')}</div>
      </button>`)}
    </div>
    ${pages > 1 && html`<div class="ja-dots"><span>Swipe for more</span>${Array.from({ length: pages }, (_, k) => html`<button type="button" class=${k === pg ? 'on' : ''} aria-label=${`Page ${k + 1}`} onClick=${() => setPage(k)}></button>`)}</div>`}
  </section>`;
}

function MusicBar() {
  const players = useStore((s) => s.entities.musicPlayers || []);
  const id = players[0];
  const st = useEntity(id);
  const a = st?.attributes || {};
  const playing = st?.state === 'playing';
  const vol = Math.round((a.volume_level || 0) * 100);
  const unavailable = !st || st.state === 'unavailable';
  return html`<section class="musicbar dark tx-suede">
    ${a.entity_picture ? html`<img class="cover" src=${`/api/ha-image?e=${encodeURIComponent(id)}&v=${encodeURIComponent(a.entity_picture)}`} alt="" />` : html`<div class="cover"></div>`}
    <div style="flex-grow:1;min-width:0;display:flex;flex-direction:column;gap:4px">
      <div class="eyebrow" style="font-size:14px">${unavailable ? 'Music Assistant player unavailable' : `Music · ${a.friendly_name || 'Home Theater'}`}</div>
      <div class="ellipsis" style="font-size:23px;font-weight:600">${a.media_title || (unavailable ? 'Check the Music Assistant player' : 'Nothing playing')}</div>
      <div class="ellipsis" style="font-size:17px;color:var(--on-choc2)">${[a.media_artist, a.media_album_name].filter(Boolean).join(' · ')}</div>
    </div>
    <button type="button" class="icon-btn" style="width:60px;height:60px" aria-label="Previous" disabled=${unavailable} onClick=${() => act({ action: 'music', cmd: 'previous', entity_id: id })}><${Prev} size=${26} color="#F4F0E8" /></button>
    <button type="button" class="icon-btn" style="width:76px;height:76px;background:var(--gold)" aria-label=${playing ? 'Pause' : 'Play'} disabled=${unavailable} onClick=${() => act({ action: 'music', cmd: 'play_pause', entity_id: id })}>
      ${playing ? html`<${Pause} size=${30} color="var(--choc2)" />` : html`<${Play} size=${30} color="var(--choc2)" />`}
    </button>
    <button type="button" class="icon-btn" style="width:60px;height:60px" aria-label="Next" disabled=${unavailable} onClick=${() => act({ action: 'music', cmd: 'next', entity_id: id })}><${Next} size=${26} color="#F4F0E8" /></button>
    <div style="width:150px"><${Range} cls="thin" value=${vol} label="Music volume" fill="var(--gold)" rest="rgba(0,0,0,.35)" onCommit=${(v) => act({ action: 'music', cmd: 'volume', level: v / 100, entity_id: id })} /></div>
  </section>`;
}

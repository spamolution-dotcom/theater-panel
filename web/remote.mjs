// The cinema remote for a phone (/remote): the wall panel's controls and its Watch screen at phone
// width. Home has what's playing, Continue, Just added, the scenes, the devices and the blind; Watch
// browses and searches Stremio and plays a title in the cinema (starting it first if it's off).
// Same server, same actions as the wall panel; only the layout is new. Home network only (it
// relies on the panel's trusted networks, like the wall tablet does).

import { render } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Play, Pause, Poster } from './lib/ui.mjs';
import { get, act, useLoad, useStore, useEntity, startLive, toast, livePosition, playbackState, runtime, mmss } from './lib/api.mjs';
import { soundFormat } from './lib/sound.mjs';

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
  return html`<header class="r-top"><div><div class="r-kick">${kicker}</div><h1>${title}</h1></div>${children}</header>`;
}

function StatusChip() {
  const roomOn = useRoomOn();
  const warming = useStore((s) => s.states[s.entities?.warmupScript]?.state === 'on');
  const cls = warming ? 'warm' : roomOn ? 'on' : '';
  return html`<span class=${`r-chip ${cls}`}><span class="dot"></span>${warming ? 'Starting…' : roomOn ? 'Cinema on' : 'Cinema off'}</span>`;
}

function NowPlaying({ onTab }) {
  const e = useStore((s) => s.entities) || {};
  const roomOn = useRoomOn();
  const tv = useEntity(e.appleTv);
  const avr = useEntity(e.avr);
  const session = useStore((s) => (s.ui?.theaterSessions ? s.sessions?.[0] : undefined));
  const sessionsAt = useStore((s) => s.sessionsAt) || Date.now();
  const state = useStore((s) => playbackState(s));
  const playing = state === 'playing';
  const [, tick] = useState(0);
  useEffect(() => { if (!playing) return undefined; const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, [playing]);
  if (!roomOn || !(session || isUp(tv))) return null;

  const a = tv?.attributes || {};
  const app = session?.app || (a.app_id === 'com.netflix.ninja' ? 'netflix' : a.app_id === 'com.stremio.one' ? 'stremio' : null);
  const title = session?.showTitle || session?.title || a.media_series_title || a.media_title || (app ? APPS.find((x) => x.id === app)?.name : 'Home screen');
  const sub = session?.showTitle ? `S${session.season} · E${session.episode} ${session.title}` : (a.media_series_title ? a.media_title : '');
  const dur = session?.duration ? session.duration / 1000 : a.media_duration || null;
  let pos = null;
  if (session?.viewOffset != null) pos = session.viewOffset / 1000 + (playing ? (Date.now() - sessionsAt) / 1000 : 0);
  else pos = livePosition(tv);
  const left = dur && pos != null ? dur - pos : null;
  const fmt = soundFormat(avr?.attributes?.sound_mode_raw);
  const label = playing ? 'Now playing' : state === 'paused' ? 'Paused' : state === 'choosing' ? 'Pick a stream on the TV' : 'On the TV';
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
        <button type="button" class="pad" aria-label="TV remote" onClick=${() => onTab('remote')}><${Icon} name="remote" size=${20} /></button>
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

function Scenes() {
  const roomOn = useRoomOn();
  const tracked = useEntity('input_select.theater_scene')?.state;
  const active = roomOn ? SCENE_OF[tracked] : undefined;
  const [armed, setArmed] = useArmed();
  const allOff = () => {
    if (!armed) { setArmed(true); return; }
    setArmed(false); act({ action: 'scene', name: 'all_off' }); toast('Turning the cinema off');
  };
  return html`<section>
    <div class="r-h2"><h2>Scenes</h2></div>
    <div class="r-scn-grid">${SCENES.map((sc) => html`<button type="button" class="r-scn" key=${sc.name} aria-pressed=${sc.name === active ? 'true' : 'false'}
      onClick=${() => act({ action: 'scene', name: sc.name })}><${Icon} name=${sc.icon} size=${22} /><span><b>${sc.label}</b><s>${sc.desc}</s></span></button>`)}</div>
    ${roomOn && html`<button type="button" class=${`r-alloff ${armed ? 'armed' : ''}`} onClick=${allOff}><${Icon} name="power" size=${20} />${armed ? 'Tap again to turn everything off' : 'All off'}</button>`}
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
  const app = tv?.attributes?.app_id;
  const devices = [
    { id: 'projector', name: 'Projector', icon: 'projector', ok: isUp(proj), note: isUp(proj) ? 'On' : 'Off' },
    { id: 'denon', name: 'Denon', icon: 'receiver', ok: isUp(avr), note: isUp(avr) ? `On · ${vol}` : 'Off' },
    { id: 'chromecast', name: 'Chromecast', icon: 'cast', ok: isUp(tv), note: !isUp(tv) ? 'Off' : app === 'com.stremio.one' ? 'Stremio' : app === 'com.netflix.ninja' ? 'Netflix' : 'On' },
  ];
  return html`<section>
    <div class="r-h2"><h2>Devices</h2></div>
    <div class="r-devs">${devices.map((d) => html`<${DevButton} d=${d} key=${d.id} />`)}</div>
  </section>`;
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
  const added = recent && recent.filter((m) => { const k = m.showTitle || m.id; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 14);
  const d = new Date();
  const part = d.getHours() < 12 ? 'morning' : d.getHours() < 17 ? 'afternoon' : 'evening';
  return html`<div class="r-page">
    <${Top} title="Home Theater" kicker=${`${d.toLocaleDateString('en-AU', { weekday: 'long' })} ${part}`}><${StatusChip} /><//>
    <${NowPlaying} onTab=${onTab} />
    <${Shelf} title="Continue" items=${deck} onOpen=${onOpen} empty="Nothing in progress." />
    <${Shelf} title="Just added" items=${added} onOpen=${onOpen} empty="Nothing new."
      link=${html`<button type="button" class="r-link" onClick=${() => onTab('watch')}>Browse</button>`} />
    <${Scenes} />
    <${Devices} />
    <${Blind} />
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
    setItems(null); setCursor(null);
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
      <div class="r-seg kind">${[['movie', 'Movies'], ['show', 'TV Shows']].map(([k, label]) => html`<button type="button" aria-pressed=${kind === k ? 'true' : 'false'} onClick=${() => { if (k !== kind) { setKind(k); setLib(null); } }}>${label}</button>`)}</div>
      <div class="r-pills">${kindLibs.map((l) => html`<button type="button" class="r-pill tab" key=${l.id} aria-pressed=${l.id === libId ? 'true' : 'false'} onClick=${() => setLib(l.id)}>${shortTab(l)}</button>`)}</div>
      <div class="r-pills">${shown.map((f) => html`<button type="button" class="r-pill" key=${f.key} aria-pressed=${filters.includes(f.key) ? 'true' : 'false'} onClick=${() => toggle(f.key)}>
        ${filters.includes(f.key) && html`<${Icon} name="check" size=${15} w=${2.6} />`}${f.label}</button>`)}</div>`}
    <div class="r-grid">
      ${items === null ? html`<div class="r-empty wide">Loading…</div>`
        : !items.length ? html`<div class="r-empty wide">${q ? 'Nothing found.' : 'Nothing matches. Try removing a filter.'}</div>`
        : items.map((m) => {
          const name = m.type === 'episode' ? m.showTitle : m.title;
          return html`<button type="button" class="r-poster" key=${m.id} onClick=${() => onOpen(m)} aria-label=${name}>
            <${Poster} src=${m.poster} title=${name}>${m.rating ? html`<span class="rating">★ ${Number(m.rating).toFixed(1)}</span>` : null}<//>
            <span class="t">${name}</span><span class="y">${m.year || ''}</span>
          </button>`;
        })}
    </div>
    ${hasMore && html`<div class="r-empty" ref=${sentinel}>${busy ? 'Loading more…' : ''}</div>`}
    ${!q && html`<div class="r-h2"><h2>Apps</h2></div>
      <div class="r-apps">${APPS.map((a) => html`<button type="button" key=${a.id} onClick=${() => openApp(a)} aria-label=${`Open ${a.name}`}><img src=${`/assets/apps/${a.id}.png`} alt="" /></button>`)}</div>`}
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

function TvRemote() {
  const e = useStore((s) => s.entities) || {};
  const tv = useEntity(e.appleTv);
  const avr = useEntity(e.avr);
  const roomOn = useRoomOn();
  const app = tv?.attributes?.app_id;
  const appName = app === 'com.stremio.one' ? 'Stremio' : app === 'com.netflix.ninja' ? 'Netflix' : isUp(tv) ? (tv?.attributes?.app_name && !/launcher/i.test(tv.attributes.app_name) ? tv.attributes.app_name : 'Home screen') : 'Off';
  const key = (k) => act({ action: 'tv_key', key: k });
  const t = (cmd) => act({ action: 'transport', cmd });
  const vol = avr?.attributes?.volume_level;
  const muted = Boolean(avr?.attributes?.is_volume_muted);
  return html`<div class="r-page">
    <${Top} title="TV Remote" kicker=${`Google TV Streamer · ${appName}`}><${StatusChip} /><//>
    ${!isUp(tv) && html`<div class="r-note" style="margin:0 0 6px">The Streamer is off. ${roomOn ? 'Turn it on under Devices on Home.' : 'Start the cinema first.'}</div>`}
    <div class="r-pad">
      <button type="button" class="up" aria-label="Up" onClick=${() => key('up')}><${Icon} name="chev" size=${30} w=${2.6} /></button>
      <button type="button" class="left" aria-label="Left" onClick=${() => key('left')}><${Icon} name="left" size=${30} w=${2.6} /></button>
      <button type="button" class="ok" aria-label="OK" onClick=${() => key('ok')}>OK</button>
      <button type="button" class="right" aria-label="Right" onClick=${() => key('right')}><${Icon} name="chev" size=${30} w=${2.6} /></button>
      <button type="button" class="down" aria-label="Down" onClick=${() => key('down')}><${Icon} name="chev" size=${30} w=${2.6} /></button>
    </div>
    <div class="r-keys">
      <button type="button" onClick=${() => key('back')}><${Icon} name="left" size=${18} />Back</button>
      <button type="button" onClick=${() => key('home')}><${Icon} name="home" size=${18} />Home</button>
      <button type="button" onClick=${() => t('play_pause')}><${Play} size=${15} />Play / Pause</button>
    </div>
    ${isUp(avr) && html`<div class="r-vol r-vol-card">
      <span class="k">${muted ? 'Muted' : `Vol ${vol == null ? '–' : Math.round(vol * 200) / 2}`}</span>
      <div class="r-bar thin"><i style=${`width:${vol != null ? Math.min(100, vol * 100) : 0}%`}></i></div>
      <button type="button" aria-label="Volume down" onClick=${() => t('vol_down')}>−</button>
      <button type="button" aria-label="Volume up" onClick=${() => t('vol_up')}>+</button>
    </div>`}
  </div>`;
}

// ---------- the app ----------

function Toast() {
  const t = useStore((s) => s.toast);
  return t ? html`<div class=${`r-toast ${t.err ? 'err' : ''}`} role="status">${t.text}</div>` : null;
}

function Remote() {
  const [tab, setTab] = useState(() => (['#watch', '#remote'].includes(location.hash) ? location.hash.slice(1) : 'home'));
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
  return html`<div class="r-app">
    ${connected === false && html`<div class="r-offline">Can't reach the cinema panel. Are you on the home Wi-Fi or Tailscale?</div>`}
    ${tab === 'remote' ? html`<${TvRemote} />` : tab === 'watch' ? html`<${Watch} onOpen=${setSheet} />` : html`<${Home} onOpen=${setSheet} onTab=${setTab} />`}
    <nav class="r-tabs">
      <button type="button" aria-pressed=${tab === 'home' ? 'true' : 'false'} onClick=${() => setTab('home')}><${Icon} name="home" size=${24} />Home</button>
      <button type="button" aria-pressed=${tab === 'watch' ? 'true' : 'false'} onClick=${() => setTab('watch')}><${Icon} name="film" size=${24} />Watch</button>
      <button type="button" aria-pressed=${tab === 'remote' ? 'true' : 'false'} onClick=${() => setTab('remote')}><${Icon} name="remote" size=${24} />Remote</button>
    </nav>
    ${sheet && html`<${TitleSheet} start=${sheet} key=${sheet.id} onClose=${close} />`}
    <${Toast} />
  </div>`;
}

startLive({ navigate: () => {} });
render(html`<${Remote} />`, document.getElementById('app'));

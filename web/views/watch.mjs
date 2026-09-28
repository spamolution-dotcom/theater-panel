// Watch: Plex libraries as a poster grid with filters, and a detail pane that starts playback.

import { useState, useEffect, useRef } from 'preact/hooks';
import { html, Icon, Play, Poster, Seg, Header, useDebounced } from '../lib/ui.mjs';
import { get, act, useLoad, useStore, runtime, endsAt, toast, openTonight } from '../lib/api.mjs';
import { play } from './lobby.mjs';
import { go, route } from '../app.mjs';
import { useNetworks, NetworkPicker, PosterLabels } from './networks.mjs';
import { MysterySheet } from './mystery.mjs';

const FILTERS = [
  { key: 'unwatched', label: 'Unwatched' },
  { key: 'short', label: 'Under 2 hours', movieOnly: true },
  { key: 'family', label: 'Family friendly' },
  { key: '4k', label: '4K', movieOnly: true },
  { key: 'hdr', label: 'HDR', movieOnly: true },
  { key: 'wholeSeason', label: 'Whole season out', showOnly: true },
];
const SORTS = [
  { value: 'added', label: 'Recently added' },
  { value: 'released', label: 'Newest' },
  { value: 'rating', label: 'Top rated' },
  { value: 'random', label: 'Random pick' },
];
const PAGE = 48;
const MAX_ITEMS = 480;   // infinite scroll stops here; the filters are the way to go deeper

export function Watch() {
  const [libs] = useLoad(() => get('/api/plex/libraries'), []);
  const [lib, setLib] = useState(route.params.lib || (route.params.brand ? 'networks' : null));
  const [filters, setFilters] = useState(['unwatched']);
  const [sort, setSort] = useState('added');
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim());
  const [selected, setSelected] = useState(route.params.item || null);
  const [items, setItems] = useState(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [seed, setSeed] = useState(0);
  const [brand, setBrand] = useState(route.params.brand || null);
  const [mystery, setMystery] = useState(false);
  const networks = useNetworks();
  const gridRef = useRef();

  // For you is where Watch opens. "?lib=library" (Browse library on Home) opens Movies instead.
  // This fork has no "For you" or "Networks" tabs (both need Plex/Seerr): My movies is the default.
  const libId = lib === 'library' || lib === 'foryou' || !lib ? libs?.[0]?.id : lib;
  const byNetwork = libId === 'networks';
  const forYou = libId === 'foryou';
  const libType = byNetwork ? null : libs?.find((l) => l.id === libId)?.type;
  const activeFilters = filters.filter((f) => { const d = FILTERS.find((x) => x.key === f); return !(d?.movieOnly && libType !== 'movie') && !(d?.showOnly && libType !== 'show'); }).join(',');
  const brandName = networks.find((n) => n.id === brand)?.name;

  useEffect(() => {
    if (!libId && !q) return;
    if (forYou && !q) { setItems([]); setTotal(0); return; }
    if (byNetwork && !brand && !q) { setItems([]); setTotal(0); return; }
    let live = true;
    setItems(null);
    const req = q ? get(`/api/plex/search?q=${encodeURIComponent(q)}`).then((r) => ({ items: r, total: r.length }))
      : byNetwork ? get(`/api/plex/brand/${brand}?filters=${filters.includes('unwatched') ? 'unwatched' : ''}&size=90`)
      : get(`/api/plex/library/${libId}?filters=${activeFilters}&sort=${sort}&size=${PAGE}`);
    req.then((r) => {
      if (!live) return;
      setItems(r.items); setTotal(r.total);
      if (!selected && r.items[0]) setSelected(r.items[0].id);
      gridRef.current?.scrollTo(0, 0);
    }).catch((e) => live && (setItems([]), toast(e.message, true)));
    return () => { live = false; };
  }, [libId, activeFilters, sort, q, seed, brand, forYou]);

  async function more() {
    if (loadingMore || q || byNetwork || !items || items.length >= Math.min(total, MAX_ITEMS)) return;
    setLoadingMore(true);
    try {
      const r = await get(`/api/plex/library/${libId}?filters=${activeFilters}&sort=${sort}&size=${PAGE}&start=${items.length}`);
      setItems([...items, ...r.items]);
    } finally { setLoadingMore(false); }
  }
  const onScroll = (e) => { const el = e.target; if (el.scrollTop + el.clientHeight > el.scrollHeight - 600) more(); };
  const toggle = (k) => setFilters(filters.includes(k) ? filters.filter((f) => f !== k) : [...filters, k]);
  const libTitle = libs?.find((l) => l.id === libId)?.title;

  return html`<main class="view">
    <${Header} title="Watch" kicker=${q ? `Stremio search · ${total} results` : forYou ? 'Stremio · picked from what you watch' : byNetwork ? `Stremio · ${brandName ? `${brandName} · ${total} titles` : 'Pick a network'}` : `Stremio · ${libTitle || ''}${total ? ` · ${total.toLocaleString()} titles` : ''}`}>
      <label class="search" style="width:420px"><${Icon} name="search" color="var(--muted)" /><span class="sr">Search Stremio</span>
        <input type="search" placeholder="Search films and series" value=${query} onInput=${(e) => setQuery(e.target.value)} />
        ${query && html`<button type="button" class="icon-btn" aria-label="Clear search" style="width:40px;height:40px" onClick=${() => setQuery('')}><${Icon} name="x" size=${20} /></button>`}
      </label>
    <//>
    <div style="display:flex;align-items:center;gap:14px">
      <div style="width:620px;flex-shrink:0">
        <${Seg} cls="scroll" options=${(libs || []).map((l) => ({ value: l.id, label: l.title }))} value=${q ? null : libId} onChange=${(v) => { setQuery(''); setLib(v); setBrand(null); setSelected(null); }} />
      </div>
      <div class="hscroll" style="display:flex;gap:10px;min-width:0">
        ${forYou && !q ? html`<button type="button" class="filter" onClick=${() => setMystery(true)}><${Icon} name="sparkle" size=${18} />Mystery box</button>
          <button type="button" class="filter" onClick=${() => go('year')}><${Icon} name="chart" size=${18} />Year in review</button>` : null}
        ${byNetwork && brand && html`<button type="button" class="filter" onClick=${() => { setBrand(null); setSelected(null); }}><${Icon} name="left" size=${18} />All networks</button>`}
        ${forYou ? null : byNetwork ? html`<button type="button" class="filter" aria-pressed=${filters.includes('unwatched') ? 'true' : 'false'} onClick=${() => toggle('unwatched')}>${filters.includes('unwatched') && html`<${Icon} name="check" size=${18} />`}Unwatched</button>` : FILTERS.filter((f) => !(f.movieOnly && libType === 'show') && !(f.showOnly && libType !== 'show')).map((f) => html`<button type="button" class="filter" aria-pressed=${filters.includes(f.key) ? 'true' : 'false'} disabled=${!!q} onClick=${() => toggle(f.key)}>
          ${filters.includes(f.key) && html`<${Icon} name="check" size=${18} />`}${f.label}</button>`)}
        ${!byNetwork && !forYou && SORTS.map((s) => html`<button type="button" class="filter" aria-pressed=${sort === s.value ? 'true' : 'false'} disabled=${!!q}
          onClick=${() => { setSort(s.value); if (s.value === 'random') setSeed(seed + 1); }}>
          ${s.value === 'random' && html`<${Icon} name="dice" size=${18} />`}${s.label}</button>`)}
      </div>
    </div>
    <div class="watch-body">
      ${forYou && !q ? html`<${ForYou} onPlex=${(id) => setSelected(id)} />`
      : byNetwork && !brand && !q ? html`<div class="scroll" style="flex-grow:1;min-width:0"><${NetworkPicker} networks=${networks} onPick=${(b) => { setBrand(b); setSelected(null); }} hint="Movies and shows in your Plex library from each network." /></div>` : html`
      <div class="poster-grid scroll" ref=${gridRef} onScroll=${onScroll}>
        ${items === null ? html`<div class="empty" style="grid-column:1/-1">Loading…</div>`
          : !items.length ? html`<div class="empty" style="grid-column:1/-1">Nothing matches. Try removing a filter.</div>`
          : items.map((m) => html`<${Tile} key=${m.id} m=${m} selected=${m.id === selected} onSelect=${() => setSelected(m.id)} />`)}
        ${items && items.length >= MAX_ITEMS && items.length < total && html`<div class="empty" style="grid-column:1/-1">Showing the first ${items.length.toLocaleString()} of ${total.toLocaleString()}. Refine the filters to see more.</div>`}
      </div>`}
      ${(byNetwork && !brand && !q) || (forYou && !q && !selected) ? null : selected ? html`<${Detail} id=${selected} key=${selected} onOpen=${setSelected} />` : html`<aside class="detail"><div class="empty" style="flex-grow:1">Pick a title</div></aside>`}
    </div>
    ${mystery && html`<${MysterySheet} onClose=${() => setMystery(false)} />`}
  </main>`;
}

// "You'll love this": rows built from what the house finished lately (server/taste.mjs). A title
// already in Plex opens in the detail pane and plays like anything else; one we do not have goes
// to Request with its name already typed in.
function ForYou({ onPlex }) {
  const [data, err] = useLoad(() => get('/api/taste'), []);
  // The holiday shelf leads the tab while its season lasts ("?season=" tries one out of season).
  const [seasonal] = useLoad(() => get(`/api/seasonal${route.params.season ? `?season=${encodeURIComponent(route.params.season)}` : ''}`).catch(() => null), []);
  const shelves = seasonal?.shelves || [];
  // The account's Plex watchlist: what is owned plays, the rest can be asked for.
  const [wl] = useLoad(() => get('/api/watchlist').catch(() => null), []);
  // Only what the house can actually play: a watchlist row that opens the
  // request form is a different errand from browsing what is here, and this
  // shelf sits among shelves of things to watch now.
  const watchlist = (wl?.items || []).filter((r) => r.owned).slice(0, 24);
  const rows = data?.rows || [];
  if (err) return html`<div class="scroll foryou"><div class="empty">${err.message}</div></div>`;
  if (!data) return html`<div class="scroll foryou"><div class="empty">Reading what you have been watching…</div></div>`;
  if (!rows.length) return html`<div class="scroll foryou"><div class="empty">Nothing to go on yet. Watch something and come back.</div></div>`;
  return html`<div class="scroll foryou">
    ${shelves.map((season) => html`<section class=${`tasterow seasonal ${season.id}`} key=${season.id}>
      <div class="foryou-head"><h2>${season.title}</h2><span>${season.id === 'hallmark' ? season.kicker : `${season.kicker} · ${season.total} films`}</span></div>
      <div class="strip hscroll">
        ${season.items.slice(0, 24).map((r) => html`<button type="button" class="poster-btn" key=${r.id} onClick=${() => onPlex(String(r.id))}>
          <${Poster} src=${r.poster} title=${r.title}>
            ${!r.watched && !r.ribbon && html`<span class="corner" title="Unwatched"></span>`}
            ${r.ribbon && html`<span class="ribbon">${r.ribbon}</span>`}
          <//>
          <span class="t ellipsis">${r.title}</span>
          <span class="y">${r.year || ''}${r.rating ? ` · ${Number(r.rating).toFixed(1)}★` : ''}</span>
        </button>`)}
      </div>
    </section>`)}
    ${watchlist.length ? html`<section class="tasterow seasonal watchlist">
      <div class="strip hscroll">
        ${watchlist.map((r) => html`<button type="button" class="poster-btn" key=${r.tmdbId || r.title}
          onClick=${() => onPlex(String(r.id))}>
          <${Poster} src=${r.poster} title=${r.title}>
            <span class="tag in">In library</span>
          <//>
          <span class="t ellipsis">${r.title}</span>
          <span class="y">${r.year || ''}${r.mediaType === 'tv' ? ' · series' : ''}</span>
        </button>`)}
      </div>
    </section>` : null}
    <div class="foryou-head"><h2>You'll love this</h2><span>Picked from the last few things the house finished</span></div>
    ${rows.map((row) => html`<section class="tasterow" key=${row.seed.id}>
      <div class="seed">
        ${row.seed.poster && html`<img src=${row.seed.poster} alt="" />`}
        <span>${row.seed.loved ? 'You loved' : 'You watched'}<br /><b>${row.seed.title}</b></span>
      </div>
      <div class="strip hscroll">
        ${row.items.map((r) => html`<button type="button" class="poster-btn" key=${r.id}
          onClick=${() => (r.plexKey ? onPlex(String(r.plexKey)) : go('request', { q: r.title }))}>
          <${Poster} src=${r.poster} title=${r.title}>
            ${r.plexKey ? html`<span class="tag in">In library</span>` : r.status !== 'none' ? html`<span class="tag soon">${r.status === 'available' ? 'In library' : 'On its way'}</span>` : html`<span class="tag ask">Request</span>`}
          <//>
          <span class="t ellipsis">${r.title}</span>
          <span class="y">${r.year || ''}${r.rating ? ` · ${r.rating.toFixed(1)}★` : ''}</span>
        </button>`)}
      </div>
    </section>`)}
  </div>`;
}

function Tile({ m, selected, onSelect }) {
  const name = m.type === 'episode' ? m.showTitle : m.title;
  const pct = m.duration && m.viewOffset ? Math.round((m.viewOffset / m.duration) * 100) : 0;
  return html`<button type="button" class="poster-btn" aria-pressed=${selected ? 'true' : 'false'} onClick=${onSelect} aria-label=${`${name} (${m.year || ''})`}>
    <${Poster} src=${m.poster} title=${name}>
      ${!m.watched && !pct && html`<span class="corner" title="Unwatched"></span>`}
      <${PosterLabels} brand=${m.brand} quality=${m.quality} lifted=${pct > 0} />
      ${pct > 0 && html`<span class="prog"><i style=${`width:${pct}%`}></i></span>`}
      ${m.season?.complete && html`<span class="season-out" title=${`Season ${m.season.index}: all ${m.season.total} episodes are here`}>S${m.season.index} complete</span>`}
    <//>
    <span class="t ellipsis">${name}</span>
    <span class="y">${m.type === 'episode' ? `S${m.season} · E${m.episode}` : m.type === 'show' ? (m.season ? `S${m.season.index} · ${m.season.have}/${m.season.total}${m.season.airing ? ' · airing' : ''}` : [m.year, m.leafCount && `${m.leafCount} eps`].filter(Boolean).join(' · ')) : m.year}</span>
  </button>`;
}

function Detail({ id, onOpen }) {
  const [it, err] = useLoad(() => get(`/api/plex/item/${id}`), [id]);
  const [season, setSeason] = useState(null);
  const [subs, setSubs] = useState(undefined);
  const preroll = useStore((s) => s.preroll) || {};
  const [swell, setSwell] = useState(null);       // null: whatever the rule says for this title
  const [eps] = useLoad(() => (season ? get(`/api/plex/episodes/${season}`) : Promise.resolve(null)), [season]);

  if (err) return html`<aside class="detail"><div class="empty" style="flex-grow:1">${err.message}</div></aside>`;
  if (!it) return html`<aside class="detail"><div class="backdrop"></div><div class="empty" style="flex-grow:1">Loading…</div></aside>`;

  const isShow = it.type === 'show' || it.type === 'season';
  const target = isShow ? it.next : it;               // what "Play" starts
  const remaining = target ? (target.duration || 0) - (target.viewOffset || 0) : 0;
  const subOptions = it.subtitles?.length ? [{ value: 0, label: 'Off' }, ...pickSubs(it.subtitles)] : null;
  const currentSub = subs !== undefined ? subs : (it.subtitles?.find((s) => s.selected)?.id ?? 0);
  const meta = [it.year, runtime(it.duration), it.contentRating, ...(it.genres || []).slice(0, 2)].filter(Boolean).join(' · ');
  // The swell belongs before a film, not before the next episode of a sitcom; that is the rule
  // on the settings page, and this button overrides it for the title in front of you.
  const swellByRule = Boolean(preroll.enabled) && !(preroll.moviesOnly && target?.type === 'episode');
  const swellOn = swell ?? swellByRule;

  return html`<aside class="detail">
    <div class="backdrop" style=${it.art ? `background-image:url('${it.art}')` : ''}>
      <div class="t"><h2 class="clamp2">${it.title}</h2></div>
    </div>
    <div class="inner scroll">
      <div class="mono muted" style="font-size:16px">${meta}</div>
      ${(it.badges?.length || it.brand) && html`<div class="detail-badges">
        ${it.brand && html`<span class=${`brand-chip inline b-${it.brand}`}>${networkName(it.brand)}</span>`}
        ${(it.badges || []).map((b) => html`<span class="qb big">${b}</span>`)}</div>`}
      ${(it.directors?.length || it.cast?.length) && html`<div style="font-size:17px" class="ellipsis">${it.directors?.length ? `Dir. ${it.directors.join(', ')} · ` : ''}${(it.cast || []).slice(0, 3).join(', ')}</div>`}
      <p class="clamp3">${it.summary}</p>
      ${isShow ? html`
        ${it.next && html`<div class="endsat"><${Icon} name="film" color="var(--amb)" />Up next: S${it.next.season} · E${it.next.episode} ${it.next.title}</div>`}
        <div class="label">Seasons</div>
        <div class="hscroll" style="display:flex;gap:8px">${(it.seasons || []).map((s) => html`<button type="button" class="filter" aria-pressed=${season === s.id ? 'true' : 'false'} onClick=${() => setSeason(season === s.id ? null : s.id)}>${s.title}</button>`)}</div>
        ${eps && html`<div class="eps">${eps.slice(0, 30).map((e) => html`<button type="button" class="ep" onClick=${() => play(e, true)}>
          <img src=${e.still} alt="" loading="lazy" />
          <span style="min-width:0"><b>${e.episode}. ${e.title}</b><br /><span class="muted mono" style="font-size:14px">${runtime(e.duration)}${e.watched ? ' · watched' : ''}</span></span></button>`)}</div>`}
      ` : html`
        <div class="endsat"><${Icon} name="moon" color="var(--amb)" />${it.viewOffset ? `Resume now, ends at ${endsAt(remaining)}` : `Start now, ends at ${endsAt(remaining)}`}
          <button type="button" class="btn ghost" style="margin-left:auto;height:44px;padding:0 14px" title="Plan the evening around it" onClick=${() => openTonight(it)}><${Icon} name="film" size=${20} />Tonight</button></div>
        ${subOptions && html`<div><div class="label" style="margin-bottom:6px">Subtitles</div><${Seg} options=${subOptions} value=${currentSub} onChange=${setSubs} /></div>`}
      `}
      <div style="flex-grow:1"></div>
      ${preroll.enabled && target && html`<button type="button" class="filter" style="align-self:flex-start" aria-pressed=${swellOn ? 'true' : 'false'} onClick=${() => setSwell(!swellOn)}>
        <${Icon} name="spk" size=${18} />Pre-roll swell${swellOn ? ` · ${preroll.seconds}s` : ''}</button>`}
      ${target ? html`<button type="button" class="btn primary big" onClick=${() => play(target, true, { partId: it.partId, subtitleStreamID: subs, preroll: swellOn })}>
          <${Play} size=${30} />${target.viewOffset ? 'Resume on TV' : 'Open on TV'}</button>`
        : html`<button type="button" class="btn big" disabled>Nothing to play</button>`}
      ${!isShow && it.viewOffset > 0 && html`<button type="button" class="btn sm" onClick=${() => play(it, false, { partId: it.partId, subtitleStreamID: subs, preroll: swellOn })}>Start over</button>`}
    </div>
  </aside>`;
}

// Keep the subtitle choice short: English tracks first, then up to two others. Plex labels look
// like "English SDH (SRT)"; drop the codec and number any labels that still collide.
function pickSubs(list) {
  const en = list.filter((s) => /english/i.test(s.label));
  const others = list.filter((s) => !/english/i.test(s.label)).slice(0, 2);
  const seen = {};
  return [...en.slice(0, 3), ...others].map((s) => {
    let label = s.forced ? 'Forced' : s.label.replace(/\s*\([^)]*\)\s*$/, '').replace(/^English\s+/i, 'English ').slice(0, 16);
    seen[label] = (seen[label] || 0) + 1;
    if (seen[label] > 1) label = `${label} ${seen[label]}`;
    return { value: s.id, label };
  });
}

const NAMES = { netflix: 'Netflix', prime: 'Prime Video', max: 'Max', apple: 'Apple TV+', disney: 'Disney+', hulu: 'Hulu', peacock: 'Peacock', paramount: 'Paramount+' };
const networkName = (id) => NAMES[id] || id;

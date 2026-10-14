// Admin page: the panel's settings, editable from a laptop. Saves to the container's /data
// volume; the panel picks changes up live. Secrets are write-only.

import { h, render } from 'preact';
import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import htm from 'htm';
import { Icon } from '/lib/ui.mjs';
import { EffectPreview, byMood } from '/lib/effects.mjs';

const html = htm.bind(h);
const INPUTS = ['HDMI 1', 'HDMI 2', 'HDMI 3', 'HDMI 4'];

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// The settings are split over pages, picked from the menu down the left. Unsaved edits survive
// moving between pages: one draft holds everything, the page only decides what is on screen.
const PAGES = [
  { id: 'overview', label: 'Overview', icon: 'home' },
  { id: 'connections', label: 'Connections', icon: 'server', groups: ['Home Assistant', 'Home Assistant device', 'TMDB'], blurb: 'Home Assistant, how the panel shows up there as a device, and TMDB (cast, ratings, holiday lists). Stremio signs in from the add-on options.' },
  { id: 'room', label: 'Room', icon: 'bulb', groups: ['Entities', 'Lights'], blurb: 'The Home Assistant entities behind each control, and the favourite moods.' },
  { id: 'projector', label: 'Evening & games', icon: 'pad', groups: ['Projector apps', 'Tonight', 'Games'], blurb: 'Pre-roll and intermission sounds, the evening around a film, and the Xbox.' },
  { id: 'display', label: 'Display', icon: 'eye', groups: ['Display', 'Mystery box', 'Year in review'], blurb: 'Theme, holiday accents, the idle screen, what shows on posters, what the Mystery box may pick, and the December message.' },
  { id: 'access', label: 'Access', icon: 'user', groups: ['Access', 'Seat phone'], blurb: 'Who gets in without the panel key, and the seat phone\'s kids mode PIN.' },
];
const pageFromHash = () => PAGES.find((p) => p.id === location.hash.replace(/^#\/?/, ''))?.id || 'overview';

function App() {
  const [session, setSession] = useState(null);
  const [page, setPage] = useState(pageFromHash());
  useEffect(() => { const on = () => setPage(pageFromHash()); addEventListener('hashchange', on); return () => removeEventListener('hashchange', on); }, []);
  const check = () => api('/api/admin/session').then(setSession).catch((e) => setSession({ error: e.message }));
  useEffect(() => { check(); }, []);
  if (!session) return null;
  if (session.error) return html`<${Shell}><p class="err">${session.error}</p><//>`;
  if (!session.configured) return html`<${Shell}><section class="card"><h2>Admin is off</h2>
    <p>Set <code>ADMIN_PASSWORD</code> on the theater-panel container (Unraid: Edit, Advanced view), then reload this page.</p></section><//>`;
  if (!session.admin) return html`<${Shell}><${Login} onDone=${check} /><//>`;
  return html`<${Settings} page=${page} signOut=${() => api('/api/admin/logout', {}).then(check)} />`;
}

// The frame: menu down the left, the page on the right. `dirtyPages` marks pages with unsaved
// edits so they are not lost behind the menu.
function Shell({ children, signOut, page, dirtyPages = new Set() }) {
  const [build, setBuild] = useState({});
  useEffect(() => { fetch('/api/state').then((r) => r.json()).then((s) => setBuild(s.build || {})).catch(() => {}); }, []);
  return html`<aside class="side">
      <div class="brand"><div><b>Theater panel</b><span>${build.version ? `v${build.version}` : 'Settings'}</span></div></div>
      ${signOut && html`<nav class="menu">${PAGES.map((p) => html`<a href=${`#/${p.id}`} aria-current=${page === p.id ? 'page' : undefined}>
          <${Icon} name=${p.icon} size=${20} />${p.label}${dirtyPages.has(p.id) && html`<i class="dot" title="Unsaved changes"></i>`}</a>`)}</nav>`}
      <div class="grow"></div>
      ${signOut && html`<nav class="menu foot"><a href="/" target="_blank" rel="noopener"><${Icon} name="screen" size=${20} />Open panel</a>
        <button type="button" onClick=${signOut}><${Icon} name="x" size=${20} />Sign out</button></nav>`}
    </aside>
    <main>${children}</main>`;
}

function Login({ onDone }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await api('/api/admin/login', { password: pw }); onDone(); } catch (x) { setErr(x.message); }
    setBusy(false);
  }
  return html`<form class="card login" onSubmit=${submit}>
    <h2>Sign in</h2>
    <label>Admin password<input type="password" autocomplete="current-password" value=${pw} onInput=${(e) => setPw(e.target.value)} autofocus /></label>
    ${err && html`<p class="err">${err}</p>`}
    <button type="submit" class="primary" disabled=${busy || !pw}>${busy ? 'Signing in…' : 'Sign in'}</button>
  </form>`;
}

function Settings({ page, signOut }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});        // key -> string (secrets: new value or '')
  const [clear, setClear] = useState({});        // secret key -> true to remove the saved one
  const [games, setGames] = useState(null);
  const [gamesDirty, setGamesDirty] = useState(false);
  const [entities, setEntities] = useState([]);
  const [status, setStatus] = useState(null);    // { ok, text }
  const [busy, setBusy] = useState(false);

  async function load() {
    const d = await api('/api/admin/settings');
    setData(d);
    setDraft(Object.fromEntries(d.fields.map((f) => [f.key, f.type === 'secret' || f.type === 'plexlogin' ? '' : d.values[f.key].saved])));
    setClear({});
    setGames(structuredClone(d.games)); setGamesDirty(false);
  }
  useEffect(() => { load().catch((e) => setStatus({ ok: false, text: e.message })); }, []);
  useEffect(() => { api('/api/admin/entities').then(setEntities).catch(() => setEntities([])); }, []);
  useEffect(() => { setStatus(null); scrollTo(0, 0); }, [page]);

  const fieldDirty = (f) => (f.type === 'secret' || f.type === 'plexlogin' ? draft[f.key] !== '' || Boolean(clear[f.key]) : draft[f.key] !== data.values[f.key].saved);
  const dirtyPages = useMemo(() => {
    const out = new Set();
    if (!data) return out;
    for (const p of PAGES) if (p.groups && data.fields.some((f) => p.groups.includes(f.group) && fieldDirty(f))) out.add(p.id);
    if (gamesDirty) out.add('projector');
    return out;
  }, [data, draft, clear, gamesDirty]);
  const dirty = dirtyPages.size > 0;

  useEffect(() => {
    const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!data) return html`<${Shell} page=${page} signOut=${signOut}><p class="muted">${status?.text || 'Loading…'}</p><//>`;

  const set = (k, v) => setDraft({ ...draft, [k]: v });

  async function save() {
    setBusy(true); setStatus(null);
    // Only what changed, so nothing else is touched.
    const values = {};
    for (const f of data.fields) {
      if (f.type === 'secret' || f.type === 'plexlogin') { if (clear[f.key]) values[f.key] = null; else if (draft[f.key]) values[f.key] = draft[f.key]; }
      else if (draft[f.key] !== data.values[f.key].saved) values[f.key] = draft[f.key];
    }
    // Switcher rows that still name an option are saved as its input number.
    const opts = entities.find((e) => e.id === games?.switcher?.entity)?.options || [];
    const outGames = games && { ...games, sources: games.sources.map((s) => (s.via === 'switcher' && !s.input && opts.includes(s.option) ? { ...s, input: opts.indexOf(s.option) + 1, option: undefined } : s)) };
    try {
      await api('/api/admin/settings', { rev: data.rev, values, ...(gamesDirty ? { games: outGames } : {}) });
      await load();
      setStatus({ ok: true, text: 'Saved. The panel picks it up right away.' });
    } catch (e) { setStatus({ ok: false, text: e.message }); }
    setBusy(false);
  }

  async function importAll() {
    if (!confirm(`Copy ${data.fromContainer.length} setting(s)${data.gamesSource === 'file' ? ' and the games.json sources' : ''} from the container into this page?`)) return;
    setBusy(true);
    try {
      const r = await api('/api/admin/import', { rev: data.rev });
      await load();
      setStatus({ ok: true, text: `Copied ${r.copied.length} setting(s). You can now delete them from the container (keep ADMIN_PASSWORD).` });
    } catch (e) { setStatus({ ok: false, text: e.message }); }
    setBusy(false);
  }
  const pending = data.fromContainer.length > 0 || data.gamesSource === 'file';
  const REQUIRED = ['HA_URL', 'HA_TOKEN'];
  const isSet = (k) => { const v = data.values[k]; return typeof v.saved === 'boolean' ? v.saved || v.container : Boolean(v.saved || v.container); };
  const missing = REQUIRED.filter((k) => !isSet(k));
  const current = PAGES.find((p) => p.id === page) || PAGES[0];

  const panelLink = data.panelKey ? `${location.origin}/?key=${encodeURIComponent(data.panelKey)}` : location.origin;
  const overview = html`
    <h1>Overview</h1>
    <section class="card link">
      <div><b>Panel link</b>
        <small>${data.panelKey ? 'The panel and any browser need this once; after that a cookie keeps them signed in.' : 'No panel key: anyone who can reach this address can control the room.'}</small>
        <code class="linkbox">${panelLink}</code></div>
      <button type="button" onClick=${() => navigator.clipboard?.writeText(panelLink).then(() => setStatus({ ok: true, text: 'Link copied' }), () => {})}>Copy link</button>
    </section>
    ${missing.length > 0 && html`<section class="card missing"><b>Not set anywhere:</b> ${missing.map((k) => html`<code>${k}</code> `)}
      <small>The panel can't reach these services until they're filled in under Connections.</small></section>`}
    ${pending && html`<section class="card import"><div><b>${data.fromContainer.length} setting(s)${data.gamesSource === 'file' ? ' and the game sources' : ''} still come from the container.</b>
      <small>Import copies them here, tokens included, so you can delete the container's variables afterwards. Keep ADMIN_PASSWORD on the container.</small></div>
      <button type="button" class="primary" disabled=${busy || dirty} onClick=${importAll}>Import from container</button></section>`}
    <section class="card">
      <div class="card-head"><h2>Services</h2></div>
      <div class="services">
        ${[['Home Assistant', 'HA_URL'], ['TMDB', 'TMDB_API_KEY']].map(([n, k]) => html`
          <a class=${`svc ${isSet(k) ? 'on' : ''}`} href="#/connections"><span class="dot"></span>${n}<small>${isSet(k) ? (data.values[k].saved || data.values[k].container || 'configured') : 'not set'}</small></a>`)}
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Pages</h2></div>
      <div class="pages">${PAGES.filter((p) => p.groups).map((p) => html`<a class="pg" href=${`#/${p.id}`}><${Icon} name=${p.icon} size=${22} /><div><b>${p.label}</b><small>${p.blurb}</small></div></a>`)}</div>
    </section>
    <p class="intro">${pending ? '' : 'Everything is saved here; the container only needs ADMIN_PASSWORD. '}Values on these pages override the container's settings; a blank field falls back to the container's value, shown in grey.</p>`;

  return html`<${Shell} page=${page} signOut=${signOut} dirtyPages=${dirtyPages}>
    ${page === 'overview' ? overview : html`
      <h1>${current.label}</h1>
      <p class="intro">${current.blurb}</p>
      ${current.groups.map((g) => html`<section class="card" id=${g.toLowerCase().replace(/\W+/g, '-')}>
        <div class="card-head"><h2>${g}</h2>${TESTS[g] && html`<${Test} service=${TESTS[g]} draft=${draft} label=${TEST_LABELS[TESTS[g]]} />`}</div>
        ${data.fields.filter((f) => f.group === g).map((f) => html`<${Field} f=${f} value=${draft[f.key]} base=${data.values[f.key]} entities=${entities}
          cleared=${clear[f.key]} onClear=${(v) => setClear({ ...clear, [f.key]: v })} onChange=${(v) => set(f.key, v)} />`)}
      </section>`)}`}
    <div class=${`savebar ${dirty || status ? 'show' : ''}`}>
      <span class=${status ? (status.ok ? 'ok' : 'err') : 'muted'}>${status ? status.text : dirty ? `Unsaved changes on ${[...dirtyPages].map((id) => PAGES.find((p) => p.id === id).label).join(', ')}` : 'All changes saved'}</span>
      <span class="grow"></span>
      <button type="button" disabled=${!dirty || busy} onClick=${load}>Discard</button>
      <button type="button" class="primary" disabled=${!dirty || busy} onClick=${save}>${busy ? 'Saving…' : 'Save'}</button>
    </div>
  <//>`;
}

const TESTS = { 'Home Assistant': 'ha', Plex: 'plex', Seerr: 'seerr', TMDB: 'tmdb', 'Year in review': 'wrapped' };
const TEST_LABELS = { wrapped: 'Send it now (test)' };

// Tries the connection with the values on screen, saved or not.
function Test({ service, draft, label = 'Test connection' }) {
  const [r, setR] = useState(null);
  async function run() {
    setR({ busy: true });
    try { setR(await api('/api/admin/test', { service, values: draft })); } catch (e) { setR({ ok: false, detail: e.message }); }
  }
  return html`<div class="test">${r && !r.busy && html`<span class=${r.ok ? 'ok' : 'err'}>${r.ok ? '✓' : '✕'} ${r.detail}</span>`}
    <button type="button" class="small" disabled=${r?.busy} onClick=${run}>${r?.busy ? 'Working…' : label}</button></div>`;
}

function Field({ f, value, base, entities, cleared, onClear, onChange }) {
  const id = `f-${f.key}`;
  const note = f.help && html`<small>${f.help}</small>`;
  const label = html`<span class="lbl">${f.label}<code>${f.key}</code></span>`;

  if (f.type === 'plexlogin') return html`<div class="field">${label}<${PlexLogin} saved=${Boolean(base.saved || base.container)} onClear=${onClear} cleared=${cleared} />${note}</div>`;
  if (f.type === 'secret') {
    const has = base.saved ? 'saved here' : base.container ? 'set on the container' : null;
    return html`<div class="field"><label for=${id}>${label}</label>
      <div class="row"><input id=${id} type="password" autocomplete="new-password" placeholder=${cleared ? 'Will be removed' : has ? `•••••••• (${has})` : 'Not set'} value=${value} onInput=${(e) => onChange(e.target.value)} />
      ${base.saved && html`<button type="button" class="small" onClick=${() => onClear(!cleared)}>${cleared ? 'Keep' : 'Remove'}</button>`}</div>${note}</div>`;
  }
  if (f.type === 'bool') {
    const eff = value === '' ? (base.container === '' ? String(f.default) : base.container) : value;
    return html`<div class="field check"><label><input type="checkbox" checked=${eff === 'true'} onChange=${(e) => onChange(String(e.target.checked))} />${label}</label>
      ${value !== '' && html`<button type="button" class="link" onClick=${() => onChange('')}>Use container value</button>`}${note}</div>`;
  }
  if (f.type === 'range') {
    const eff = value === '' ? (base.container === '' ? f.default : Number(base.container)) : Number(value);
    return html`<div class="field"><label for=${id}>${label}<b class="val">${eff}${f.unit || ''}</b></label>
      <div class="row"><input id=${id} type="range" min=${f.min ?? 0} max=${f.max ?? 100} step=${f.step ?? 1} value=${eff} onInput=${(e) => onChange(e.target.value)} />
      ${value !== '' && html`<button type="button" class="link" onClick=${() => onChange('')}>Reset</button>`}</div>${note}</div>`;
  }
  if (f.type === 'select') {
    return html`<div class="field"><label for=${id}>${label}</label>
      <select id=${id} value=${value} onChange=${(e) => onChange(e.target.value)}>
        <option value="">${`Container value (${(f.options.find((o) => o[0] === base.container) || f.options[0])[1]})`}</option>
        ${f.options.map(([v, t]) => html`<option value=${v}>${t}</option>`)}
      </select>${note}</div>`;
  }
  if (f.type === 'effects') return html`<div class="field">${label}<${EffectFavourites} value=${value} base=${base.container} onChange=${onChange} />${note}</div>`;
  if (f.type === 'libraries') return html`<div class="field">${label}<${LibraryPicker} value=${value} base=${base.container} onChange=${onChange} />${note}</div>`;
  if (f.type === 'apps') return html`<div class="field">${label}<${AppsEditor} value=${value || base.container} onChange=${onChange} />${note}</div>`;
  if (f.type === 'list' && f.domain) {
    return html`<div class="field">${label}<${EntityList} value=${value} base=${base.container} domain=${f.domain} entities=${entities} onChange=${onChange} />${note}</div>`;
  }
  const list = f.type === 'entity' ? `dl-${f.domain}` : undefined;
  return html`<div class="field"><label for=${id}>${label}</label>
    <input id=${id} type="text" spellcheck="false" list=${list} placeholder=${base.container || (f.fallback ? `Default: ${f.fallback}` : f.placeholder ? `Not set (e.g. ${f.placeholder})` : 'Not set')} value=${value} onInput=${(e) => onChange(e.target.value)} />
    ${list && html`<${EntityOptions} id=${list} domain=${f.domain} entities=${entities} />`}
    ${f.type === 'entity' && value && entities.length > 0 && !entities.some((x) => x.id === value) && html`<small class="err">Home Assistant has no ${value}</small>`}
    ${note}</div>`;
}

function EntityOptions({ id, domain, entities }) {
  return html`<datalist id=${id}>${entities.filter((e) => e.id.startsWith(`${domain}.`)).map((e) => html`<option value=${e.id}>${e.name}</option>`)}</datalist>`;
}

// Entity lists as chips; blank means the container's list.
function EntityList({ value, base, domain, entities, onChange }) {
  const [add, setAdd] = useState('');
  const own = value ? value.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const shown = own || (base ? base.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const put = (arr) => onChange(arr.join(','));
  const name = (id) => entities.find((e) => e.id === id)?.name;
  return html`<div class="chips">
    ${shown.map((id, i) => html`<span class=${`chip ${own ? '' : 'inherited'}`}>${name(id) ? html`${name(id)} <code>${id}</code>` : html`<code>${id}</code>`}
      <button type="button" aria-label=${`Remove ${id}`} onClick=${() => put(shown.filter((_, k) => k !== i))}>×</button></span>`)}
    <form class="row" onSubmit=${(e) => { e.preventDefault(); if (add.trim()) { put([...shown, add.trim()]); setAdd(''); } }}>
      <input type="text" spellcheck="false" list=${`dl-${domain}`} placeholder=${`Add a ${domain}`} value=${add} onInput=${(e) => setAdd(e.target.value)} />
      <${EntityOptions} id=${`dl-${domain}`} domain=${domain} entities=${entities} />
      <button type="submit" class="small">Add</button>
      ${own && html`<button type="button" class="link" onClick=${() => onChange('')}>Use container value</button>`}
    </form>
    ${!own && shown.length > 0 && html`<small>From the container. Changing it saves your own list here.</small>`}
  </div>`;
}

// Up to 8 favourite effects, in order, picked from whatever the lights offer. Each row shows the
// same animation the panel draws.
const MAX_FAVS = 8;
function EffectFavourites({ value, base, onChange }) {
  const [all, setAll] = useState(null);
  useEffect(() => { api('/api/admin/light-effects').then(setAll).catch(() => setAll([])); }, []);
  const split = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
  const own = value ? split(value) : null;
  const picked = own || split(base);
  const put = (arr) => onChange(arr.slice(0, MAX_FAVS).join(','));
  const toggle = (name) => (picked.includes(name) ? put(picked.filter((p) => p !== name)) : picked.length < MAX_FAVS && put([...picked, name]));
  const move = (i, d) => { const n = [...picked]; [n[i], n[i + d]] = [n[i + d], n[i]]; put(n); };
  const groups = byMood(all || []);
  return html`<div class="fx-pick">
    <div class="chosen">
      ${picked.map((name, i) => html`<div class=${`fav ${own ? '' : 'inherited'}`}>
        <${EffectPreview} name=${name} h=${26} still=${true} />
        <span class="ellipsis">${name}</span>
        <button type="button" class="icon" aria-label="Move up" disabled=${i === 0} onClick=${() => move(i, -1)}>↑</button>
        <button type="button" class="icon" aria-label="Move down" disabled=${i === picked.length - 1} onClick=${() => move(i, 1)}>↓</button>
        <button type="button" class="icon" aria-label=${`Remove ${name}`} onClick=${() => toggle(name)}>×</button>
      </div>`)}
      ${!picked.length && html`<p class="muted">None picked: the panel shows its own defaults.</p>`}
      <small>${picked.length} of ${MAX_FAVS}${own ? '' : ' (from the container)'}</small>
    </div>
    ${all === null ? html`<p class="muted">Loading effects…</p>`
      : !all.length ? html`<p class="muted">No effects found. The lights must be reachable in Home Assistant.</p>`
      : groups.map((g) => html`<div class="group"><div class="gname">${g.name}</div>
          <div class="opts">${g.effects.map((name) => html`<button type="button" class=${`opt ${picked.includes(name) ? 'on' : ''}`}
            aria-pressed=${picked.includes(name) ? 'true' : 'false'} disabled=${!picked.includes(name) && picked.length >= MAX_FAVS} onClick=${() => toggle(name)}>
            <${EffectPreview} name=${name} h=${22} still=${true} /><span class="ellipsis">${name}</span></button>`)}</div></div>`)}
  </div>`;
}

// Plex libraries as ordered chips, added from a dropdown of the server's libraries.
function LibraryPicker({ value, base, onChange }) {
  const [libs, setLibs] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { api('/api/admin/plex-libraries').then(setLibs).catch((e) => { setLibs([]); setErr(e.message); }); }, []);
  const split = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const own = value ? split(value) : null;
  const shown = own || split(base);
  const put = (arr) => onChange(arr.join(','));
  const move = (i, d) => { const n = [...shown]; [n[i], n[i + d]] = [n[i + d], n[i]]; put(n); };
  const type = (t) => libs?.find((l) => l.title === t)?.type;
  const left = (libs || []).filter((l) => !shown.includes(l.title));
  return html`<div class="chips">
    ${shown.length === 0 && html`<span class="muted">Every movie and TV library</span>`}
    ${shown.map((t, i) => html`<span class=${`chip ${own ? '' : 'inherited'}`}>${t}${type(t) && html` <code>${type(t) === 'show' ? 'TV' : 'movies'}</code>`}
      ${libs && !type(t) && html` <code class="err">not in Plex</code>`}
      <button type="button" aria-label=${`Move ${t} left`} disabled=${i === 0} onClick=${() => move(i, -1)}>‹</button>
      <button type="button" aria-label=${`Move ${t} right`} disabled=${i === shown.length - 1} onClick=${() => move(i, 1)}>›</button>
      <button type="button" aria-label=${`Remove ${t}`} onClick=${() => put(shown.filter((_, k) => k !== i))}>×</button></span>`)}
    <div class="row">
      <select value="" disabled=${!left.length} onChange=${(e) => { if (e.target.value) put([...shown, e.target.value]); e.target.value = ''; }}>
        <option value="">${libs === null ? 'Loading libraries…' : err || !libs.length ? 'Plex not reachable' : left.length ? 'Add a library…' : 'All libraries added'}</option>
        ${left.map((l) => html`<option value=${l.title}>${l.title} (${l.type === 'show' ? 'TV' : 'movies'})</option>`)}
      </select>
      ${own && html`<button type="button" class="link" onClick=${() => onChange('')}>Use container value</button>`}
    </div>
    ${(err || (libs && !libs.length)) && html`<small class="err">Can't list Plex's libraries${err ? `: ${err}` : ''}. Save the Plex URL and token first.</small>`}
    ${!own && shown.length > 0 && html`<small>From the container. Changing it saves your own list here.</small>`}
  </div>`;
}

function AppsEditor({ value, onChange }) {
  const rows = (value || '').split(',').map((p) => p.split('=').map((x) => x.trim())).filter((r) => r[0] || r[1]);
  const sent = useRef(value);
  const put = (rs) => { sent.current = rs.filter((r) => r[0] && r[1]).map((r) => (r[2] ? `${r[0]}=${r[1]}=${r[2]}` : `${r[0]}=${r[1]}`)).join(','); onChange(sent.current); };
  const [draft, setDraft] = useState(rows);
  // Only take rows from `value` when it changed elsewhere (a reset, a reload). put() drops
  // half-edited rows, so rebuilding the draft from our own echo would delete a row the moment
  // its package field is cleared to retype it.
  useEffect(() => { if (value !== sent.current) setDraft(rows); }, [value]);
  const edit = (i, k, v) => { const n = draft.map((r) => [...r]); n[i][k] = v; setDraft(n); put(n); };
  const move = (i, d) => { const n = [...draft]; [n[i], n[i + d]] = [n[i + d], n[i]]; setDraft(n); put(n); };
  return html`<table class="grid"><thead><tr><th>Name</th><th>Android package</th><th>Icon</th><th></th></tr></thead><tbody>
    ${draft.map((r, i) => html`<tr>
      <td><input type="text" value=${r[0]} onInput=${(e) => edit(i, 0, e.target.value)} /></td>
      <td><input type="text" spellcheck="false" value=${r[1]} placeholder="com.example.app" onInput=${(e) => edit(i, 1, e.target.value)} /></td>
      <td><${IconPicker} value=${r[2] || ''} onChange=${(v) => edit(i, 2, v)} /></td>
      <td class="actions"><${RowActions} i=${i} n=${draft.length} move=${move} remove=${() => { const n = draft.filter((_, k) => k !== i); setDraft(n); put(n); }} /></td></tr>`)}
    </tbody></table>
    <button type="button" class="small" onClick=${() => setDraft([...draft, ['', '']])}>Add app</button>`;
}

// An icon: built-in names are listed, anything "prefix:name" comes from HA's icon sets via the panel.
const BUILTIN = { tv: 'Built-in TV', server: 'Built-in server', monitor: 'Built-in monitor', pad: 'Built-in gamepad', joystick: 'Built-in joystick', remote: 'Built-in remote', steam: 'Built-in play' };
function IconPreview({ name }) {
  if (!name) return html`<span class="ipv empty"></span>`;
  if (!name.includes(':')) return html`<span class="ipv builtin" title=${name}><${Icon} name=${name === 'monitor' ? 'screen' : name === 'steam' ? 'playc' : name} size=${22} /></span>`;
  const [p, n] = name.split(':');
  return html`<span class="ipv" title=${name} style=${`--src:url('/api/icon/${p}/${n}.svg')`}></span>`;
}

// Search every icon set (mdi, Custom Brand Icons, Font Awesome brands...) and pick one.
function IconPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const box = useRef();
  // Click or tap anywhere outside the picker closes it without changing the icon.
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => api(`/api/admin/icons?q=${encodeURIComponent(q)}`).then(setRes).catch(() => setRes({ icons: [], sets: [] })), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, open]);
  return html`<div class="ipick" ref=${box}>
    <button type="button" class="small ipbtn" onClick=${() => { setOpen(!open); setQ(value && value.includes(':') ? value.split(':')[1] : ''); }}><${IconPreview} name=${value} /><span>${value || 'Pick'}</span></button>
    ${open && html`<div class="ipop" onKeyDown=${(e) => e.key === 'Escape' && setOpen(false)}>
      <input type="text" autofocus spellcheck="false" placeholder="Search icons, e.g. xbox, apple tv, mdi:plex" value=${q} onInput=${(e) => setQ(e.target.value)} />
      <div class="igrid">
        ${!q && Object.keys(BUILTIN).map((b) => html`<button type="button" title=${BUILTIN[b]} onClick=${() => { onChange(b); setOpen(false); }}><${IconPreview} name=${b} /><small>${b}</small></button>`)}
        ${res?.icons.map((id) => html`<button type="button" title=${id} aria-pressed=${id === value ? 'true' : 'false'} onClick=${() => { onChange(id); setOpen(false); }}><${IconPreview} name=${id} /><small>${id}</small></button>`)}
        ${q && res && !res.icons.length && html`<p class="muted">No icons match.</p>`}
      </div>
      ${res?.sets?.length > 0 && html`<small>Searching ${res.sets.length} sets: ${res.sets.slice(0, 8).join(', ')}${res.sets.length > 8 ? '…' : ''}. Type "set:" to search one, e.g. cbi:plex.</small>`}
    </div>`}
  </div>`;
}

function RowActions({ i, n, move, remove }) {
  return html`<button type="button" class="icon" aria-label="Move up" disabled=${i === 0} onClick=${() => move(i, -1)}>↑</button>
    <button type="button" class="icon" aria-label="Move down" disabled=${i === n - 1} onClick=${() => move(i, 1)}>↓</button>
    <button type="button" class="icon" aria-label="Remove" onClick=${remove}>×</button>`;
}

// Sources on the projector card and the Games screen: inputs wired straight to the projector,
// and consoles on the HDMI switcher (a select entity in HA, e.g. the ESP32 node or OREI integration).
function GamesEditor({ games, source, entities, onChange }) {
  const g = games || { switcher: {}, sources: [] };
  const put = (patch) => onChange({ ...g, ...patch });
  const edit = (i, patch) => put({ sources: g.sources.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const move = (i, d) => { const n = [...g.sources]; [n[i], n[i + d]] = [n[i + d], n[i]]; put({ sources: n }); };
  // The switcher's inputs as HA names them; older rows that stored a name map to its number.
  const switchOptions = entities.find((e) => e.id === g.switcher?.entity)?.options || [];
  const inputOf = (s) => s.input || (s.option && switchOptions.indexOf(s.option) + 1) || 0;
  return html`<div class="games">
    <h3>Sources</h3>
    ${source === 'file' && html`<small>Loaded from games.json. Saving here stores them with the other settings, and games.json is then ignored.</small>`}
    <div class="two">
      <label>HDMI switcher (select entity)<input type="text" spellcheck="false" list="dl-select" value=${g.switcher?.entity || ''} onInput=${(e) => put({ switcher: { ...g.switcher, entity: e.target.value } })} /></label>
      <${EntityOptions} id="dl-select" domain="select" entities=${entities} />
      <label>Switcher's projector input<select value=${g.switcher?.projectorInput || 'HDMI 3'} onChange=${(e) => put({ switcher: { ...g.switcher, projectorInput: e.target.value } })}>${INPUTS.map((x) => html`<option>${x}</option>`)}</select></label>
    </div>
    <table class="grid"><thead><tr><th>Name</th><th>Connected to</th><th>Input</th><th>Icon</th><th title="Show on the Games screen">Games</th><th></th></tr></thead><tbody>
      ${g.sources.map((s, i) => html`<tr>
        <td><input type="text" value=${s.name} onInput=${(e) => edit(i, { name: e.target.value })} /></td>
        <td><select value=${s.via} onChange=${(e) => edit(i, { via: e.target.value })}><option value="projector">Projector</option><option value="switcher">HDMI switcher</option></select></td>
        <td>${s.via === 'switcher'
          ? html`<select value=${String(inputOf(s) || '')} onChange=${(e) => edit(i, { input: Number(e.target.value), option: undefined })}>
              ${!inputOf(s) && html`<option value="">${s.option ? `"${s.option}" (pick its input)` : 'Pick an input'}</option>`}
              ${[1, 2, 3, 4].map((n) => html`<option value=${n}>Input ${n}${switchOptions[n - 1] ? ` · ${switchOptions[n - 1]}` : ''}</option>`)}
            </select>`
          : html`<select value=${s.projectorInput || 'HDMI 2'} onChange=${(e) => edit(i, { projectorInput: e.target.value })}>${INPUTS.map((x) => html`<option>${x}</option>`)}</select>`}</td>
        <td><${IconPicker} value=${s.icon || 'pad'} onChange=${(v) => edit(i, { icon: v })} /></td>
        <td class="center"><input type="checkbox" aria-label="Show on the Games screen" checked=${s.games !== false} onChange=${(e) => edit(i, { games: e.target.checked ? undefined : false })} /></td>
        <td class="actions"><${RowActions} i=${i} n=${g.sources.length} move=${move} remove=${() => put({ sources: g.sources.filter((_, k) => k !== i) })} /></td></tr>`)}
    </tbody></table>
    <button type="button" class="small" onClick=${() => put({ sources: [...g.sources, { name: '', via: 'switcher', icon: 'pad' }] })}>Add source</button>
    <small>Every source is on the projector card, in this order; untick Games to keep one off the Games screen. Switcher inputs are by number; their names come from the switcher's select in Home Assistant.</small>
  </div>`;
}

render(html`<${App} />`, document.getElementById('admin'));

// Signing in to plex.tv for the watchlist: the server asks plex.tv for a code, the person
// approves it on plex.tv in a new tab, and the token lands in the settings on its own.
function PlexLogin({ saved, onClear, cleared }) {
  const [who, setWho] = useState(null);
  const [pin, setPin] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { if (saved) api('/api/admin/plex-account').then(setWho).catch(() => setWho(null)); }, [saved]);
  useEffect(() => {
    if (!pin) return;
    const t = setInterval(async () => {
      try {
        const r = await api(`/api/admin/plex-pin/${pin.id}`);
        if (r.done) { clearInterval(t); setPin(null); setWho({ username: r.username }); location.reload(); }
      } catch (e) { clearInterval(t); setPin(null); setErr(e.message); }
    }, 3000);
    return () => clearInterval(t);
  }, [pin]);
  async function start() {
    setErr(null);
    try { const p = await api('/api/admin/plex-pin', {}); setPin(p); window.open(p.url, '_blank', 'noopener'); }
    catch (e) { setErr(e.message); }
  }
  if (saved && !cleared) return html`<div class="plexlogin">
    <span class="ok">✓ Signed in${who?.username ? ` as ${who.username}` : ''}${who?.error ? ` (${who.error})` : ''}</span>
    <button type="button" class="small" onClick=${onClear}>Sign out</button></div>`;
  return html`<div class="plexlogin">
    ${pin ? html`<span>Finish signing in on the plex.tv page that opened (or <a href=${pin.url} target="_blank" rel="noopener">open it</a>). Waiting…</span>`
      : html`<button type="button" class="small" onClick=${start}>Sign in to Plex</button>`}
    ${cleared && html`<span class="muted">Signing out when you save.</span>`}
    ${err && html`<span class="err">${err}</span>`}</div>`;
}

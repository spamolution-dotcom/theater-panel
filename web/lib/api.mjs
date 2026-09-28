// Talking to the panel server: JSON fetches, actions, and a live store fed by the SSE stream.

import { useEffect, useRef, useState } from 'preact/hooks';

export async function get(path) {
  const r = await fetch(path);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

export async function post(path, data) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

// Fire an action; failures surface as a toast instead of throwing into the UI.
export async function act(data) {
  try { return await post('/api/action', data); }
  catch (e) { toast(e.message, true); return null; }
}

// ---------- live store ----------

let state = { vote: null, sleep: null, mystery: null, rate: null, preroll: {}, streams: [], connected: null, haConnected: false, haConfigured: true, states: {}, sessions: [], entities: {}, ui: {}, theater: null, toast: null };
const listeners = new Set();
function set(patch) { state = { ...state, ...patch }; listeners.forEach((l) => l()); }
export const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
// Re-render only when the selected slice changes (compared shallowly by JSON for objects).
export function useStore(select = (s) => s) {
  const [, force] = useState(0);
  const last = useRef();
  const sel = useRef(select);
  sel.current = select;           // the selector changes when its inputs do (useEntity(id))
  const value = select(state);
  last.current = value;
  useEffect(() => subscribe(() => {
    const next = sel.current(state);
    if (next === last.current) return;                       // same object: nothing to do
    if (typeof next === 'object' && next !== null && JSON.stringify(next) === JSON.stringify(last.current)) return;
    force((x) => x + 1);
  }), []);
  return value;
}
export const getState = () => state;
// Theater mode availability/state, set by app.mjs once Kiosk Satellite answers (or not).
export const setTheater = (theater) => set({ theater });
// Something worth a cheer just happened (a request landed): the app throws confetti.
export const celebrate = () => set({ celebrateAt: Date.now() });
// The spoken pick has been seen; the next "surprise me" is a fresh one.
export const clearMystery = () => set({ mystery: null });
// The panel's own settings sheet, opened by seven taps on the version number in the rail.
export const openTweaks = () => set({ tweaks: true });
export const closeTweaks = () => set({ tweaks: false });
// Tonight's plan sheet (the Tonight chip, a film's page) and the guest remote's QR sheet.
export const openTonight = (item = null) => set({ tonightOpen: { item } });
export const closeTonight = () => set({ tonightOpen: null });
export const openGuest = () => set({ guestOpen: true });
export const closeGuest = () => set({ guestOpen: false });
export const openSound = () => set({ soundOpen: true });
export const closeSound = () => set({ soundOpen: false });

let toastTimer;
export function toast(text, err = false) {
  clearTimeout(toastTimer);
  set({ toast: { text, err } });
  toastTimer = setTimeout(() => set({ toast: null }), 3500);
}

let onNavigate = null;
let bootBuild = null;
export async function startLive({ navigate } = {}) {
  onNavigate = navigate;
  const loadSettings = () => get('/api/state').then((s) => set({ entities: s.entities, services: s.services, ui: s.ui || {}, projectorApps: s.projectorApps || [], effectFavourites: s.effectFavourites || [], build: s.build || {}, idleMinutes: s.idleMinutes ?? 8, hallway: s.hallway || {}, sleep: s.sleep || null, preroll: s.preroll || {}, intermission: s.intermission || {}, projectorHotC: s.projectorHotC || 65, soundbar: s.soundbar || {} })).catch(() => {});
  const loadTonight = () => get('/api/tonight').then((d) => set({ tonight: d?.item ? d : null })).catch(() => {});
  loadSettings();
  get('/api/rate').then((v) => set({ rate: v?.id ? v : null })).catch(() => {});   // one may be waiting from before this panel loaded
  // EventSource only retries by itself on a dropped connection. A non-200 answer (502/503 while
  // the container restarts, 401 once the tp_key cookie lapses) closes it for good, so on CLOSED
  // we open a fresh one with backoff; the panel runs unattended and must not stay "offline"
  // until someone reloads it. If nothing has worked for 10 minutes, reload the whole page.
  let es, offlineTimer, retryTimer, retryMs = 1000, downSince = null;
  const RELOAD_AFTER_MS = 10 * 60 * 1000;
  const connect = () => {
    // Open the live stream before anything else so it gets a connection ahead of the posters.
    es = new EventSource('/api/events');
    es.addEventListener('hello', (e) => {
      const d = JSON.parse(e.data);
      // The server is a different build from the one this page came from (a deploy restarted it
      // and the live connection found its way back): the app reloads itself at the next quiet
      // moment rather than running yesterday's page against today's server.
      if (d.build) {
        bootBuild ??= d.build;
        if (d.build !== bootBuild) set({ stale: d.build });
      }
      set({ connected: true, haConnected: d.ha.connected, haConfigured: d.ha.configured, states: d.ha.states, sessions: d.sessions, streams: d.streams || [] });
    });
    es.addEventListener('states', (e) => {
      const changed = JSON.parse(e.data);
      const states = { ...state.states };
      for (const [id, s] of Object.entries(changed)) { if (s) states[id] = s; else delete states[id]; }
      set({ states });
    });
    es.addEventListener('ha', (e) => set({ haConnected: JSON.parse(e.data).connected }));
    es.addEventListener('sessions', (e) => set({ sessions: JSON.parse(e.data), sessionsAt: Date.now() }));
    // Everything playing on the Plex server, behind the "N streams" pill.
    es.addEventListener('streams', (e) => set({ streams: JSON.parse(e.data) }));
    // Saved on the admin page: pick up the new entities, apps and display options.
    es.addEventListener('settings', loadSettings);
    loadTonight();
    // The sleep timer, armed from Showtime and counted down by the server.
    es.addEventListener('sleep', (e) => {
      const d = JSON.parse(e.data);
      set({ sleep: d.mode ? d : null });
      if (d.fired) toast(`Room off ${d.fired}`);
    });
    // "Surprise me" from voice or an automation: the server picked, the panel reveals it.
    es.addEventListener('mystery', (e) => set({ mystery: JSON.parse(e.data) }));
    // A sound the room's speaker could not take (it is asleep): the wall panel plays it.
    es.addEventListener('sound', (e) => set({ sound: { ...JSON.parse(e.data), at: Date.now() } }));
    // A film just finished: the panel asks how it was.
    es.addEventListener('rate', (e) => set({ rate: JSON.parse(e.data) }));
    // Tonight's plan: the film, the time, where the evening is. {} when there is none.
    es.addEventListener('tonight', (e) => { const d = JSON.parse(e.data); set({ tonight: d?.item ? d : null }); });
    // Movie night: the shortlist and the running tally.
    es.addEventListener('vote', (e) => set({ vote: JSON.parse(e.data) }));
    // Home Assistant (or anything with access to the panel's API) can move the panel to a route.
    es.addEventListener('navigate', (e) => { const d = JSON.parse(e.data); onNavigate?.(d.route); });
    // EventSource reconnects by itself; only call it offline if that has not worked after 8 s.
    es.onerror = () => {
      downSince = downSince || Date.now();
      if (Date.now() - downSince > RELOAD_AFTER_MS) { location.reload(); return; }
      clearTimeout(offlineTimer);
      offlineTimer = setTimeout(() => { if (es.readyState !== EventSource.OPEN) set({ connected: false }); }, 8000);
      if (es.readyState !== EventSource.CLOSED) return;
      es.close();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30000);
    };
    es.onopen = () => {
      clearTimeout(offlineTimer);
      // Settings saved while the stream was down were announced to nobody: fetch them now.
      if (downSince) loadSettings();
      downSince = null; retryMs = 1000;
      set({ connected: true });
    };
  };
  connect();
}

export const useEntity = (id) => useStore((s) => (id ? s.states[id] : undefined));

// What the theater is playing, whichever box plays it. Films in Plezy run on the projector's own
// Android, where the Apple TV sees nothing, so the theater's Plex session (PLEX_PLAYER_NAME) comes
// first and the Apple TV is the fallback. Returns 'playing', 'paused', 'buffering', or the Apple
// TV's own state ('idle', 'off', ...) when no film is running.
export function playbackState(s = state) {
  const session = s.sessions?.[0];
  if (session?.state) return session.state;
  return s.states[s.entities?.appleTv]?.state;
}

// Load data once per key; returns [data, error, reload].
// Loads once and again when the deps change. A load that fails is retried with backoff until
// it succeeds, and one that failed is run again the moment the live stream comes back or the
// page is shown again: a wall panel waking from its screensaver reloads while its network and
// Plex are still coming up, and without this a row sat at "Loading Plex..." until someone
// cleared the cache. A refresh that fails keeps what was already showing.
export function useLoad(fn, deps) {
  const [res, setRes] = useState({ data: undefined, error: null });
  const [n, setN] = useState(0);
  const failed = useRef(false);
  useEffect(() => {
    let live = true; let timer; let wait = 3000;
    const run = () => fn().then(
      (data) => { if (!live) return; failed.current = false; setRes({ data, error: null }); },
      (error) => {
        if (!live) return;
        failed.current = true;
        setRes((r) => ({ data: r.data ?? null, error }));
        timer = setTimeout(run, wait); wait = Math.min(wait * 2, 60000);
      });
    setRes((r) => ({ data: r.data, error: null }));
    run();
    return () => { live = false; clearTimeout(timer); };
  }, [...deps, n]);
  useEffect(() => {
    const again = () => { if (failed.current) setN((x) => x + 1); };
    const onVisible = () => { if (document.visibilityState === 'visible') again(); };
    document.addEventListener('visibilitychange', onVisible);
    let wasConnected = state.connected;
    const unsub = subscribe(() => { if (state.connected && !wasConnected) again(); wasConnected = state.connected; });
    return () => { document.removeEventListener('visibilitychange', onVisible); unsub(); };
  }, []);
  return [res.data, res.error, () => setN((x) => x + 1)];
}

// ---------- small helpers ----------

export const clock = (d = new Date()) => {
  const h = d.getHours() % 12 || 12;
  return { hm: `${h}:${String(d.getMinutes()).padStart(2, '0')}`, ampm: d.getHours() < 12 ? 'AM' : 'PM' };
};
export const endsAt = (remainingMs) => { const c = clock(new Date(Date.now() + remainingMs)); return `${c.hm} ${c.ampm}`; };
export const runtime = (ms) => {
  if (!ms) return '';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
export const mmss = (sec) => {
  if (sec == null || Number.isNaN(sec)) return '';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

// HA's media_position is as of media_position_updated_at; extrapolate while playing.
export function livePosition(st) {
  const a = st?.attributes || {};
  if (a.media_position == null) return null;
  let pos = a.media_position;
  if (st.state === 'playing' && a.media_position_updated_at) pos += (Date.now() - Date.parse(a.media_position_updated_at)) / 1000;
  return Math.min(pos, a.media_duration || pos);
}

// The Christmas countdown, from the first of November: "31 days until Christmas", "Christmas
// Eve", "Merry Christmas" on the day, and nothing the rest of the year. "?countdown=1" on a route
// shows it out of season.
export function christmasCountdown(now = new Date(), force = false) {
  const m = now.getMonth(), d = now.getDate();
  if (!force && !(m === 10 || (m === 11 && d <= 25))) return null;
  const xmas = new Date(now.getFullYear(), 11, 25);
  const today = new Date(now.getFullYear(), m, d);
  const days = Math.round((xmas - today) / 864e5);
  if (days < 0) return null;
  if (days === 0) return { days, text: 'Merry Christmas' };
  if (days === 1) return { days, text: "Christmas Eve" };
  return { days, text: `${days} days to Christmas` };
}

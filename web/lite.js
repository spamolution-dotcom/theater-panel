// The seat remote for an old iPad (/lite): the phone remote's Home, Watch, Games and Remote tabs,
// kids mode and all, written for Safari 12 (iOS 12). The other pages need a newer browser (import
// maps, `?.`, flex `gap`), so this one is plain script with no build step and no framework:
// - no optional chaining, `??`, class fields or `catch {}` without a name
// - no pointer events (Safari 13): touch events, with mouse events for a desktop browser
// - layout spacing with grid gaps and margins, never flex `gap`
// It is always the seat remote: every action carries seat:true, so the server applies kids mode.
// Held sideways (landscape) it lays out like the hallway board: tabs down a rail on the left, Home
// in two columns, and while a film plays a Now Showing screen (poster, synopsis, transport,
// D-pad); the Xbox gets the same with its game poster. Held upright it is the portrait layout.
// Same server, same actions as /remote; see web/remote.mjs for the behaviour this mirrors.
(function () {
  'use strict';

  var SEAT = new URLSearchParams(location.search).get('seat') !== '0';
  var IDLE_MS = 3 * 60e3;    // untouched this long: back to the tab that fits what's on
  var SWITCH_MS = 60e3;      // a change (Xbox on, a film playing) moves the page if untouched this long
  var PAGE = 36;
  var MAX_ITEMS = 360;
  var XBOX_INPUT = 'Xbox One';

  var SCENES = [
    { name: 'pre_show', label: 'Pre-show', desc: 'Warm lights · music', icon: 'music' },
    { name: 'movie_time', label: 'Movie time', desc: 'Lights down', icon: 'film' },
    { name: 'intermission', label: 'Intermission', desc: 'Pause · lights 30%', icon: 'cup' },
    { name: 'lights_up', label: 'Lights up', desc: 'Lights 100%', icon: 'sun' },
  ];
  var SCENE_OF = { 'Pre-show': 'pre_show', 'Movie time': 'movie_time', Intermission: 'intermission', 'Lights up': 'lights_up' };
  var APPS = [{ id: 'netflix', name: 'Netflix' }, { id: 'prime', name: 'Prime Video' }, { id: 'youtube', name: 'YouTube' }, { id: 'stremio', name: 'Stremio' }];
  var FILTERS = [{ key: 'unwatched', label: 'Unwatched' }, { key: 'short', label: 'Under 2h', movieOnly: true }, { key: 'family', label: 'Family' }];
  var SORTS = [{ value: 'added', label: 'Recently added' }, { value: 'released', label: 'Newest' }, { value: 'rating', label: 'Top rated' }, { value: 'random', label: 'Random' }];

  // ---------- small helpers ----------

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function or(v, d) { return v == null ? d : v; }
  function attrs(st) { return (st && st.attributes) || {}; }
  function isUp(st) { return Boolean(st) && ['off', 'unavailable', 'unknown', 'standby'].indexOf(st.state) < 0; }
  function nameOf(m) { return m.showTitle || m.title; }
  function runtime(ms) {
    if (!ms) return '';
    var m = Math.round(ms / 60000);
    return m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm';
  }
  function mmss(sec) {
    if (sec == null || isNaN(sec)) return '';
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0');
  }
  function endsAt(ms) {
    var d = new Date(Date.now() + ms);
    var h = d.getHours() % 12 || 12;
    return h + ':' + String(d.getMinutes()).padStart(2, '0') + (d.getHours() < 12 ? ' am' : ' pm');
  }
  function livePosition(st) {
    var a = attrs(st);
    if (a.media_position == null) return null;
    var pos = a.media_position;
    if (st.state === 'playing' && a.media_position_updated_at) pos += (Date.now() - Date.parse(a.media_position_updated_at)) / 1000;
    return Math.min(pos, a.media_duration || pos);
  }

  var PATHS = {
    home: 'M3 11l9-8 9 8v10h-6v-6H9v6H3z',
    film: 'M3 4h18v16H3zM7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4',
    music: 'M9 18V5l11-2v13M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM17 13a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
    power: 'M12 3v9M6.3 7.5a8 8 0 1 0 11.4 0',
    check: 'M5 12l5 5 9-10',
    volm: 'M3 9h4l5-4v14l-5-4H3zM16 12h6',
    volp: 'M3 9h4l5-4v14l-5-4H3zM16 12h6M19 9v6',
    mute: 'M3 9h4l5-4v14l-5-4H3zM16 9l6 6M22 9l-6 6',
    sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    cup: 'M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 10h2a2 2 0 0 1 0 4h-2M8 3v2M12 3v2',
    x: 'M6 6l12 12M18 6L6 18',
    chev: 'M9 6l6 6-6 6',
    lock: 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11',
    unlock: 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 6.6-1.6',
    down: 'M6 9l6 6 6-6',
    left: 'M15 6l-6 6 6 6',
    pad: 'M6 11h4M8 9v4M15 12h.01M18 10h.01M17.3 5H6.7a4 4 0 0 0-3.96 3.43l-.9 6.3A2.5 2.5 0 0 0 4.3 17.6h.2a2.5 2.5 0 0 0 2.12-1.18L7.6 15h8.8l.98 1.42A2.5 2.5 0 0 0 19.5 17.6h.2a2.5 2.5 0 0 0 2.46-2.87l-.9-6.3A4 4 0 0 0 17.3 5z',
    remote: 'M9 2h6a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM12 5v3M10.5 6.5h3M12 12h.01M12 15h.01M11 19h2',
    tv: 'M3 5h18v12H3zM8 21h8M12 17v4',
    receiver: 'M2.5 7h19v10h-19zM17 9.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM5.5 11h6M5.5 13.5h4',
    projector: 'M2.5 8h19v9h-19zM15.5 9.9a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2zM6 11h3M6 17v2M18 17v2',
    blindOpen: 'M3 3.5h18M5 3.5V20.5h14V3.5M5 6.5h14M12 6.5v2.5',
    blindMovie: 'M3 3.5h18M5 3.5V20.5h14V3.5M5 7h14M5 10h14M5 13h14M12 13v2.5',
    blindClose: 'M3 3.5h18M5 3.5V20.5h14V3.5M5 7h14M5 10h14M5 13h14M5 16h14M5 19h14',
    back: 'M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5',
    cast: 'M3 17a4 4 0 0 1 4 4M3 13a8 8 0 0 1 8 8M3 9.5V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4',
  };
  function icon(name, size, w) {
    size = size || 24;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (w || 2) +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + PATHS[name] + '"/></svg>';
  }
  // The panel's images (/img/...) with a marker only this page adds. Images are cached for a year
  // under their address, and the iPad kept WebP copies it cannot draw from before the server sent
  // it JPEGs (server/images.mjs); a new address makes it fetch them again. The server ignores it.
  function imgSrc(src) {
    if (!src || String(src).indexOf('/img/') !== 0) return src;
    return src + (src.indexOf('?') >= 0 ? '&' : '?') + 'lite=1';
  }
  function playIcon(size) { return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>'; }
  function pauseIcon(size) { return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="4" width="4.5" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4.5" height="16" rx="1" fill="currentColor"/></svg>'; }

  // ---------- talking to the server ----------

  function request(path, data) {
    var opts = data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) };
    opts.credentials = 'same-origin';
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || 'HTTP ' + r.status);
        return body;
      });
    });
  }
  function get(path) { return request(path); }
  function post(path, data) { return request(path, data || {}); }
  function act(data) {
    if (SEAT) data.seat = true;
    return post('/api/action', data).catch(function (e) { toast(e.message, true); return null; });
  }

  // Data loaded once per key and kept: cache[key] = { v, err, at }. A failed load is tried again
  // after 15 s. Anything waiting on it repaints when it lands.
  var cache = {};
  function load(key, fn) {
    var c = cache[key];
    if (c && (c.v !== undefined || c.busy || (c.err && Date.now() - c.at < 15000))) return c;
    c = cache[key] = { v: c ? c.v : undefined, err: null, busy: true, at: Date.now() };
    fn().then(function (v) { c.v = v; c.err = null; }, function (e) { c.err = e; })
      .then(function () { c.busy = false; c.at = Date.now(); paint(); });
    return c;
  }
  function forget(key) { delete cache[key]; }

  // ---------- live state (the panel's event stream) ----------

  var S = { connected: null, states: {}, sessions: [], sessionsAt: Date.now(), entities: {}, ui: {}, seat: null, sleep: null };
  var bootBuild = null;
  var staleBuild = false;
  function loadSettings() {
    get('/api/state').then(function (s) { S.entities = s.entities || {}; S.ui = s.ui || {}; S.sleep = s.sleep && s.sleep.mode ? s.sleep : null; paint(); }).catch(function () {});
  }
  function startLive() {
    loadSettings();
    var es, offlineTimer, retryTimer, retryMs = 1000, downSince = null;
    function connect() {
      es = new EventSource('/api/events');
      es.addEventListener('hello', function (e) {
        var d = JSON.parse(e.data);
        if (d.build) { if (bootBuild == null) bootBuild = d.build; else if (d.build !== bootBuild) staleBuild = true; }
        S.connected = true; S.states = (d.ha && d.ha.states) || {}; S.sessions = d.sessions || []; S.sessionsAt = Date.now(); S.seat = d.seat || null;
        paint();
      });
      es.addEventListener('states', function (e) {
        var changed = JSON.parse(e.data);
        Object.keys(changed).forEach(function (id) { if (changed[id]) S.states[id] = changed[id]; else delete S.states[id]; });
        paint();
      });
      es.addEventListener('seat', function (e) { S.seat = JSON.parse(e.data); paint(); });
      es.addEventListener('sleep', function (e) { var d = JSON.parse(e.data); S.sleep = d.mode ? d : null; paint(); });
      es.addEventListener('sessions', function (e) { S.sessions = JSON.parse(e.data) || []; S.sessionsAt = Date.now(); paint(); });
      es.addEventListener('settings', loadSettings);
      es.onerror = function () {
        downSince = downSince || Date.now();
        if (Date.now() - downSince > 10 * 60e3) { location.reload(); return; }
        clearTimeout(offlineTimer);
        offlineTimer = setTimeout(function () { if (es.readyState !== EventSource.OPEN) { S.connected = false; paint(); } }, 8000);
        if (es.readyState !== EventSource.CLOSED) return;
        es.close();
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30000);
      };
      es.onopen = function () {
        clearTimeout(offlineTimer);
        if (downSince) loadSettings();
        downSince = null; retryMs = 1000;
        S.connected = true; paint();
      };
    }
    connect();
  }

  function st(id) { return id ? S.states[id] : undefined; }
  function roomOn() { var s = st(S.entities.roomOn); return Boolean(s && s.state === 'on'); }
  function gaming() {
    var e = S.entities;
    if (!e || roomOn()) return false;
    var avr = st(e.avr);
    return Boolean(avr && avr.state === 'on' && attrs(avr).source === XBOX_INPUT);
  }
  function kids() { return Boolean(SEAT && S.seat && S.seat.enabled && S.seat.locked); }
  function hasXbox() { return Boolean(S.entities.xbox && st(S.entities.xbox)); }

  // What the Streamer is showing (web/lib/streamer.mjs).
  var STREAM_APPS = [
    [/^com\.netflix\./, 'netflix', 'Netflix'], [/^com\.stremio\./, 'stremio', 'Stremio'],
    [/^com\.google\.android\.youtube/, 'youtube', 'YouTube'], [/^com\.teamsmart\.videomanager/, 'youtube', 'YouTube'],
    [/^com\.amazon\.amazonvideo/, 'prime', 'Prime Video'], [/^com\.spotify\./, null, 'Spotify'], [/^com\.disney\./, null, 'Disney+'],
    [/^com\.plexapp\./, null, 'Plex'], [/launcher/, null, 'Home screen'], [/mediashell/, null, 'Casting'],
  ];
  var CAST_KEYS = { Netflix: 'netflix', YouTube: 'youtube', Stremio: 'stremio', 'Prime Video': 'prime' };
  function streamerNow(tv, cast) {
    if (!isUp(tv)) return { on: false, name: 'Off', key: null };
    var pkg = attrs(tv).app_id || '';
    var hit = null;
    for (var i = 0; i < STREAM_APPS.length; i++) if (STREAM_APPS[i][0].test(pkg)) { hit = STREAM_APPS[i]; break; }
    var c = cast && ['playing', 'paused', 'buffering', 'idle'].indexOf(cast.state) >= 0 ? cast : null;
    var ca = attrs(c);
    var name = hit && !/mediashell/.test(pkg) ? hit[2] : ca.app_name || (hit ? hit[2] : 'An app');
    var key = (hit && hit[1]) || CAST_KEYS[ca.app_name] || null;
    var same = Boolean(c) && (!hit || hit[2] === ca.app_name || /mediashell|launcher/.test(pkg) || ca.app_name === 'Music Assistant');
    return { on: true, name: name, key: key, home: name === 'Home screen' && !same,
      title: same ? ca.media_title || '' : '', artist: same ? ca.media_artist || ca.media_series_title || '' : '',
      state: same ? c.state : null, cast: same ? c : null };
  }
  function castVideo(cast) {
    if (!cast || ['playing', 'paused'].indexOf(cast.state) < 0) return false;
    var a = attrs(cast);
    if (a.media_content_type === 'music') return false;
    return !/music assistant|spotify/i.test(a.app_name || '');
  }
  function playbackState() {
    var session = S.sessions[0];
    if (session && session.state) return session.state;
    var tv = st(S.entities.appleTv);
    var cast = st(S.entities.streamerCast);
    if (tv && tv.state === 'on' && castVideo(cast)) return cast.state;
    return tv ? tv.state : undefined;
  }
  // `active`: a film or show is playing or paused (not the home screen or a stream list).
  function media() {
    var e = S.entities;
    var tv = st(e.appleTv);
    var session = S.ui && S.ui.theaterSessions ? S.sessions[0] : undefined;
    var now = streamerNow(tv, st(e.streamerCast));
    var state = session ? playbackState() : now.state || playbackState();
    var shown = roomOn() && Boolean(session || isUp(tv));
    var active = shown && (state === 'playing' || state === 'paused') && (Boolean(session) || !now.home);
    return { e: e, tv: tv, session: session, now: now, state: state, shown: shown, active: active };
  }

  // ---------- page state ----------

  var U = { tab: 'home', sheet: null, season: null, pin: null };
  var LAND = window.innerWidth > window.innerHeight;   // held sideways: the landscape layout
  var MODE = '';            // the landscape full screens: 'now' (a film playing), 'gplay' (Xbox on)
  var VS = null;            // the volume slider while it's dragged and just after: { pct, until }
  var CW = 0;               // which Continue watching card is showing
  var REG = {};             // items on screen by id, for the tap handlers
  var armed = {};           // two-tap buttons: key -> expiry
  var picked = null;        // { name, at }: the scene just tapped, lit until HA says so
  var wantSource = null;
  var gBusyUntil = 0;
  function reg(m) { REG[m.id] = m; return esc(m.id); }
  function isArmed(k) { return (armed[k] || 0) > Date.now(); }
  function arm(k) { armed[k] = Date.now() + 4000; setTimeout(paint, 4100); }

  var toastTimer;
  var toastNow = null;
  function toast(text, err) {
    clearTimeout(toastTimer);
    toastNow = { text: text, err: Boolean(err) };
    paint();
    toastTimer = setTimeout(function () { toastNow = null; paint(); }, 3500);
  }

  function playItem(item, resume) {
    var on = roomOn();
    return act({ action: 'play', ratingKey: item.id, type: item.type, title: nameOf(item), offset: resume ? item.viewOffset : 0 }).then(function (r) {
      if (!r) return false;
      toast(!on ? 'Starting the cinema · ' + nameOf(item) + ' opens in about a minute'
        : r.preroll ? 'Lights down… ' + nameOf(item) + ' in ' + r.preroll + 's' : 'Opening ' + nameOf(item) + ' on the TV · pick a stream with the remote');
      return true;
    });
  }

  // Kids mode: which titles show, asked of the server (G and PG) and remembered.
  var kidsOk = {};
  var kidsAsked = {};
  function kidsFilter(items) {
    if (!kids() || !items) return { list: items, checking: false };
    var need = items.filter(function (m) { return m && m.id && !(m.id in kidsOk); });
    if (need.length) {
      var ask = need.filter(function (m) { return !kidsAsked[m.id]; });
      if (ask.length) {
        ask.forEach(function (m) { kidsAsked[m.id] = true; });
        post('/api/ratings', { items: ask.map(function (m) { return { id: m.id, type: m.type }; }) })
          .then(function (r) { var ok = r.ok || {}; Object.keys(ok).forEach(function (k) { kidsOk[k] = ok[k]; }); })
          .catch(function () { ask.forEach(function (m) { kidsOk[m.id] = false; }); })
          .then(function () { ask.forEach(function (m) { delete kidsAsked[m.id]; }); paint(); });
      }
      return { list: null, checking: true };
    }
    return { list: items.filter(function (m) { return kidsOk[m.id]; }), checking: false };
  }

  // ---------- pieces ----------

  // A tap on Home's title reloads the page: there is no address bar or reload button from the
  // home screen, and Guided Access stops it being closed and reopened.
  function top(title, kicker, right, reload) {
    // In landscape the Kids badge lives at the foot of the rail instead.
    return '<header class="l-top"><div><div class="l-kick">' + esc(kicker) + '</div><h1' + (reload ? ' data-a="reload"' : '') + '>' + esc(title) + '</h1></div><div class="l-topr">' + (LAND ? '' : badge()) + (right || '') + '</div></header>';
  }
  function badge() {
    var s = S.seat;
    if (!SEAT || !s || !s.enabled) return '';
    if (!s.locked) {
      var mins = Math.max(1, Math.ceil(((s.until || 0) - Date.now()) / 60e3));
      return '<button type="button" class="l-lock open" data-a="relock">' + icon('unlock', 16, 2.4) + mins + 'm</button>';
    }
    // A tap opens the PIN pad (holding it was hard to get right on the iPad); the PIN still guards it.
    return '<button type="button" class="l-lock" data-a="pinopen">' + icon('lock', 16, 2.4) + 'Kids</button>';
  }
  function statusChip() {
    var warm = st(S.entities.warmupScript);
    var warming = Boolean(warm && warm.state === 'on');
    var on = roomOn(), g = gaming();
    var cls = warming ? 'warm' : on || g ? 'on' : '';
    return '<span class="l-chip ' + cls + '"><span class="dot"></span>' + (warming ? 'Starting…' : on ? 'Cinema on' : g ? 'Xbox on' : 'Cinema off') + '</span>';
  }
  function poster(src, title, extra) {
    return '<div class="poster"><div class="fallback">' + esc(title) + '</div>' + (src ? '<img src="' + esc(imgSrc(src)) + '" alt="">' : '') + (extra || '') + '</div>';
  }

  function nowPlaying(inRemote) {
    var m = media();
    if (!m.shown) return '';
    var session = m.session, now = m.now, tv = m.tv;
    var avr = st(m.e.avr);
    var playing = m.state === 'playing';
    var a = attrs(tv);
    var app = (session && session.app) || now.key;
    var title = (session && (session.showTitle || session.title)) || now.title || a.media_title || now.name;
    var sub = session && session.showTitle ? 'S' + session.season + ' · E' + session.episode + ' ' + session.title : now.title ? [now.artist, now.name].filter(Boolean).join(' · ') : '';
    var dur = session && session.duration ? session.duration / 1000 : attrs(now.cast).media_duration || a.media_duration || null;
    var pos = null;
    if (session && session.viewOffset != null) pos = session.viewOffset / 1000 + (playing ? (Date.now() - S.sessionsAt) / 1000 : 0);
    else pos = livePosition(now.cast || tv);
    var left = dur && pos != null && dur - pos > 1 ? dur - pos : null;
    var label = playing ? 'Now playing' : m.state === 'paused' ? 'Paused' : m.state === 'choosing' ? 'Pick a stream on the TV' : now.home ? 'Nothing playing' : 'On the TV';
    var vol = attrs(avr).volume_level;
    var muted = Boolean(attrs(avr).is_volume_muted);
    var art = session && session.poster ? '<img src="' + esc(imgSrc(session.poster)) + '" alt="">' : app ? '<img class="app" src="/assets/apps/' + esc(app) + '.png" alt="">' : icon('tv', 34);
    var info = [sub, left != null ? (runtime(left * 1000) || mmss(left)) + ' left · ends ' + endsAt(left * 1000) : ''].filter(Boolean).join(' · ');
    return '<section class="l-np' + (inRemote ? ' mini' : '') + '">' +
      // In landscape a tap on the artwork opens Now Showing.
      '<div class="l-np-art"' + (LAND && !inRemote ? ' data-a="tab" data-v="remote"' : '') + '>' + art + '</div>' +
      '<div class="l-np-body">' +
        '<div class="l-kick">' + label + '</div>' +
        '<div class="l-np-title">' + esc(title) + '</div>' +
        '<div class="l-np-sub">' + esc(info) + '</div>' +
        (dur && pos != null ? '<div class="l-bar"><i style="width:' + Math.min(100, (pos / dur) * 100) + '%"></i></div>' : '') +
        '<div class="l-ctl">' +
          '<button type="button" data-a="t" data-v="back10">−10</button>' +
          '<button type="button" class="pp" data-a="t" data-v="play_pause">' + (playing ? pauseIcon(26) : playIcon(26)) + '</button>' +
          '<button type="button" data-a="t" data-v="fwd30">+30</button>' +
          (!inRemote ? '<button type="button" class="pad" data-a="tab" data-v="remote" aria-label="TV remote">' + icon('remote', 24) + '</button>' : '') +
        '</div>' +
        (isUp(avr) ? '<div class="l-vol"><span class="k">' + (muted ? 'Muted' : 'Vol ' + (vol == null ? '–' : Math.round(vol * 200) / 2)) + '</span>' +
          '<div class="l-bar thin"><i style="width:' + (vol != null ? Math.min(100, vol * 100) : 0) + '%"></i></div>' +
          '<button type="button" data-a="t" data-v="vol_down">−</button><button type="button" data-a="t" data-v="vol_up">+</button></div>' : '') +
      '</div></section>';
  }

  function shelf(title, link, items, empty) {
    var body;
    if (!items) body = '<div class="l-empty">Loading…</div>';
    else if (!items.length) body = '<div class="l-empty">' + esc(empty) + '</div>';
    else body = '<div class="l-shelf">' + items.map(function (m) {
      var pct = m.duration && m.viewOffset ? Math.min(100, Math.round((m.viewOffset / m.duration) * 100)) : 0;
      var extra = (m.rating ? '<span class="rating">★ ' + Number(m.rating).toFixed(1) + '</span>' : '') + (pct > 0 ? '<span class="prog"><i style="width:' + pct + '%"></i></span>' : '');
      return '<button type="button" class="l-poster" data-a="open" data-id="' + reg(m) + '">' + poster(m.poster, nameOf(m), extra) +
        '<span class="t">' + esc(nameOf(m)) + '</span><span class="y">' + esc(m.type === 'episode' && m.season ? 'S' + m.season + ' · E' + m.episode : m.year || '') + '</span></button>';
    }).join('') + '</div>';
    return '<section><div class="l-h2"><h2>' + esc(title) + '</h2>' + (link || '') + '</div>' + body + '</section>';
  }

  function scenes() {
    var tracked = st('input_select.theater_scene');
    var hasActive = roomOn() ? SCENE_OF[tracked && tracked.state] : undefined;
    if (picked && (picked.name === hasActive || Date.now() - picked.at > 60000)) picked = null;
    var active = picked ? picked.name : hasActive;
    var list = SCENES.filter(function (sc) { return !kids() || ['pre_show', 'movie_time'].indexOf(sc.name) < 0; });
    var off = roomOn() || gaming();
    return '<section><div class="l-h2"><h2>Scenes</h2></div><div class="l-scn-grid">' + list.map(function (sc) {
      return '<button type="button" class="l-scn' + (sc.name === active ? ' on' : '') + '" data-a="scene" data-v="' + sc.name + '">' + icon(sc.icon, 26) +
        '<span><b>' + sc.label + '</b><s>' + sc.desc + '</s></span></button>';
    }).join('') +
      '</div>' +
      (off ? '<button type="button" class="l-alloff' + (isArmed('alloff') ? ' armed' : '') + '" data-a="alloff">' + icon('power', 22) + (isArmed('alloff') ? 'Tap again to turn everything off' : 'All off') + '</button>' : '') +
      '</section>';
  }

  var SLEEP_OPTS = [['end', 'After this', 'When the film ends'], ['30', '30 min', ''], ['60', '60 min', ''], ['90', '90 min', '']];
  function sleepText() {
    var sl = S.sleep;
    if (!sl) return 'Set a timer';
    if (sl.mode === 'end') return 'Off after this';
    return 'Off in ' + Math.max(1, Math.ceil(((sl.at || 0) - Date.now()) / 60e3)) + ' min';
  }
  function sleepSheet() {
    var sl = S.sleep;
    return '<div class="l-back" data-a="sleepclose" data-self="1"><div class="l-sheet l-pin"><div class="grab"></div><h3>Sleep timer</h3><p>Turn the cinema off</p>' +
      '<div class="l-scn-grid">' + SLEEP_OPTS.map(function (o) {
        var on = sl && (o[0] === 'end' ? sl.mode === 'end' : sl.mode === 'timer' && String(sl.minutes) === o[0]);
        return '<button type="button" class="l-scn' + (on ? ' on' : '') + '" data-a="sleeppick" data-v="' + o[0] + '"><span><b>' + o[1] + '</b>' + (o[2] ? '<s>' + o[2] + '</s>' : '') + '</span></button>';
      }).join('') + '</div>' +
      (sl ? '<button type="button" class="l-play2" data-a="sleeppick" data-v="off">Cancel the timer</button>' : '') + '</div></div>';
  }

  function devices() {
    var e = S.entities;
    var avr = st(e.avr), proj = st(e.projectorPower), tv = st(e.appleTv);
    var vol = Math.round((attrs(avr).volume_level || 0) * 100);
    var list = [
      { id: 'projector', name: 'Projector', icon: 'projector', ok: isUp(proj), note: isUp(proj) ? 'On' : 'Off' },
      { id: 'denon', name: 'Denon', icon: 'receiver', ok: isUp(avr), note: isUp(avr) ? 'On · ' + vol : 'Off' },
      { id: 'chromecast', name: 'Chromecast', icon: 'cast', ok: isUp(tv), note: streamerNow(tv, st(e.streamerCast)).name },
    ];
    var html = '<section><div class="l-h2"><h2>Devices</h2></div><div class="l-devs">' + list.map(function (d) {
      var k = 'dev:' + d.id;
      return '<button type="button" class="l-dev' + (d.ok ? ' ok' : '') + (isArmed(k) ? ' armed' : '') + '" data-a="dev" data-v="' + d.id + '" data-on="' + (d.ok ? 1 : 0) + '" data-name="' + d.name + '">' +
        icon(d.icon, 28) + '<b>' + d.name + '</b><span>' + esc(isArmed(k) ? 'Tap again' : d.note) + '</span></button>';
    }).join('') + '</div>';
    if (isUp(avr)) html += source(avr);
    return html + '</section>';
  }
  function source(avr) {
    var src = attrs(avr).source;
    if (wantSource && wantSource === src) wantSource = null;
    var cur = wantSource || src;
    return '<div class="l-h2"><h2>Source</h2><span class="l-aside">Denon input</span></div><div class="l-seg">' +
      [['GoogleTVStreamer', 'Chromecast', 'cast'], [XBOX_INPUT, 'Xbox', 'pad']].map(function (s) {
        return '<button type="button" class="' + (cur === s[0] ? 'on' : '') + '" data-a="source" data-v="' + esc(s[0]) + '">' + icon(s[2], 20) + s[1] + '</button>';
      }).join('') + '</div>';
  }
  function blind() {
    var id = S.entities.blind;
    var b = st(id);
    if (!id || !b) return '';
    var pos = or(attrs(b).current_position, b.state === 'open' ? 100 : 0);
    var gone = ['unavailable', 'unknown'].indexOf(b.state) >= 0;
    var moving = ['opening', 'closing'].indexOf(b.state) >= 0;
    var label = gone ? 'Unavailable' : moving ? (b.state === 'opening' ? 'Opening' : 'Closing') + '…' : pos <= 0 ? 'Closed' : pos >= 100 ? 'Open' : pos + '% open';
    var btn = function (v, on, ic, text) { return '<button type="button" class="' + (on ? 'on' : '') + '" data-a="blind" data-v="' + v + '"' + (gone ? ' disabled' : '') + '>' + icon(ic, 20) + text + '</button>'; };
    return '<section><div class="l-h2"><h2>Blind</h2><span class="l-aside">' + label + '</span></div><div class="l-seg">' +
      btn('open', pos >= 100, 'blindOpen', 'Open') + btn('movie', pos === 20, 'blindMovie', 'Movie') + btn('close', pos <= 0, 'blindClose', 'Close') + '</div></section>';
  }

  // The apps on the Streamer. Kids mode keeps Netflix only (its profiles have PINs); the server
  // refuses the others too (server/seat.mjs).
  function appsRow() {
    var list = kids() ? APPS.filter(function (a) { return a.id === 'netflix'; }) : APPS;
    return '<div class="l-h2"><h2>Apps</h2></div><div class="l-apps">' + list.map(function (a) {
      return '<button type="button" data-a="app" data-v="' + a.id + '" data-name="' + a.name + '"><img src="/assets/apps/' + a.id + '.png" alt="' + a.name + '"></button>';
    }).join('') + '</div>';
  }

  // ---------- Home ----------

  function homeSlots() {
    if (LAND) return homeLand();
    var deck = load('deck', function () { return get('/api/plex/ondeck?size=12'); }).v;
    var recent = load('recent', function () { return get('/api/plex/recent?size=24'); }).v;
    var seen = {};
    var added = recent ? recent.filter(function (m) { var k = m.showTitle || m.id; if (seen[k]) return false; seen[k] = 1; return true; }).slice(0, 14) : recent;
    var d = new Date();
    var part = d.getHours() < 12 ? 'morning' : d.getHours() < 17 ? 'afternoon' : 'evening';
    var k = kids();
    return [
      ['h-top', top('Home Theater', d.toLocaleDateString('en-AU', { weekday: 'long' }) + ' ' + part, statusChip(), true)],
      ['h-np', nowPlaying(false)],
      ['h-apps', appsRow()],
      ['h-deck', shelf('Continue', '', kidsFilter(deck).list, k ? 'Nothing for kids mode here.' : 'Nothing in progress.')],
      ['h-new', shelf('Just added', '<button type="button" class="l-link" data-a="tab" data-v="watch">Browse</button>', kidsFilter(added).list, 'Nothing new.')],
      ['h-scenes', scenes()],
      ['h-dev', k ? '' : devices()],
      ['h-blind', k ? '' : blind()],
    ];
  }

  // ---------- Watch ----------

  var W = { kind: 'movie', lib: null, filters: ['unwatched'], sort: 'added', seed: 0, query: '', q: '', items: null, cursor: null, total: 0, busy: false, gen: 0, key: '', last: null, lastGen: 0 };
  function shortTab(l) {
    if (l.source === 'library') return l.type === 'show' ? 'My shows' : 'My movies';
    var t = String(l.title || '').replace(/\s*·\s*(films|series)$/i, '').replace(/\s+(films|series|movies|shows|tv)$/i, '').trim();
    return t || l.title;
  }
  function watchCtx() {
    var libs = load('libs', function () { return get('/api/plex/libraries'); }).v || [];
    var kindLibs = libs.filter(function (l) { return (l.type === 'show' ? 'show' : 'movie') === W.kind && ['foryou', 'networks'].indexOf(l.id) < 0; });
    var open = kindLibs.filter(function (l) { return l.id === W.lib; })[0] || kindLibs[0];
    var isCatalog = open && open.source === 'catalog';
    var sortNow = isCatalog && W.sort !== 'random' ? 'catalog' : W.sort;
    var shown = FILTERS.filter(function (f) { return !(f.movieOnly && (!open || open.type !== 'movie')); });
    var active = W.filters.filter(function (f) { return shown.some(function (x) { return x.key === f; }); }).join(',');
    return { kindLibs: kindLibs, open: open, isCatalog: isCatalog, sortNow: sortNow, shown: shown, active: active };
  }
  // Start the list over whenever what it shows changes (tab, filter, sort, search).
  function watchFetch(c) {
    var libId = c.open && c.open.id;
    var key = [libId, c.active, c.sortNow, W.q, W.seed].join('|');
    if (key === W.key || (!libId && !W.q)) return;
    W.key = key; W.items = null; W.cursor = null; W.gen += 1;
    var gen = W.gen;
    var req = W.q ? get('/api/plex/search?q=' + encodeURIComponent(W.q)).then(function (r) { return { items: r, total: r.length }; })
      : get('/api/plex/library/' + libId + '?filters=' + c.active + '&sort=' + c.sortNow + '&size=' + PAGE);
    req.then(function (r) {
      if (gen !== W.gen) return;
      W.items = r.items || []; W.total = r.total || 0; W.cursor = r.next != null ? { next: r.next, more: r.more } : null;
      window.scrollTo(0, 0); paint();
    }).catch(function (e) { if (gen === W.gen) { W.items = []; toast(e.message, true); } });
  }
  function hasMore() { return !W.q && W.items && W.items.length < MAX_ITEMS && (W.cursor ? W.cursor.more : W.items.length < W.total); }
  function more() {
    if (W.busy || !hasMore()) return;
    var c = watchCtx();
    var gen = W.gen;
    W.busy = true; paint();
    get('/api/plex/library/' + c.open.id + '?filters=' + c.active + '&sort=' + c.sortNow + '&size=' + PAGE + '&start=' + (W.cursor ? W.cursor.next : W.items.length))
      .then(function (r) {
        if (gen !== W.gen) return;
        var had = W.items.length;
        W.items = W.items.concat(r.items || []);
        if (r.next != null) { W.cursor = { next: r.next, more: r.more }; W.total = had + (r.items || []).length + (r.more ? PAGE : 0); }
      }).catch(function () {}).then(function () { W.busy = false; paint(); });
  }
  var SEARCH_HTML = '<label class="l-search">' + icon('search', 22) + '<input type="search" placeholder="Search movies and TV shows" autocomplete="off" autocorrect="off" data-c="search">' +
    '<button type="button" class="clear" data-a="clearsearch" aria-label="Clear search">' + icon('x', 20) + '</button></label>';
  function watchSlots() {
    var c = watchCtx();
    watchFetch(c);
    var k = kids();
    var kicker = W.q ? 'Stremio search · ' + W.total + ' results' : (W.kind === 'show' ? 'TV Shows' : 'Movies') + (c.open ? ' · ' + shortTab(c.open) : '');
    var sorts = c.isCatalog ? [{ value: 'added', label: 'Catalogue order' }, { value: 'random', label: 'Random' }] : SORTS;
    var sel = c.isCatalog && W.sort !== 'random' ? 'added' : W.sort;
    var sortHtml = W.q ? '' : '<label class="l-sort"><select data-c="sort">' + sorts.map(function (s) { return '<option value="' + s.value + '"' + (s.value === sel ? ' selected' : '') + '>' + s.label + '</option>'; }).join('') + '</select>' + icon('down', 16, 2.4) + '</label>';
    var controls = W.q ? '' :
      (k ? '<div class="l-kidsnote">' + icon('lock', 16, 2.4) + 'Kids mode · G and PG only</div>' : '') +
      '<div class="l-seg kind">' + [['movie', 'Movies'], ['show', 'TV shows']].map(function (x) { return '<button type="button" class="' + (W.kind === x[0] ? 'on' : '') + '" data-a="kind" data-v="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<div class="l-pills">' + c.kindLibs.map(function (l) { return '<button type="button" class="l-pill tab' + (c.open && l.id === c.open.id ? ' on' : '') + '" data-a="lib" data-v="' + esc(l.id) + '">' + esc(shortTab(l)) + '</button>'; }).join('') + '</div>' +
      '<div class="l-pills">' + c.shown.map(function (f) { var on = W.filters.indexOf(f.key) >= 0; return '<button type="button" class="l-pill' + (on ? ' on' : '') + '" data-a="filter" data-v="' + f.key + '">' + (on ? icon('check', 16, 2.6) : '') + f.label + '</button>'; }).join('') + '</div>';
    var vis = kidsFilter(W.items).list;
    if (vis) { W.last = vis; W.lastGen = W.gen; }
    var grid = vis || W.last;
    var stale = !vis && grid && W.lastGen !== W.gen;
    var gridHtml;
    if (!grid) gridHtml = '<div class="l-empty wide">Loading…</div>';
    else if (!grid.length) gridHtml = '<div class="l-empty wide">' + (k && W.items && W.items.length ? (hasMore() ? 'Looking for G and PG titles…' : 'Nothing rated G or PG here. Try another tab or a search.') : W.q ? 'Nothing found.' : 'Nothing matches. Try removing a filter.') + '</div>';
    else gridHtml = grid.map(function (m) {
      var name = m.type === 'episode' ? m.showTitle : m.title;
      return '<button type="button" class="l-poster" data-a="open" data-id="' + reg(m) + '">' + poster(m.poster, name, m.rating ? '<span class="rating">★ ' + Number(m.rating).toFixed(1) + '</span>' : '') +
        '<span class="t">' + esc(name) + '</span><span class="y">' + esc(m.year || '') + '</span></button>';
    }).join('');
    return [
      ['w-top', top('Watch', kicker, sortHtml)],
      ['w-search', SEARCH_HTML],
      ['w-ctl', controls],
      ['w-grid', '<div class="l-grid' + (stale ? ' stale' : '') + '">' + gridHtml + '</div>'],
      ['w-more', hasMore() ? '<div class="l-empty">' + (W.busy ? 'Loading more…' : '') + '</div>' : ''],
      ['w-apps', W.q ? '' : appsRow()],
    ];
  }

  // ---------- Remote ----------

  function remoteSlots() {
    var m = media();
    if (LAND) return m.active ? nowShowingSlots(m) : remoteLand(m);
    var avr = st(m.e.avr);
    var vol = attrs(avr).volume_level;
    var muted = Boolean(attrs(avr).is_volume_muted);
    var session = m.session;
    var kicker = (m.active ? m.now.name + ' · ' : '') + 'Google TV Streamer' + (m.active ? '' : ' · ' + m.now.name);
    var note = !isUp(m.tv) ? '<div class="l-note">The Streamer is off. ' + (roomOn() ? 'Turn it on under Devices on Home.' : 'Start the cinema first.') + '</div>' : '';
    var offOk = roomOn() || gaming();
    var sleepOk = roomOn();
    var keyCount = 2 + (m.active ? 0 : 1) + (sleepOk ? 1 : 0) + (offOk ? 1 : 0);
    // With a Previous / Next row as well, the pad shrinks again so the buttons stay above the tabs.
    var navRow = m.active && (/^tt\d+:\d+:\d+$/.test((m.session && m.session.id) || '') || (!m.session && m.now.key === 'youtube'));
    var pad = '<div class="l-pad' + (m.active ? ' sm' : '') + (navRow ? ' xs' : '') + '">' +
      '<button type="button" class="up" data-a="key" data-v="up" aria-label="Up">' + icon('chev', 34, 2.6) + '</button>' +
      '<button type="button" class="left" data-a="key" data-v="left" aria-label="Left">' + icon('left', 34, 2.6) + '</button>' +
      '<button type="button" class="ok" data-a="key" data-v="ok">OK</button>' +
      '<button type="button" class="right" data-a="key" data-v="right" aria-label="Right">' + icon('chev', 34, 2.6) + '</button>' +
      '<button type="button" class="down" data-a="key" data-v="down" aria-label="Down">' + icon('chev', 34, 2.6) + '</button></div>' +
      '<div class="l-keys n' + keyCount + '">' +
      '<button type="button" data-a="key" data-v="back">' + icon('left', 20) + 'Back</button>' +
      '<button type="button" data-a="key" data-v="home">' + icon('tv', 20) + 'TV home</button>' +
      (!m.active ? '<button type="button" data-a="t" data-v="play_pause">' + playIcon(17) + 'Play / Pause</button>' : '') +
      // The sleep timer (server/sleep.mjs): off when the film ends, or after 30, 60 or 90 minutes.
      (sleepOk ? '<button type="button" class="sl' + (S.sleep ? ' on' : '') + '" data-a="sleepopen">' + icon('moon', 20) + '<span><b>Sleep</b><s>' + sleepText() + '</s></span></button>' : '') +
      // All off right here, so nobody has to go to Home and scroll for it. Two taps, as on Home.
      (offOk ? '<button type="button" class="off' + (isArmed('alloff') ? ' armed' : '') + '" data-a="alloff">' + icon('power', 20) + (isArmed('alloff') ? 'Tap again' : 'All off') + '</button>' : '') + '</div>' +
      (!m.active && isUp(avr) ? '<div class="l-vol card"><span class="k">' + (muted ? 'Muted' : 'Vol ' + (vol == null ? '–' : Math.round(vol * 200) / 2)) + '</span>' +
        '<div class="l-bar thin"><i style="width:' + (vol != null ? Math.min(100, vol * 100) : 0) + '%"></i></div>' +
        '<button type="button" data-a="t" data-v="vol_down">−</button><button type="button" data-a="t" data-v="vol_up">+</button></div>' : '');
    var sid = session && session.id || '';
    return [
      ['r-top', top(m.active ? 'Now playing' : 'TV Remote', kicker, statusChip())],
      ['r-note', note],
      ['r-np', m.active ? nowPlaying(true) : ''],
      ['r-eps', m.active && /^tt\d+:\d+:\d+$/.test(sid) ? episodeNav(sid) : m.active && !session && m.now.key === 'youtube' ? videoNav() : ''],
      ['r-pad', pad],
      ['r-about', m.active && /^tt\d+/.test(sid) ? about(sid) : ''],
    ];
  }
  // Previous / Next episode of a Stremio show: two taps, as switching ends what's on.
  function episodeNav(id) {
    var nb = load('nb:' + id, function () { return get('/api/plex/neighbours/' + encodeURIComponent(id)).catch(function () { return null; }); }).v;
    if (!nb || (!nb.prev && !nb.next)) return '';
    var season = Number(id.split(':')[1]);
    var num = function (ep) { return (ep.season !== season ? 'S' + ep.season + ' ' : '') + 'E' + ep.episode; };
    var btn = function (which, text) {
      var ep = nb[which];
      var on = isArmed('ep:' + which);
      if (ep) REG['ep:' + which] = { id: ep.id, type: 'episode', title: ep.title, showTitle: ep.showTitle };
      return '<button type="button" class="' + (which === 'next' ? 'nx' : '') + (on ? ' armed' : '') + '"' + (ep ? ' data-a="ep" data-v="' + which + '"' : ' disabled') + '>' +
        '<span><s>' + (on ? 'Tap again' : text) + '</s>' + esc(on ? 'to play ' + num(ep) : ep ? num(ep) + ' · ' + ep.title : '—') + '</span></button>';
    };
    return '<div class="l-eprow">' + btn('prev', 'Previous') + btn('next', 'Next') + '</div>';
  }
  // YouTube: Previous / Next video. One tap: a skipped video is easy to go back to.
  function videoNav() {
    return '<div class="l-eprow"><button type="button" data-a="vid" data-v="prev"><span><s>YouTube</s>Previous video</span></button>' +
      '<button type="button" class="nx" data-a="vid" data-v="next"><span><s>YouTube</s>Next video</span></button></div>';
  }
  function about(id) {
    var imdb = id.split(':')[0];
    var episode = id.indexOf(':') >= 0;
    var it = load('item:' + id, function () { return get('/api/plex/item/' + encodeURIComponent(id)).catch(function () { return null; }); }).v;
    var cr = load('credits:' + imdb, function () { return get('/api/credits/' + imdb + '?kind=' + (episode ? 'show' : 'movie')).catch(function () { return null; }); }).v;
    var cast = cr && cr.cast && cr.cast.length ? cr.cast : ((it && it.cast) || []).map(function (n) { return { name: typeof n === 'string' ? n : (n && (n.tag || n.name)) || '' }; }).filter(function (c) { return c.name; });
    if (!it && !cast.length) return '';
    var facts = episode && it ? ['S' + it.season + ' · E' + it.episode, runtime(it.duration)] : [it && it.year, runtime(it && it.duration)];
    var html = '';
    if (it && it.summary) html += '<div class="l-h2"><h2>' + (episode ? 'About this episode' : 'About this film') + '</h2><span class="l-aside">' + esc(facts.filter(Boolean).join(' · ')) + '</span></div><p class="l-syn">' + esc(it.summary) + '</p>';
    if (it && it.genres && it.genres.length) html += '<div class="l-meta2">' + esc(it.genres.map(function (g) { return typeof g === 'string' ? g : g.tag || g.name; }).join(' · ')) + '</div>';
    if (cast.length) html += '<div class="l-h2"><h2>Cast</h2></div><div class="l-cast">' + cast.map(function (c) {
      var ini = c.name.split(' ').map(function (w) { return w[0]; }).slice(0, 2).join('');
      return '<div class="l-person"><div class="ph"><span>' + esc(ini) + '</span>' + (c.photo ? '<img src="' + esc(imgSrc(c.photo)) + '" alt="">' : '') + '</div><b>' + esc(c.name) + '</b>' + (c.character ? '<s>' + esc(c.character) + '</s>' : '') + '</div>';
    }).join('') + '</div>';
    return '<section class="l-about">' + html + '</section>';
  }

  // ---------- Games (Xbox) ----------

  var G_ART = ['#2f6b3b,#122a17', '#3b4f7a,#151d33', '#7a3b2f,#2a120e', '#6b5b2f,#2a2210', '#4f2f6b,#1d1029', '#2f6b6b,#0f2929', '#7a2f4f,#2a0f1b', '#5b5b5b,#1e1e1e'];
  function gTint(id) { var n = 0; String(id).split('').forEach(function (ch) { n += ch.charCodeAt(0); }); return G_ART[n % G_ART.length]; }
  function gAgo(ms) {
    if (!ms) return '';
    var days = Math.round((new Date(new Date().toDateString()) - new Date(new Date(ms).toDateString())) / 864e5);
    if (days <= 0) return 'Played today';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    return new Date(ms).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  }
  function gTile(g, on) {
    REG['g:' + g.id] = g;
    return '<button type="button" class="l-gtile' + (on ? ' on' : '') + '" data-a="game" data-id="' + esc('g:' + g.id) + '"><div class="sq" style="background:linear-gradient(160deg,' + gTint(g.id) + ')"><span>' + esc(g.title) + '</span>' +
      (g.thumb ? '<img src="' + esc(imgSrc(g.thumb)) + '" alt="">' : '') + '</div><b>' + esc(g.title) + '</b><span>' + esc(g.kind === 'app' ? 'App' : gAgo(g.playedAt) || 'Game') + '</span></button>';
  }
  function gamesSlots() {
    var k = kids();
    var e = S.entities;
    var box = st(e.xbox), scene = st(e.xboxScene), avr = st(e.avr);
    var nowSt = e.xboxAccount ? st('sensor.' + e.xboxAccount + '_now_playing') : undefined;
    var libC = load('xbox', function () { return get('/api/xbox/library'); });
    var lib = libC.v;
    var on = Boolean(box && box.state === 'on');
    var starting = !on && ((scene && scene.state === 'on') || gBusyUntil > Date.now());
    var games = (lib && lib.games) || [];
    var apps = (lib && lib.apps) || [];
    var last = games.filter(function (g) { return g.playedAt; })[0];
    var offInput = Boolean(avr && avr.state === 'on' && attrs(avr).source && attrs(avr).source !== XBOX_INPUT);
    var live = nowSt && ['unknown', 'unavailable', ''].indexOf(nowSt.state) < 0;
    var bt = attrs(box).media_title;
    var playing = offInput ? null : live ? nowSt.state : (on && bt && bt !== 'Home' ? bt : null);
    var norm = function (t) { return String(t || '').replace(/[™®]/g, '').trim().toLowerCase(); };
    var current = playing ? games.concat(apps).filter(function (g) { return norm(g.title) === norm(playing) || norm(playing).indexOf(norm(g.title)) === 0; })[0] : null;
    var progress = parseFloat(String(or(attrs(nowSt).progress, '')));
    var genres = attrs(nowSt).genres;
    var vol = attrs(avr).volume_level;
    var muted = Boolean(attrs(avr).is_volume_muted);
    var chip = '<span class="l-chip ' + (on ? 'on' : starting ? 'warm' : '') + '"><span class="dot"></span>' + (on ? 'Xbox on' : starting ? 'Starting…' : 'Xbox off') + '</span>';
    if (LAND && on) return gamesLand({ k: k, avr: avr, nowSt: nowSt, lib: lib, libErr: libC.err, games: games, apps: apps, playing: playing, current: current, offInput: offInput, progress: progress, genres: genres });
    var body;
    if (on) {
      body = '<section class="l-ghero playing">' +
        '<div class="l-gkick"><span class="l-gpill">' + icon('pad', 20) + 'Xbox</span><span class="eye">' + (playing ? 'Now playing' : 'On') + '</span></div>' +
        '<div class="big">' + esc(playing || (offInput ? 'Not on screen' : 'Xbox home')) + '</div>' +
        '<div class="sub">' + esc(playing ? [Array.isArray(genres) ? genres.join(', ') : genres, attrs(nowSt).developer].filter(Boolean).join(' · ') : offInput ? (k ? 'The Denon is on the Chromecast · tap the game below to switch to it' : 'The Denon is on the Chromecast · switch Source to Xbox below') : 'Pick a game below, or use the controller') + '</div>' +
        (playing && isFinite(progress) ? '<div class="l-gach"><span>Achievements</span><div class="l-bar thin"><i style="width:' + Math.min(100, progress) + '%"></i></div><span>' + Math.round(progress) + ' %</span></div>' : '') +
        (isUp(avr) ? '<div class="l-gvol"><button type="button" data-a="t" data-v="vol_down">' + icon('volm', 22) + '</button><span class="k">' + (muted ? 'Muted' : 'Denon · ' + (vol == null ? '–' : Math.round(vol * 200) / 2)) + '</span>' +
          '<button type="button" data-a="t" data-v="vol_up">' + icon('volp', 22) + '</button><button type="button" data-a="mute" data-v="' + (muted ? 0 : 1) + '">' + icon('mute', 22) + '</button></div>' : '') +
        '<div class="l-grow2"><button type="button" data-a="xhome">' + icon('pad', 22) + 'Xbox home</button>' +
        '<button type="button" class="' + (isArmed('galloff') ? 'armed' : '') + '" data-a="galloff">' + icon('power', 22) + (isArmed('galloff') ? 'Tap again' : 'All off') + '</button></div></section>' +
        '<div class="l-h2"><h2>Switch game</h2><span class="l-aside">' + (games.length ? 'Recent first' : '') + '</span></div>' +
        (libC.err && !lib ? '<div class="l-empty">' + esc(libC.err.message) + '</div>' : '<div class="l-ggrid">' + games.concat(apps).map(function (g) { return gTile(g, current && current.id === g.id); }).join('') + '</div>') +
        (isUp(avr) && !k ? source(avr) : '');
    } else {
      body = '<section class="l-ghero">' +
        '<div class="eye">' + (starting ? 'Starting the room' : 'Xbox is off') + '</div>' +
        '<div class="big">' + (starting ? 'Starting…' : 'Play Xbox') + '</div>' +
        '<div class="sub">' + (starting ? 'Denon, projector, then the Xbox · about 40 seconds' : 'Starts the room for gaming · about 40 seconds') + '</div>' +
        '<button type="button" class="l-gplay" data-a="xstart"' + (starting ? ' disabled' : '') + '>' + icon('pad', 26) + 'Play Xbox</button>' +
        (last ? (REG['g:' + last.id] = last, '<div class="l-glast"><div class="sq" style="background:linear-gradient(160deg,' + gTint(last.id) + ')">' + (last.thumb ? '<img src="' + esc(imgSrc(last.thumb)) + '" alt="">' : '') + '</div>' +
          '<div class="tx"><span class="eye">Jump back in</span><b>' + esc(last.title) + '</b><span>' + esc(gAgo(last.playedAt)) + '</span></div>' +
          '<button type="button" data-a="game" data-id="' + esc('g:' + last.id) + '">Play</button></div>') : '') +
        '</section>' +
        '<div class="l-h2"><h2>Your games</h2><span class="l-aside">' + (games.length ? games.length + ' installed' : '') + '</span></div>' +
        (libC.err && !lib ? '<div class="l-empty">' + esc(libC.err.message) + '</div>' : !lib ? '<div class="l-empty">Loading…</div>' : lib.error ? '<div class="l-empty">' + esc(lib.error) + '</div>'
          : '<div class="l-ggrid">' + games.map(function (g) { return gTile(g, false); }).join('') + '</div><div class="l-empty">Tap a game: the room starts and the game opens.</div>');
    }
    return [['g-top', top('Games', 'Xbox', chip)], ['g-body', body]];
  }

  // ---------- landscape ----------
  // Slots with a third entry ('L' or 'R') go into the left or right column (see draw()).

  // What the Denon is decoding (web/lib/sound.mjs): Atmos coming through, or stereo only.
  function soundFormat(raw) {
    var r = String(raw || '').toUpperCase();
    if (!r) return null;
    if (r.indexOf('ATMOS') >= 0) return { label: 'Dolby Atmos', kind: 'atmos' };
    if (r.indexOf('DTS:X') >= 0 || r.indexOf('DTS-X') >= 0) return { label: 'DTS:X', kind: 'atmos' };
    if (r.indexOf('MULTI CH') >= 0) return { label: 'Multichannel', kind: 'dolby' };
    if (r.indexOf('NEURAL') >= 0 || r.indexOf('PCM') >= 0 || r.indexOf('STEREO') >= 0) return { label: 'Stereo · no Atmos', kind: 'pcm' };
    if (/DOLBY|TRUEHD|DD\+|DSUR/.test(r)) return { label: 'Dolby', kind: 'dolby' };
    if (r.indexOf('DTS') >= 0) return { label: 'DTS', kind: 'dolby' };
    return null;
  }

  // The volume slider: tap or drag along it (the server caps the Denon at 75 %), − and + for one
  // step, and Mute. While dragging, and for a few seconds after, it shows where the finger left it.
  var VOL_MAX = 75;
  function volNow(avr) {
    if (VS && VS.until > Date.now()) return VS.pct;
    var v = attrs(avr).volume_level;
    return v == null ? null : v * 100;
  }
  function volSlider(avr) {
    if (!isUp(avr)) return '';
    var muted = Boolean(attrs(avr).is_volume_muted);
    var p = volNow(avr);
    var w = p == null ? 0 : Math.min(100, p);
    return '<div class="l-vrow">' +
      '<button type="button" data-a="t" data-v="vol_down" aria-label="Volume down">−</button>' +
      '<div class="l-vs" data-vs="1"><div class="k"><span>Volume</span><span class="v">' + (muted ? 'Muted' : p == null ? '–' : Math.round(p * 2) / 2) + '</span></div>' +
        '<div class="tr"><i style="width:' + w + '%"></i><b style="left:' + w + '%"></b></div></div>' +
      '<button type="button" data-a="t" data-v="vol_up" aria-label="Volume up">+</button>' +
      '<button type="button" class="mu' + (muted ? ' on' : '') + '" data-a="mute" data-v="' + (muted ? 0 : 1) + '" aria-label="Mute">' + icon('mute', 24) + '</button></div>';
  }
  var vsDrag = false;
  function vsMove(x) {
    var tr = document.querySelector('[data-vs] .tr');
    if (!tr) return;
    var r = tr.getBoundingClientRect();
    if (!r.width) return;
    VS = { pct: Math.round(Math.max(0, Math.min(VOL_MAX, ((x - r.left) / r.width) * 100))), until: Date.now() + 4000 };
    paint();
  }
  function vsStart(ev, x) {
    if (!(ev.target.closest && ev.target.closest('[data-vs]'))) return false;
    vsDrag = true; vsMove(x);
    return true;
  }
  function vsEnd() {
    if (!vsDrag) return;
    vsDrag = false;
    if (!VS) return;
    VS.until = Date.now() + 4000;
    act({ action: 'cinema', cmd: 'volume', value: VS.pct });
    setTimeout(paint, 4100);
  }

  function dpad(cls) {
    return '<div class="l-pad ' + (cls || '') + '">' +
      '<button type="button" class="up" data-a="key" data-v="up" aria-label="Up">' + icon('chev', 34, 2.6) + '</button>' +
      '<button type="button" class="left" data-a="key" data-v="left" aria-label="Left">' + icon('left', 34, 2.6) + '</button>' +
      '<button type="button" class="ok" data-a="key" data-v="ok">OK</button>' +
      '<button type="button" class="right" data-a="key" data-v="right" aria-label="Right">' + icon('chev', 34, 2.6) + '</button>' +
      '<button type="button" class="down" data-a="key" data-v="down" aria-label="Down">' + icon('chev', 34, 2.6) + '</button></div>';
  }
  function offKey() {
    return '<button type="button" class="off' + (isArmed('alloff') ? ' armed' : '') + '" data-a="alloff">' + icon('power', 20) + (isArmed('alloff') ? 'Tap again' : 'All off') + '</button>';
  }
  function castOf(sid) {
    if (!/^tt\d+/.test(sid)) return [];
    var imdb = sid.split(':')[0];
    var it = load('item:' + sid, function () { return get('/api/plex/item/' + encodeURIComponent(sid)).catch(function () { return null; }); }).v;
    var cr = load('credits:' + imdb, function () { return get('/api/credits/' + imdb + '?kind=' + (sid.indexOf(':') >= 0 ? 'show' : 'movie')).catch(function () { return null; }); }).v;
    return cr && cr.cast && cr.cast.length ? cr.cast : ((it && it.cast) || []).map(function (n) { return { name: typeof n === 'string' ? n : (n && (n.tag || n.name)) || '' }; }).filter(function (c) { return c.name; });
  }

  // Now Showing: what the Remote tab becomes in landscape while a film or show plays. Like the
  // hallway board: the whole poster on the left over a blurred copy of itself, the title and
  // synopsis, progress, transport and volume; for the seat a D-pad, Back, TV home, Intermission
  // and All off. No rail: "Panel home" goes back to the tabs.
  function nowShowingSlots(m) {
    MODE = 'now';
    var e = m.e, session = m.session, now = m.now, tv = m.tv;
    var avr = st(e.avr);
    var a = attrs(tv), ca = attrs(now.cast);
    var playing = m.state === 'playing';
    var sid = (session && session.id) || '';
    var it = /^tt\d+/.test(sid) ? load('item:' + sid, function () { return get('/api/plex/item/' + encodeURIComponent(sid)).catch(function () { return null; }); }).v : null;
    var app = (session && session.app) || now.key;
    var title = (session && (session.showTitle || session.title)) || now.title || a.media_title || now.name;
    var sub = session && session.showTitle ? 'S' + session.season + ' · E' + session.episode + ' · ' + session.title : now.title && now.artist ? now.artist : '';
    var dur = session && session.duration ? session.duration / 1000 : ca.media_duration || a.media_duration || null;
    var pos = session && session.viewOffset != null ? session.viewOffset / 1000 + (playing ? (Date.now() - S.sessionsAt) / 1000 : 0) : livePosition(now.cast || tv);
    var left = dur && pos != null && dur - pos > 1 ? dur - pos : null;
    var castPic = now.cast && ca.entity_picture ? '/api/ha-image?e=' + encodeURIComponent(e.streamerCast) + '&v=' + encodeURIComponent(ca.entity_picture) : null;
    var pic = (session && (session.posterLarge || session.poster)) || castPic;
    // The app's icon or the title underneath, showing if the poster doesn't load.
    var under = '<div class="fb">' + (app ? '<img class="app" src="/assets/apps/' + esc(app) + '.png" alt="">' : '<div class="tt">' + esc(title) + '</div>') + '</div>';
    var art = under + (pic ? '<div class="blur" style="background-image:url(\'' + esc(imgSrc(pic)) + '\')"></div><img class="pic" src="' + esc(imgSrc(pic)) + '" alt="">' : '');
    var fmt = playing ? soundFormat(attrs(avr).sound_mode_raw) : null;
    var genre = it && it.genres && it.genres.length ? it.genres[0] : null;
    var facts = [it && it.year, genre && (typeof genre === 'string' ? genre : genre.tag || genre.name)].filter(Boolean).join(' · ');
    var label = playing ? 'Now showing' : 'Paused';
    var head = '<div class="l-nh"><div class="tx"><div class="l-kick">' + label + (facts ? ' · ' + esc(facts) : '') + (fmt ? '<span class="l-fmt ' + fmt.kind + '">' + fmt.label + '</span>' : '') + '</div>' +
      '<h1>' + esc(title) + '</h1>' + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') +
      (it && it.summary ? '<p class="syn">' + esc(it.summary) + '</p>' : '') + '</div>' +
      (left != null ? '<div class="ends"><span>Ends at</span><b>' + endsAt(left * 1000).replace(/ (am|pm)$/, '') + '</b></div>' : '') + '</div>' +
      (dur && pos != null ? '<div class="l-bar"><i style="width:' + Math.min(100, (pos / dur) * 100) + '%"></i></div><div class="l-times"><span>' + mmss(pos) + '</span><span>' + (left != null ? mmss(left) + ' left' : '') + '</span></div>' : '');
    var nav = /^tt\d+:\d+:\d+$/.test(sid) ? episodeNav(sid) : !session && now.key === 'youtube' ? videoNav() : '';
    var tp = '<div class="l-tp' + (nav ? ' tight' : '') + '"><div class="row">' +
      '<button type="button" class="sk" data-a="t" data-v="back10">−10</button>' +
      '<button type="button" class="pp" data-a="t" data-v="play_pause" aria-label="' + (playing ? 'Pause' : 'Play') + '">' + (playing ? pauseIcon(44) : playIcon(44)) + '</button>' +
      '<button type="button" class="sk" data-a="t" data-v="fwd30">+30</button></div>' + volSlider(avr) + '</div>';
    var offOk = roomOn() || gaming();
    var ctl = '<div class="l-nctl">' + dpad(nav ? 'ns xs' : 'ns') + '<div class="l-keys k2">' +
      '<button type="button" data-a="key" data-v="back">' + icon('left', 20) + 'Back</button>' +
      '<button type="button" data-a="key" data-v="home">' + icon('tv', 20) + 'TV home</button>' +
      '<button type="button" data-a="scene" data-v="intermission">' + icon('cup', 20) + 'Intermission</button>' +
      (offOk ? offKey() : '') + '</div></div>';
    var cast = castOf(sid).slice(0, 4);
    var castHtml = cast.length ? '<div class="l-ncast"><span class="k">Starring</span>' + cast.map(function (c) {
      var ini = c.name.split(' ').map(function (w) { return w[0]; }).slice(0, 2).join('');
      return '<div class="p"><div class="ph"><span>' + esc(ini) + '</span>' + (c.photo ? '<img src="' + esc(imgSrc(c.photo)) + '" alt="">' : '') + '</div><span class="nm"><b>' + esc(c.name) + '</b>' + (c.character ? '<s>' + esc(c.character) + '</s>' : '') + '</span></div>';
    }).join('') + '</div>' : '';
    return [
      ['n-poster', '<div class="l-npost">' + art + '<button type="button" class="l-phome" data-a="tab" data-v="home">' + icon('home', 20) + 'Panel home</button></div>'],
      ['n-head', head],
      ['n-tp', tp],
      ['n-eps', nav],
      ['n-ctl', ctl],
      ['n-cast', castHtml],
    ];
  }

  // The Remote tab with nothing playing: a big D-pad, the keys and volume beside it, the apps below.
  function remoteLand(m) {
    var avr = st(m.e.avr);
    var offOk = roomOn() || gaming();
    var note = !isUp(m.tv) ? '<div class="l-note">The Streamer is off. ' + (roomOn() ? 'Turn it on under Devices on Home.' : 'Start the cinema first.') + '</div>' : '';
    var list = kids() ? APPS.filter(function (a) { return a.id === 'netflix'; }) : APPS;
    return [
      ['r-top', top('Remote', 'Google TV Streamer · ' + m.now.name, statusChip())],
      ['r-note', note],
      ['r-main', '<div class="l-rmain">' + dpad('big') + '<div class="rr"><div class="l-keys k2">' +
        '<button type="button" data-a="key" data-v="back">' + icon('left', 20) + 'Back</button>' +
        '<button type="button" data-a="key" data-v="home">' + icon('tv', 20) + 'TV home</button>' +
        '<button type="button" data-a="t" data-v="play_pause">' + playIcon(17) + 'Play / Pause</button>' +
        (offOk ? offKey() : '') + '</div>' + volSlider(avr) + '</div></div>'],
      ['r-apps', '<div class="l-apps2">' + list.map(function (a) {
        return '<button type="button" data-a="app" data-v="' + a.id + '" data-name="' + a.name + '"><img src="/assets/apps/' + a.id + '.png" alt="' + a.name + '"></button>';
      }).join('') + '</div>'],
    ];
  }

  // Continue watching, as on the hallway board: one title at a time with its artwork, swipe or
  // the arrows to move through them, Resume and Start over. A tap on the artwork opens its page.
  function continueCard(list, k) {
    var head = '<div class="l-h2"><h2>Continue</h2></div>';
    if (!list) return head + '<div class="l-empty">Loading…</div>';
    if (!list.length) return head + '<div class="l-empty">' + (k ? 'Nothing for kids mode here.' : 'Nothing in progress.') + '</div>';
    var n = list.length;
    var at = ((CW % n) + n) % n;
    var it = list[at];
    var left = (it.duration || 0) - (it.viewOffset || 0);
    var pct = it.duration ? Math.min(100, Math.round(((it.viewOffset || 0) / it.duration) * 100)) : 0;
    var pic = it.art || it.still || it.poster;
    REG.cw = it;
    return '<section class="l-cw" data-sw="cw"><button type="button" class="art" data-a="open" data-id="' + reg(it) + '">' +
      '<span class="fb">' + esc(nameOf(it)) + '</span>' + (pic ? '<img src="' + esc(imgSrc(pic)) + '" alt="">' : '') + '<span class="sh"></span><span class="nm">' + esc(nameOf(it)) + '</span></button>' +
      (n > 1 ? '<span class="cnt">' + (at + 1) + ' / ' + n + '</span><button type="button" class="ar l" data-a="cw" data-v="-1" aria-label="Previous">' + icon('left', 26, 2.4) + '</button>' +
        '<button type="button" class="ar r" data-a="cw" data-v="1" aria-label="Next">' + icon('chev', 26, 2.4) + '</button>' : '') +
      '<div class="cb"><div class="l-kick hd"><span>Continue watching</span>' + (n > 1 ? '<span class="dots">' + list.map(function (x, i) { return '<i class="' + (i === at ? 'on' : '') + '"></i>'; }).join('') + '</span>' : '') + '</div>' +
      (it.showTitle ? '<div class="sub">S' + esc(it.season) + ' · E' + esc(it.episode) + ' · ' + esc(it.title) + '</div>' : '') +
      '<div class="l-bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="l-times"><span>' + esc([it.year, left > 0 ? runtime(left) + (it.viewOffset ? ' left' : '') : ''].filter(Boolean).join(' · ')) + '</span><span>' + (left > 0 ? 'ends ' + endsAt(left) : '') + '</span></div>' +
      '<div class="rs"><button type="button" class="go" data-a="cwplay" data-v="1">' + playIcon(22) + (it.viewOffset ? 'Resume' : 'Play') + '</button>' +
      (it.viewOffset > 0 ? '<button type="button" class="gh" data-a="cwplay" data-v="0" aria-label="Start over">' + icon('back', 24, 2.2) + '</button>' : '') + '</div></div></section>';
  }

  // Scenes in landscape: three across, Sleep beside them, All off as the last tile.
  function scenesLand() {
    var tracked = st('input_select.theater_scene');
    var hasActive = roomOn() ? SCENE_OF[tracked && tracked.state] : undefined;
    if (picked && (picked.name === hasActive || Date.now() - picked.at > 60000)) picked = null;
    var active = picked ? picked.name : hasActive;
    var list = SCENES.filter(function (sc) { return !kids() || ['pre_show', 'movie_time'].indexOf(sc.name) < 0; });
    var tiles = list.map(function (sc) {
      return '<button type="button" class="l-tile' + (sc.name === active ? ' on' : '') + '" data-a="scene" data-v="' + sc.name + '">' + icon(sc.icon, 24) + '<b>' + sc.label + '</b><s>' + sc.desc + '</s></button>';
    });
    if (roomOn()) tiles.push('<button type="button" class="l-tile' + (S.sleep ? ' on' : '') + '" data-a="sleepopen">' + icon('moon', 24) + '<b>Sleep</b><s>' + sleepText() + '</s></button>');
    if (roomOn() || gaming()) tiles.push('<button type="button" class="l-tile off' + (isArmed('alloff') ? ' armed' : '') + '" data-a="alloff">' + icon('power', 24) + '<b>' + (isArmed('alloff') ? 'Tap again' : 'All off') + '</b><s>' + (isArmed('alloff') ? 'to turn off' : 'Ends the night') + '</s></button>');
    return '<section><div class="l-h2"><h2>Scenes</h2></div><div class="l-tiles">' + tiles.join('') + '</div></section>';
  }

  function homeLand() {
    var deck = load('deck', function () { return get('/api/plex/ondeck?size=12'); }).v;
    var recent = load('recent', function () { return get('/api/plex/recent?size=24'); }).v;
    var seen = {};
    var added = recent ? recent.filter(function (m) { var k = m.showTitle || m.id; if (seen[k]) return false; seen[k] = 1; return true; }).slice(0, 14) : recent;
    var d = new Date();
    var part = d.getHours() < 12 ? 'morning' : d.getHours() < 17 ? 'afternoon' : 'evening';
    var k = kids();
    return [
      ['h-top', top('Home Theater', d.toLocaleDateString('en-AU', { weekday: 'long' }) + ' ' + part, statusChip(), true)],
      ['h-np', nowPlaying(false), 'L'],
      ['h-apps', appsRow(), 'L'],
      ['h-new', shelf('Just added', '<button type="button" class="l-link" data-a="tab" data-v="watch">Browse</button>', kidsFilter(added).list, 'Nothing new.'), 'L'],
      ['h-dev', k ? '' : devices(), 'L'],
      ['h-deck', continueCard(kidsFilter(deck).list, k), 'R'],
      ['h-scenes', scenesLand(), 'R'],
      ['h-blind', k ? '' : blind(), 'R'],
    ];
  }

  // Games in landscape with the Xbox on: like the hallway board's Game time. The game's poster on
  // the left, what's playing, for how long and the achievements, volume, Xbox home and All off,
  // and the other games in a row underneath.
  function gamesLand(c) {
    MODE = 'gplay';
    var e = S.entities;
    var a = attrs(c.nowSt);
    var base = String(e.xboxArt || '').replace(/_superhero_art$/, '');
    var pid = base && base !== e.xboxArt ? base + '_poster' : null;
    var pst = st(pid);
    var pic = c.playing && pst && attrs(pst).entity_picture ? '/api/ha-image?e=' + encodeURIComponent(pid) + '&v=' + encodeURIComponent(attrs(pst).entity_picture) + '&s=' + encodeURIComponent(pst.state || '') : null;
    var frac = function (v) { var mm = String(v || '').match(/(\d+)\s*\/\s*(\d+)/); return mm ? [Number(mm[1]), Number(mm[2])] : null; };
    var ach = frac(a.achievements), score = frac(a.gamerscore);
    var pct = isFinite(c.progress) ? c.progress : ach && ach[1] ? (ach[0] / ach[1]) * 100 : null;
    var since = c.playing && c.nowSt && c.nowSt.last_changed ? Math.max(0, (Date.now() - Date.parse(c.nowSt.last_changed)) / 1000) : null;
    var played = since == null ? '' : since >= 3600 ? Math.floor(since / 3600) + 'h ' + Math.floor((since % 3600) / 60) + 'm' : Math.floor(since / 60) + 'm';
    var genres = Array.isArray(c.genres) ? c.genres.join(', ') : c.genres;
    var sub = c.playing ? '' : c.offInput ? (c.k ? 'The Denon is on the Chromecast · tap a game below to switch to it' : 'The Denon is on the Chromecast · switch Source to Xbox below') : 'Pick a game below, or use the controller';
    var all = c.games.concat(c.apps);
    var head = '<div class="l-nh"><div class="tx"><div class="l-kick"><span class="l-gpill">' + icon('pad', 16) + 'Xbox</span>' + (c.playing ? 'Game' + (genres ? ' · ' + esc(genres) : '') : 'On') + '</div>' +
      '<h1>' + esc(c.playing || (c.offInput ? 'Not on screen' : 'Xbox home')) + '</h1>' + (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') +
      (c.playing && a.short_description ? '<p class="syn">' + esc(a.short_description) + '</p>' : '') + '</div>' +
      (played ? '<div class="ends"><span>Playing for</span><b>' + played + '</b></div>' : '') + '</div>' +
      (c.playing && pct != null ? '<div class="l-bar"><i style="width:' + Math.min(100, pct) + '%"></i></div><div class="l-times"><span>' + (ach ? 'Achievements ' + ach[0] + ' / ' + ach[1] : '') + '</span><span>' + (score ? 'Gamerscore ' + score[0] + ' / ' + score[1] : '') + '</span></div>' : '');
    return [
      ['g-poster', '<div class="l-npost game"><div class="band">' + icon('pad', 18) + 'Xbox · game</div>' +
        '<div class="fb"><div class="tt">' + icon('pad', 64, 1.6) + '</div></div>' +
        (pic ? '<div class="blur" style="background-image:url(\'' + esc(pic) + '\')"></div><img class="pic" src="' + esc(pic) + '" alt="">' : '') + '</div>'],
      ['g-head', head],
      ['g-vol', isUp(c.avr) ? '<div class="l-tp">' + volSlider(c.avr) + '</div>' : ''],
      ['g-keys', '<div class="l-keys k2 g"><button type="button" data-a="xhome">' + icon('pad', 20) + 'Xbox home</button>' +
        '<button type="button" class="off' + (isArmed('galloff') ? ' armed' : '') + '" data-a="galloff">' + icon('power', 20) + (isArmed('galloff') ? 'Tap again' : 'All off') + '</button></div>'],
      ['g-switch', '<div class="l-h2"><h2>Switch game</h2></div>' + (c.libErr && !c.lib ? '<div class="l-empty">' + esc(c.libErr.message) + '</div>'
        : '<div class="l-gscroll">' + all.map(function (g) { return gTile(g, c.current && c.current.id === g.id); }).join('') + '</div>')],
      ['g-src', isUp(c.avr) && !c.k && c.offInput ? source(c.avr) : ''],
    ];
  }

  // ---------- the title sheet and the PIN pad ----------

  function sheetHtml() {
    if (U.sleepPick) return sleepSheet();
    if (U.pin) {
      var p = U.pin;
      var dots = [0, 1, 2, 3].map(function (i) { return '<i class="' + (i < p.pin.length ? 'f' : '') + '"></i>'; }).join('');
      var keys = '';
      for (var n = 1; n <= 9; n++) keys += '<button type="button" data-a="pin" data-v="' + n + '">' + n + '</button>';
      keys += '<button type="button" class="x" data-a="pinclose">Cancel</button><button type="button" data-a="pin" data-v="0">0</button><button type="button" class="x" data-a="pindel" aria-label="Delete">⌫</button>';
      return '<div class="l-back" data-a="pinclose" data-self="1"><div class="l-sheet l-pin"><div class="grab"></div><h3>Grown-up mode</h3><p>Enter the PIN · unlocks for 20 minutes</p>' +
        '<div class="l-dots' + (p.bad ? ' bad' : '') + '">' + dots + '</div><div class="l-pinkeys">' + keys + '</div>' +
        '<button type="button" class="l-ask" data-a="ask">Ask a grown-up</button></div></div>';
    }
    if (!U.sheet) return '';
    var start = U.sheet;
    var id = start.type === 'show' && start.showKey ? start.showKey : start.id;
    var c = load('item:' + id, function () { return get('/api/plex/item/' + encodeURIComponent(id)); });
    var it = c.v;
    var m = it || start;
    var isShow = m.type === 'show' || m.type === 'season';
    var target = isShow ? it && it.next : it;
    var heading = m.type === 'episode' ? m.showTitle : m.title;
    var meta = m.type === 'episode' ? ['S' + m.season + ' · E' + m.episode, m.title, runtime(m.duration)] : [m.year, runtime(m.duration), m.contentRating];
    var body;
    if (c.err && !it) body = '<div class="l-empty">' + esc(c.err.message) + '</div>';
    else if (!it) body = '<div class="l-empty">Loading…</div>';
    else {
      if (target) REG['target'] = target;
      body = (it.summary ? '<p class="l-plot">' + esc(it.summary) + '</p>' : '') +
        (isShow && it.next ? '<div class="l-next">Up next: S' + it.next.season + ' · E' + it.next.episode + ' ' + esc(it.next.title) + '</div>' : '') +
        (target ? '<button type="button" class="l-play" data-a="play" data-v="1">' + playIcon(24) + (target.viewOffset ? 'Resume in the cinema' : 'Play in the cinema') + '</button>'
          : '<button type="button" class="l-play" disabled>Nothing to play</button>') +
        (target && target.viewOffset > 0 ? '<button type="button" class="l-play2" data-a="play" data-v="0">Start over</button>' : '') +
        (!roomOn() && target ? '<div class="l-note">The cinema is off · it starts first (about a minute)</div>' : '');
      if (isShow && it.seasons && it.seasons.length) {
        body += '<div class="l-h2"><h2>Episodes</h2></div><div class="l-pills">' + it.seasons.map(function (s) {
          return '<button type="button" class="l-pill' + (U.season === s.id ? ' on' : '') + '" data-a="season" data-v="' + esc(s.id) + '">' + esc(s.title) + '</button>';
        }).join('') + '</div>';
        if (U.season) {
          var eps = load('eps:' + U.season, function () { return get('/api/plex/episodes/' + encodeURIComponent(U.season)); }).v;
          body += !eps ? '<div class="l-empty">Loading…</div>' : '<div class="l-eps">' + eps.map(function (e) {
            REG['e:' + e.id] = e;
            return '<button type="button" class="l-ep" data-a="playep" data-id="' + esc('e:' + e.id) + '"><span class="n">' + esc(e.episode) + '</span><span class="tt"><b>' + esc(e.title) + '</b><s>' +
              esc([runtime(e.duration), e.viewOffset ? 'in progress' : ''].filter(Boolean).join(' · ')) + '</s></span>' + playIcon(18) + '</button>';
          }).join('') + '</div>';
        }
      }
    }
    return '<div class="l-back" data-a="close" data-self="1"><div class="l-sheet"><div class="grab"></div>' +
      '<button type="button" class="l-close" data-a="close" aria-label="Close">' + icon('x', 22) + '</button>' +
      '<div class="l-dt"><div class="l-dt-poster">' + poster(m.poster, heading) + '</div><div class="l-dt-info"><h3>' + esc(heading) + '</h3>' +
      '<div class="l-meta">' + esc(meta.filter(Boolean).join(' · ')) + '</div>' +
      (m.rating ? '<div class="l-meta">★ ' + Number(m.rating).toFixed(1) + ' IMDb</div>' : '') +
      (m.genres && m.genres.length ? '<div class="l-meta">' + esc(m.genres.slice(0, 3).join(' · ')) + '</div>' : '') +
      '</div></div>' + body + '</div></div>';
  }

  // ---------- drawing ----------

  var $page = document.getElementById('page');
  var $tabs = document.getElementById('tabs');
  var $sheet = document.getElementById('sheet');
  var $toast = document.getElementById('toast');
  var $offline = document.getElementById('offline');
  var built = { tab: null, shape: null, slots: {} };
  var last = {};
  function setHtml(el, key, html) {
    if (last[key] === html) return;
    last[key] = html;
    el.innerHTML = html;
  }
  var queued = false;
  function paint() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; draw(); });
  }
  function draw() {
    follow();
    var tab = U.tab === 'games' && !hasXbox() ? 'home' : U.tab;
    MODE = '';
    var slots = tab === 'watch' ? watchSlots() : tab === 'remote' ? remoteSlots() : tab === 'games' ? gamesSlots() : homeSlots();
    // The page is rebuilt when the set of slots changes (another tab, turning the iPad, a film
    // starting); otherwise only the slots whose markup changed are redrawn.
    var shape = tab + '|' + slots.map(function (s) { return s[0] + (s[2] || ''); }).join(',');
    if (built.shape !== shape) {
      var newTab = built.tab !== tab;
      built.tab = tab; built.shape = shape;
      built.slots = {};
      var div = function (s) { return '<div id="' + s[0] + '"></div>'; };
      var col = function (c) { return slots.filter(function (s) { return s[2] === c; }).map(div).join(''); };
      $page.innerHTML = slots.filter(function (s) { return !s[2]; }).map(div).join('') +
        (slots.some(function (s) { return s[2]; }) ? '<div class="l-cols"><div class="l-col">' + col('L') + '</div><div class="l-col">' + col('R') + '</div></div>' : '');
      slots.forEach(function (s) { built.slots[s[0]] = document.getElementById(s[0]); delete last[s[0]]; });
      if (newTab) window.scrollTo(0, 0);
    }
    slots.forEach(function (s) { setHtml(built.slots[s[0]], s[0], s[1]); });
    var tabs = [['home', 'Home', 'home'], ['watch', 'Watch', 'film']];
    if (hasXbox()) tabs.push(['games', 'Games', 'pad']);
    // In landscape the Remote tab is Now Showing while something plays.
    tabs.push(['remote', LAND && media().active ? 'Now' : 'Remote', 'remote']);
    setHtml($tabs, 'tabs', tabs.map(function (t) { return '<button type="button" class="' + (tab === t[0] ? 'on' : '') + '" data-a="tab" data-v="' + t[0] + '">' + icon(t[2], 28) + t[1] + '</button>'; }).join('') +
      (LAND ? '<div class="l-railb">' + badge() + '</div>' : ''));
    setHtml($sheet, 'sheet', sheetHtml());
    document.body.className = [U.sheet || U.pin || U.sleepPick ? 'locked' : '', LAND ? 'land' : '', MODE].filter(Boolean).join(' ');
    setHtml($toast, 'toast', toastNow ? '<div class="l-toast' + (toastNow.err ? ' err' : '') + '">' + esc(toastNow.text) + '</div>' : '');
    setHtml($offline, 'offline', S.connected === false ? '<div class="l-offline">Can\'t reach the cinema panel. Is the iPad on the home Wi-Fi?</div>' : '');
  }

  function setTab(t) {
    if (t === 'home' && U.tab !== 'home') { forget('deck'); forget('recent'); CW = 0; }
    if (t === 'games') forget('xbox');
    if (t === U.tab) window.scrollTo(0, 0);
    U.tab = t;
    try { history.replaceState(null, '', '#' + t); } catch (e) { /* not allowed: fine */ }
    paint();
  }
  function closeSheet(played) {
    U.sheet = null; U.season = null;
    if (played) setTab('home'); else paint();
  }

  // The seat remote follows the room: Games when the Xbox comes on, Remote while a film or show
  // plays, Home otherwise. It moves when that changes, and after a few minutes untouched it goes
  // back there. It never moves while someone is using it.
  var touched = Date.now();
  var prevMode = null;
  function target() { return gaming() && hasXbox() ? 'games' : media().active ? 'remote' : 'home'; }
  function goHome() {
    if (U.pin) U.pin = null;
    U.sleepPick = false;
    if (U.sheet) { U.sheet = null; U.season = null; }
    var t = target();
    if (U.tab !== t) setTab(t); else { window.scrollTo(0, 0); paint(); }
  }
  function follow() {
    if (!SEAT) return;
    var mode = gaming() ? 'xbox' : media().active ? 'playing' : roomOn() ? 'on' : 'off';
    if (prevMode !== null && mode !== prevMode && mode !== 'off' && Date.now() - touched >= SWITCH_MS) setTimeout(goHome, 0);
    prevMode = mode;
  }
  setInterval(function () {
    if (!SEAT || Date.now() - touched < IDLE_MS) return;
    if (U.sheet || U.pin || U.sleepPick || U.tab !== target() || window.pageYOffset > 0) goHome();
    // A new panel build was installed: reload while nobody's using it.
    if (staleBuild) location.reload();
  }, 10e3);
  // Ticking clocks (time left, grown-up minutes).
  setInterval(function () { if (media().state === 'playing' || (S.seat && S.seat.enabled && !S.seat.locked)) paint(); }, 1000);

  // ---------- taps ----------

  var lastTouch = 0;
  var holdTimer = null;
  var held = false;
  var touchSent = 0;
  function onDown(ev) {
    touched = Date.now();
    // Grown-up mode lasts 20 minutes from the last touch: tell the server (at most once a minute).
    var s = S.seat;
    if (SEAT && s && s.enabled && !s.locked && Date.now() - touchSent >= 60e3) { touchSent = Date.now(); post('/api/seat/touch', {}).catch(function () {}); }
    var h = ev.target.closest && ev.target.closest('[data-hold]');
    if (!h) return;
    held = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(function () { held = true; U.pin = { pin: '', bad: false }; paint(); }, 1500);
  }
  function onUp(ev) {
    var h = ev.target.closest && ev.target.closest('[data-hold]');
    clearTimeout(holdTimer);
    if (h && !held) toast('Kids mode · hold the badge to unlock');
    if (h && ev.cancelable) ev.preventDefault();
    held = false;
  }
  // Continue watching swipes left and right (landscape). The tap that ends a swipe is not a tap.
  var swipe = null;
  var swallowUntil = 0;
  function swipeEnd(x, y) {
    var w = swipe;
    swipe = null;
    if (!w) return;
    var dx = x - w.x;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(y - w.y)) return;
    CW += dx < 0 ? 1 : -1;
    swallowUntil = Date.now() + 500;
    paint();
  }
  document.addEventListener('touchstart', function (ev) {
    lastTouch = Date.now(); onDown(ev);
    var t = ev.touches[0];
    if (vsStart(ev, t.clientX)) return;
    swipe = ev.target.closest && ev.target.closest('[data-sw]') ? { x: t.clientX, y: t.clientY } : null;
  }, true);
  document.addEventListener('touchend', function (ev) {
    lastTouch = Date.now(); onUp(ev);
    if (vsDrag) { vsEnd(); if (ev.cancelable) ev.preventDefault(); return; }
    var t = ev.changedTouches[0];
    if (t) swipeEnd(t.clientX, t.clientY);
  }, true);
  document.addEventListener('touchcancel', function () { clearTimeout(holdTimer); swipe = null; vsEnd(); }, true);
  // A finger that moves is scrolling, not holding.
  document.addEventListener('touchmove', function () { clearTimeout(holdTimer); }, { capture: true, passive: true });
  // Dragging the volume slider must not scroll the page.
  document.addEventListener('touchmove', function (ev) { if (!vsDrag) return; if (ev.cancelable) ev.preventDefault(); vsMove(ev.touches[0].clientX); }, { capture: true, passive: false });
  document.addEventListener('mousedown', function (ev) {
    if (Date.now() - lastTouch <= 800) return;
    onDown(ev);
    if (vsStart(ev, ev.clientX)) return;
    swipe = ev.target.closest && ev.target.closest('[data-sw]') ? { x: ev.clientX, y: ev.clientY } : null;
  }, true);
  document.addEventListener('mousemove', function (ev) { if (vsDrag) vsMove(ev.clientX); }, true);
  document.addEventListener('mouseup', function (ev) {
    if (Date.now() - lastTouch <= 800) return;
    onUp(ev);
    if (vsDrag) { vsEnd(); return; }
    swipeEnd(ev.clientX, ev.clientY);
  }, true);
  // Turning the iPad switches between the portrait and landscape layouts.
  function orient() {
    var l = window.innerWidth > window.innerHeight;
    if (l !== LAND) { LAND = l; paint(); }
  }
  window.addEventListener('resize', orient);
  window.addEventListener('orientationchange', function () { setTimeout(orient, 300); });
  document.addEventListener('keydown', function () { touched = Date.now(); }, true);
  document.addEventListener('contextmenu', function (ev) { if (ev.target.closest && ev.target.closest('[data-hold]')) ev.preventDefault(); });
  // Broken artwork falls back to the title underneath it.
  document.addEventListener('error', function (ev) { if (ev.target && ev.target.tagName === 'IMG') ev.target.style.display = 'none'; }, true);

  function transport(v) {
    if (v === 'back10') return act({ action: 'transport', cmd: 'seek_rel', seconds: -10 });
    if (v === 'fwd30') return act({ action: 'transport', cmd: 'seek_rel', seconds: 30 });
    return act({ action: 'transport', cmd: v });
  }
  function pinPress(d) {
    var p = U.pin;
    if (!p || p.pin.length >= 4) return;
    p.pin += d; p.bad = false;
    paint();
    if (p.pin.length === 4) {
      post('/api/seat/unlock', { pin: p.pin })
        .then(function () { toast('Grown-up mode · 20 minutes'); U.pin = null; paint(); })
        .catch(function (e) { if (U.pin) { U.pin.bad = true; U.pin.pin = ''; } toast(e.message, true); paint(); });
    }
  }

  var A = {
    tab: function (v) { setTab(v); },
    reload: function () { toast('Reloading…'); setTimeout(function () { location.reload(); }, 300); },
    t: function (v) { transport(v); },
    mute: function (v) { act({ action: 'transport', cmd: 'mute', muted: v === '1' }); },
    key: function (v) { act({ action: 'tv_key', key: v }); },
    open: function (v, el) { var m = REG[el.getAttribute('data-id')]; if (m) { U.sheet = m; U.season = null; paint(); } },
    close: function () { closeSheet(false); },
    play: function (v) { var t = REG.target; if (t) playItem(t, v === '1').then(function (ok) { if (ok) closeSheet(true); }); },
    playep: function (v, el) { var e = REG[el.getAttribute('data-id')]; if (e) playItem(e, true).then(function (ok) { if (ok) closeSheet(true); }); },
    season: function (v) { U.season = U.season === v ? null : v; paint(); },
    ep: function (v) {
      var k = 'ep:' + v;
      if (!isArmed(k)) { armed = {}; arm(k); paint(); return; }
      delete armed[k];
      var ep = REG[k];
      if (ep) playItem(ep, false);
      paint();
    },
    scene: function (v) { picked = { name: v, at: Date.now() }; act({ action: 'scene', name: v }); paint(); },
    alloff: function () {
      if (!isArmed('alloff')) { arm('alloff'); paint(); return; }
      delete armed.alloff; act({ action: 'scene', name: 'all_off' }); toast('Turning the cinema off');
    },
    galloff: function () {
      if (!isArmed('galloff')) { arm('galloff'); paint(); return; }
      delete armed.galloff; act({ action: 'scene', name: 'all_off' }); toast('Turning everything off');
    },
    dev: function (v, el) {
      var k = 'dev:' + v;
      var on = el.getAttribute('data-on') === '1';
      if (on && !isArmed(k)) { arm(k); paint(); return; }
      delete armed[k];
      act({ action: 'cinema', cmd: 'device', dev: v, on: !on });
      toast(el.getAttribute('data-name') + ' ' + (on ? 'off' : 'on'));
    },
    source: function (v) {
      var avr = st(S.entities.avr);
      if ((wantSource || attrs(avr).source) === v) return;
      wantSource = v; act({ action: 'cinema', cmd: 'source', source: v }); paint();
    },
    blind: function (v) { act(v === 'movie' ? { action: 'cinema', cmd: 'blind', position: 20 } : { action: 'cinema', cmd: 'blind', to: v }); },
    app: function (v, el) {
      var name = el.getAttribute('data-name');
      act({ action: 'app', id: v }).then(function (r) { if (r && r.warming) toast('Starting the cinema · ' + name + ' opens once it\'s up'); else if (r) toast('Opening ' + name + ' on the TV'); });
    },
    kind: function (v) { if (v !== W.kind) { W.kind = v; W.lib = null; paint(); } },
    lib: function (v) { W.lib = v; paint(); },
    filter: function (v) { var i = W.filters.indexOf(v); if (i >= 0) W.filters.splice(i, 1); else W.filters.push(v); W.filters = W.filters.slice(); paint(); },
    clearsearch: function () { var i = document.querySelector('[data-c="search"]'); if (i) i.value = ''; W.query = ''; W.q = ''; paint(); },
    xstart: function () {
      gBusyUntil = Date.now() + 60000; paint();
      act({ action: 'xbox', cmd: 'start' }).then(function (r) { if (r) toast('Starting the room for gaming'); });
    },
    xhome: function () { act({ action: 'xbox', cmd: 'home' }).then(function (r) { if (r) toast('Xbox home'); }); },
    game: function (v, el) {
      var g = REG[el.getAttribute('data-id')];
      if (!g) return;
      act({ action: 'xbox', cmd: 'launch', id: g.id, kind: g.kind }).then(function (r) {
        if (r) toast(r.starting ? 'Starting the room · ' + g.title + ' opens when the Xbox is up' : 'Opening ' + g.title);
        if (r && r.starting) { gBusyUntil = Date.now() + 60000; paint(); }
      });
    },
    relock: function () { post('/api/seat/lock', {}).then(function () { toast('Back to kids mode'); }).catch(function () {}); },
    vid: function (v) { act({ action: 'transport', cmd: v }).then(function (r) { if (r) toast(v === 'next' ? 'Next video' : 'Previous video'); }); },
    sleepopen: function () { U.sleepPick = true; paint(); },
    sleepclose: function () { U.sleepPick = false; paint(); },
    sleeppick: function (v) {
      U.sleepPick = false; paint();
      var opt = v === 'off' ? { mode: 'off' } : v === 'end' ? { mode: 'end' } : { mode: 'timer', minutes: Number(v) };
      post('/api/sleep', opt).then(function (r) {
        toast(r.mode ? (r.mode === 'end' ? 'The cinema turns off when the film ends' : 'The cinema turns off in ' + r.minutes + ' minutes') : 'Sleep timer off');
      }).catch(function (e) { toast(e.message, true); });
    },
    cw: function (v) { CW += Number(v); paint(); },
    cwplay: function (v) { var it = REG.cw; if (it) playItem(it, v === '1'); },
    pinopen: function () { U.pin = { pin: '', bad: false }; paint(); },
    pin: function (v) { pinPress(v); },
    pindel: function () { if (U.pin) { U.pin.pin = U.pin.pin.slice(0, -1); paint(); } },
    pinclose: function () { U.pin = null; paint(); },
    ask: function () {
      post('/api/seat/ask', {}).then(function (r) { toast(r.again ? 'Already asked · check your phones' : 'Asked · a grown-up\'s phone will buzz'); U.pin = null; paint(); })
        .catch(function (e) { toast(e.message, true); });
    },
  };
  document.addEventListener('click', function (ev) {
    if (Date.now() < swallowUntil) { ev.preventDefault(); return; }
    var el = ev.target.closest && ev.target.closest('[data-a]');
    if (!el || el.disabled) return;
    // A sheet's backdrop closes it only when the tap lands on the backdrop itself.
    if (el.getAttribute('data-self') && ev.target !== el) return;
    var fn = A[el.getAttribute('data-a')];
    if (fn) { ev.preventDefault(); fn(el.getAttribute('data-v'), el); }
  });

  var searchTimer;
  document.addEventListener('input', function (ev) {
    if (ev.target.getAttribute('data-c') !== 'search') return;
    W.query = ev.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () { W.q = W.query.trim(); paint(); }, 350);
  });
  document.addEventListener('change', function (ev) {
    if (ev.target.getAttribute('data-c') !== 'sort') return;
    W.sort = ev.target.value;
    if (W.sort === 'random') W.seed += 1;
    paint();
  });
  // Close the keyboard on Search (Enter) so the results are visible.
  document.addEventListener('keyup', function (ev) { if (ev.keyCode === 13 && ev.target.getAttribute('data-c') === 'search') ev.target.blur(); });
  // Watch loads more as the grid nears the bottom.
  window.addEventListener('scroll', function () {
    if (U.tab === 'watch' && window.innerHeight + window.pageYOffset > document.body.scrollHeight - 900) more();
  });

  var h = location.hash.slice(1);
  if (['watch', 'remote', 'games'].indexOf(h) >= 0) U.tab = h;
  startLive();
  paint();
})();

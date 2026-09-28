// Settings come from the environment (see .env.example), overlaid with whatever was saved on the
// admin page (settings.json next to the image cache, so it lives in the container's /data volume).
// Entity ids live here, not in the HA package, so the HA scripts stay generic and this file is
// the single place to rename things.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

export const SETTINGS_FILE = process.env.SETTINGS_FILE || join(dirname(process.env.CACHE_DIR || './cache'), 'settings.json');

// { vars: { HA_URL: ..., ... }, games: {...} }. Saved vars win over the environment.
let saved = { vars: {}, games: null };
try { saved = { vars: {}, games: null, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) }; }
catch (e) { if (e.code !== 'ENOENT') console.warn(`[settings] ${SETTINGS_FILE}: ${e.message}`); }

export const settings = () => saved;

// Secrets the panel generates for itself when none are configured, kept with the settings so they
// survive restarts. Without a panel key anyone who can reach the panel can drive the room, so one
// is made on first run unless ALLOW_OPEN=1 says the network is trusted.
function ensureSecrets(vars) {
  let changed = false;
  const need = (key, make) => {
    if (process.env[key] || vars[key]) return;
    vars[key] = make();
    changed = true;
  };
  need('IMAGE_SECRET', () => randomBytes(24).toString('hex'));
  if (process.env.ALLOW_OPEN !== '1') need('PANEL_KEY', () => randomBytes(12).toString('base64url'));
  if (changed) {
    try {
      mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
      writeFileSync(SETTINGS_FILE, JSON.stringify({ ...saved, vars }, null, 2), { mode: 0o600 });
    } catch (e) { console.warn(`[settings] could not save generated secrets: ${e.message}`); }
  }
  return vars;
}
export const effectiveVars = () => ({ ...process.env, ...Object.fromEntries(Object.entries(ensureSecrets(saved.vars)).filter(([, v]) => v !== '' && v != null)) });

// Replace the saved settings and apply them to the live config object (every module reads
// config at call time, so nothing needs a restart except the HA connection, which the caller
// reconnects).
export function saveSettings(next) {
  mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, SETTINGS_FILE);
  saved = next;
  const fresh = build(effectiveVars());
  for (const k of Object.keys(fresh)) config[k] = fresh[k];
}

function build(env) {
  const c = {
  port: Number(env.PORT || 8787),
  // Optional shared key. When set, a client must present it once (?key=...) and gets a cookie.
  // ALLOW_OPEN=1 means "this network is trusted": no key is generated, and a key generated earlier
  // stops being enforced (it stays in settings, so turning this off again restores it).
  panelKey: process.env.ALLOW_OPEN === '1' ? '' : env.PANEL_KEY || '',
  // Addresses that skip the panel key (the wall panel, the house LAN). Anything else still needs it.
  trustedNetworks: list(env.TRUST_NETWORKS, []),
  // Proxies whose X-Forwarded-For may be believed. Docker's own networks by default; add the
  // address of Traefik or the k3s ingress if the panel is reached through one, or a client on a
  // trusted network will look like the proxy instead of itself.
  trustedProxies: list(env.TRUSTED_PROXIES, ['127.0.0.1', '::1', '172.16.0.0/12']),
  imageSecret: env.IMAGE_SECRET || '',
  cacheDir: env.CACHE_DIR || './cache',
  imageCacheMb: Number(env.IMAGE_CACHE_MB || 2048),   // posters are small and never change; keep plenty

  ha: {
    url: (env.HA_URL || '').replace(/\/$/, ''),
    token: env.HA_TOKEN || '',
  },
  // Stremio is this fork's library (server/stremio.mjs). Email and password come from the add-on
  // options; STREMIO_AUTH_KEY works instead for anyone who would rather not store a password.
  stremio: {
    email: env.STREMIO_EMAIL || '',
    password: env.STREMIO_PASSWORD || '',
    authKey: env.STREMIO_AUTH_KEY || '',
  },
  // True when there is a library to show at all (Stremio here; Plex upstream).
  media: { on: Boolean((env.STREMIO_EMAIL && env.STREMIO_PASSWORD) || env.STREMIO_AUTH_KEY) },
  plex: {
    url: (env.PLEX_URL || '').replace(/\/$/, ''),
    token: env.PLEX_TOKEN || '',
    // Library section titles shown as tabs, in order. Empty = every movie and show library.
    libraries: list(env.PLEX_LIBRARIES, []),
    // A plex.tv account token, for the watchlist (it lives on plex.tv, not on the server; the
    // server token above cannot read it). Made by the sign-in button on the settings page.
    accountToken: env.PLEX_ACCOUNT_TOKEN || '',
  },
  seerr: {
    url: (env.SEERR_URL || '').replace(/\/$/, ''),
    // Where a guest's phone should go (the Scan to request QR). The panel talks to Seerr on the
    // LAN address above; a phone needs the public one. Blank falls back to SEERR_URL.
    publicUrl: (env.SEERR_PUBLIC_URL || env.SEERR_URL || '').replace(/\/$/, ''),
    apiKey: env.SEERR_API_KEY || '',
    // Optional Seerr user id so requests show as made by that user instead of the key's owner.
    userId: env.SEERR_USER_ID || '',
    // Region for "streaming on" lookups (TMDB watch providers).
    region: env.SEERR_REGION || 'US',
  },

  entities: {
    // This fork: the Google TV Streamer (Android TV Remote integration) takes the Apple TV's place.
    appleTv: env.ENTITY_APPLE_TV || 'media_player.media_room_tv',
    appleTvRemote: env.ENTITY_APPLE_TV_REMOTE || 'remote.media_room_tv',
    // The Denon receiver (volume, mute) and the HACS Stremio integration's player (what is on).
    avr: env.ENTITY_AVR || 'media_player.home_theater',
    stremioPlayer: env.ENTITY_STREMIO_PLAYER || 'media_player.stairs_cabinet_stremio_stremio',
    roomOn: env.ENTITY_ROOM_ON || 'input_boolean.movie_scene',
    // What the warm-up screen watches come on: the plug the Denon and Xbox hang off, and the projector.
    plug: env.ENTITY_PLUG || 'light.media_control_switch',
    projectorPower: env.ENTITY_PROJECTOR_POWER || 'media_player.epson_projector',
    // The Plex client entity HA creates for the Apple TV once "Advertise as player" is on.
    plexPlayer: env.ENTITY_PLEX_PLAYER || '',
    // The projector's own Plex client, as HA's Plex integration names it.
    projectorPlexPlayer: env.ENTITY_PROJECTOR_PLEX_PLAYER || '',
    musicPlayer: env.ENTITY_MUSIC_PLAYER || 'media_player.cinema_google_mini',
    // Music Assistant players offered under "Play on"; the first is the theater's own.
    musicPlayers: list(env.ENTITY_MUSIC_PLAYERS, []),
    // Android Debug Bridge media_player for the projector. Empty until ADB is tested.
    projector: env.ENTITY_PROJECTOR || '',
    // The soundbar (JBL's local integration, jbl_integration): every entity it creates is named
    // from the device name, so one stem on the settings page finds them all.
    soundbar: soundbarIds(env.SOUNDBAR_PREFIX || '', list(env.SOUNDBAR_REARS, ['left', 'right'])),
    // The projector's light-engine temperatures (the Kiosk Satellite plugin's sensors), for the
    // line on the Projector card and the running-hot nudge.
    projectorTemps: list(env.ENTITY_PROJECTOR_TEMPS, []),
    lights: list(env.ENTITY_LIGHTS, ['light.media']),
    temperature: env.ENTITY_TEMPERATURE || 'sensor.cinema_temperature',
    occupancy: env.ENTITY_OCCUPANCY || 'binary_sensor.media_room_occupancy',
    tautulli: env.ENTITY_TAUTULLI || 'sensor.tautulli_watching',
    // Accent-light effect speed and intensity helpers (input_number), shown in the effect picker.
    accentSpeed: env.ENTITY_ACCENT_SPEED || 'input_number.home_theater_accent_speed',
    accentIntensity: env.ENTITY_ACCENT_INTENSITY || 'input_number.home_theater_accent_intensity',
    // "The dog is at the door": UniFi's barking and animal detections on the deck camera, and
    // the camera itself for the snapshot. Empty turns the alert off.
    dogSensors: list(env.ENTITY_DOG_SENSORS, []),
    dogCamera: env.ENTITY_DOG_CAMERA || '',
    dogName: env.DOG_NAME || 'The dog',
    // Picture mode helper (input_select) the projector card shows and cycles.
    pictureMode: env.ENTITY_PICTURE_MODE || 'input_select.projector_picture_mode',
  },
  // Where Play sends a title:
  //   appletv  - the Apple TV's Plex app (HA's Plex client for it)
  //   plezy    - Plezy on the projector, opened with a plezy://play link over ADB
  //   plex     - the official Plex app on the projector, driven as a Plex client
  // "projector" is the old name for plezy.
  playTarget: ((env.STREMIO_EMAIL && env.STREMIO_PASSWORD) || env.STREMIO_AUTH_KEY) && !env.PLAY_TARGET ? 'stremio' : ['plezy', 'plex', 'projector'].includes(env.PLAY_TARGET) ? (env.PLAY_TARGET === 'projector' ? 'plezy' : env.PLAY_TARGET) : 'appletv',
  plezyPackage: env.PLEZY_PACKAGE || 'com.edde746.plezy',
  projectorPlexPackage: env.PROJECTOR_PLEX_PACKAGE || 'com.plexapp.android',
  // The Plex client's name as Plex reports it (Settings > Plex Web > Devices), used to pick the
  // theater's session out of /status/sessions. Empty = the first playing session.
  plexPlayerName: env.PLEX_PLAYER_NAME || '',
  // Apps the Projector card can open on the projector itself (Android, over ADB), as
  // "Name=package" or "Name=package=icon" (e.g. YouTube=org.smarttube.stable=mdi:youtube). The projector is woken first if it is off.
  projectorApps: list(env.PROJECTOR_APPS, []).map((pair) => {
    const [name, pkg, icon] = pair.split('=').map((x) => x.trim());
    if (!pkg || !/^[\w.]+$/.test(pkg)) return null;
    return { name, package: pkg, ...(icon && /^[a-z0-9-]+:[a-z0-9-]+$|^[a-z]+$/.test(icon) ? { icon } : {}) };
  }).filter(Boolean),
  // Pre-roll: a deep swell on the theater speakers while the lights go down, before the film
  // starts. The URL has to be one the speaker itself can fetch (the panel serves the sound at
  // /assets/preroll.mp3, which needs no key); blank turns the whole thing off.
  preroll: {
    url: env.PREROLL_URL || '',
    seconds: Math.max(3, Math.min(60, Number(env.PREROLL_SECONDS || 16))),
    // A swell before a film is an event; before the fourth episode of a sitcom it is a delay.
    // Movies only by default; the Play button offers it either way when it is configured.
    moviesOnly: env.PREROLL_MOVIES_ONLY !== 'false',
    // A switch in Home Assistant (and the settings page) to leave the URL set but skip the swell.
    enabled: env.PREROLL_ENABLED !== 'false',
    // Creature feature: at Halloween the swell is replaced by the sting next to it on disk.
    // Only when the pre-roll is the panel's own sound, so a custom URL is left alone.
    spookyUrl: env.PREROLL_SPOOKY_URL || ((env.PREROLL_URL || '').endsWith('/preroll.mp3') ? env.PREROLL_URL.replace(/preroll\.mp3$/, 'preroll-spooky.mp3') : ''),
  },
  // TMDB, for the holiday shelves: a public list per season (the number from the list's address
  // on themoviedb.org), read with a free API key. Blank = no TMDB lists; the shelves fall back to
  // Kometa's collections and TMDB's tags through Seerr.
  tmdb: {
    apiKey: env.TMDB_API_KEY || '',
    lists: {
      halloween: env.TMDB_LIST_HALLOWEEN || '7061968',
      christmas: env.TMDB_LIST_CHRISTMAS || '5915',
    },
  },
  // The December "Wrapped": on this day (MM-DD) the year's numbers go to these Home Assistant
  // notify entities (phones, the kitchen display). Empty = nobody.
  wrapped: {
    date: /^\d{2}-\d{2}$/.test(env.WRAPPED_DATE || '') ? env.WRAPPED_DATE : '12-26',
    notify: list(env.WRAPPED_NOTIFY, []),
  },
  // The slow curtain: when a film ends the house lights come up over this many seconds, the way
  // a cinema's do (0 turns it off). The HA script only acts if the room is still set for a movie.
  curtainSeconds: Math.max(0, Math.min(600, Number(env.CURTAIN_SECONDS ?? 90) || 0)),
  // The THX Deep Note, for the button on the Sound sheet: a URL the room's speaker can fetch.
  thxUrl: env.THX_URL || '',
  // The soundbar's knobs that are the panel's business rather than the bar's.
  soundbarStep: Math.max(1, Math.min(20, Number(env.SOUNDBAR_STEP ?? 2) || 2)),
  soundbarMovieSmart: env.SOUNDBAR_MOVIE_SMART !== 'false',
  soundbarCalibrationSeconds: Math.max(10, Math.min(300, Number(env.SOUNDBAR_CALIBRATION_SECONDS ?? 45) || 45)),
  // The projector counts as running hot at or above this laser temperature (°C).
  projectorHotC: Math.max(0, Math.min(150, Number(env.PROJECTOR_HOT_C ?? 65) || 0)),
  // Whose taste drives "You'll love this" and the Mystery box: Plex account names (or ids) from
  // the server's own history. Empty means the whole house.
  historyAccounts: list(env.HISTORY_ACCOUNTS, []),
  // The Mystery box's pool: how far back it looks, how well rated a film has to be, how long it
  // may run, and which genres never come up. 0 (or blank) for any year, any rating, any length.
  mystery: {
    years: Math.max(0, Math.min(200, Number(env.MYSTERY_YEARS ?? 10) || 0)),
    minRating: Math.max(0, Math.min(10, Number(env.MYSTERY_MIN_RATING ?? 7) || 0)),
    maxMinutes: Math.max(0, Math.min(1000, Number(env.MYSTERY_MAX_MINUTES) || 0)),
    excludeGenres: list(env.MYSTERY_EXCLUDE_GENRES, []).map((g) => g.toLowerCase()),
    // Let new arrivals settle: nothing added in the last so many days (0 = draw straight away).
    settleDays: Math.max(0, Math.min(365, Number(env.MYSTERY_SETTLE_DAYS ?? 2) || 0)),
    // Family night: G and PG (and the TV equivalents) only.
    family: env.MYSTERY_FAMILY === 'true',
    // 'any', 'prefer4k', '4k', 'preferhdr' or 'hdr': prefer doubles a film's odds, only excludes.
    quality: ['prefer4k', '4k', 'preferhdr', 'hdr'].includes(env.MYSTERY_QUALITY) ? env.MYSTERY_QUALITY : 'any',
    // Plex library names the box never draws from (a kids' or a documentary library).
    excludeLibraries: list(env.MYSTERY_EXCLUDE_LIBRARIES, []).map((l) => l.toLowerCase()),
    // Never a title the house rated two stars or under on the "How was it?" card.
    skipDisliked: env.MYSTERY_SKIP_DISLIKED !== 'false',
    // Only films that carry a rating (G, PG, PG-13, R, NC-17 or a TV rating): festival and
    // straight-to-streaming titles that never got one are out.
    ratedOnly: env.MYSTERY_RATED_ONLY !== 'false',
    // Nothing rated below this: 'any', 'PG', 'PG-13' or 'R' (TV ratings count as their film
    // equivalents), so a kids' film never comes up on an adults' night.
    minContentRating: ['PG', 'PG-13', 'R'].includes(env.MYSTERY_MIN_CONTENT_RATING) ? env.MYSTERY_MIN_CONTENT_RATING : 'any',
    // Only films from a mainstream studio (taste.mjs has the list), plus any named here.
    mainstreamOnly: env.MYSTERY_MAINSTREAM_ONLY !== 'false',
    studiosExtra: list(env.MYSTERY_STUDIOS_EXTRA, []).map((s) => s.toLowerCase()),
    // Studios the box never draws from, whatever else is on (a TV-movie house, say).
    studiosExclude: list(env.MYSTERY_STUDIOS_EXCLUDE, []).map((s) => s.toLowerCase()),
  },
  // Intermission: the snack bar screen on the panel, and a corny little march on the theater
  // speakers to go with it (the panel's own, at /assets/intermission.mp3). Blank = no sound.
  intermission: {
    url: env.INTERMISSION_URL || ((env.PREROLL_URL || '').endsWith('/preroll.mp3') ? env.PREROLL_URL.replace(/preroll\.mp3$/, 'intermission.mp3') : ''),
    minutes: Math.max(1, Math.min(60, Number(env.INTERMISSION_MINUTES || 15))),
  },
  // Tonight: the evening around a film. Trailers on the projector before it (SmartTube takes a
  // YouTube link), the lights a few minutes before those, a break in the middle of a long film.
  tonight: {
    trailers: env.TRAILERS_ENABLED !== 'false',
    trailerCount: Math.max(0, Math.min(5, Number(env.TRAILERS_COUNT ?? 2) || 0)),
    trailerSeconds: Math.max(30, Math.min(600, Number(env.TRAILERS_SECONDS ?? 150) || 150)),
    trailerPackage: env.TRAILERS_PACKAGE || 'org.smarttube.stable',
    preshowMinutes: Math.max(0, Math.min(60, Number(env.PRESHOW_MINUTES ?? 10) || 0)),
    autoIntermissionMinutes: Math.max(0, Math.min(600, Number(env.AUTO_INTERMISSION_MINUTES ?? 120) || 0)),
    guestHours: Math.max(1, Math.min(24, Number(env.GUEST_HOURS ?? 6) || 6)),
  },
  // The panel as a Home Assistant device, over the ESPHome native API (server/hass.mjs). HA's
  // ESPHome integration adds it by host and port; the key is a 32-byte base64 Noise key like an
  // ESPHome node's, blank for a plaintext connection.
  hass: {
    enabled: env.ESPHOME_ENABLED !== 'false',
    name: (env.ESPHOME_NAME || 'theater-panel').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'theater-panel',
    friendlyName: env.ESPHOME_FRIENDLY_NAME || 'Theater panel',
    port: Math.max(1, Math.min(65535, Number(env.ESPHOME_PORT) || 6053)),
    noiseKey: env.ESPHOME_NOISE_KEY || '',
    area: env.ESPHOME_AREA || 'Home Theater',
    esphomeVersion: env.ESPHOME_VERSION || '2025.12.0',
    mdns: env.ESPHOME_MDNS === 'true',
  },
  // Steam library on the Games screen (Steam Web API key and 64-bit SteamID).
  steam: { apiKey: env.STEAM_API_KEY || '', id: env.STEAM_ID || '' },
  // How far back the "Now in Plex" chip looks for requests that arrived.
  arrivalHours: Math.min(Number(env.ARRIVAL_HOURS) || 48, 24 * 14),
  // Minutes without a touch before the panel drifts to the Now Showing screen (0 = never).
  idleMinutes: Number(env.IDLE_MINUTES ?? 8),
  // Which build this is: stamped into the image by `npm run push`.
  build: { version: env.BUILD_VERSION || 'dev', time: env.BUILD_TIME || '' },
  // Favourite light effects shown first in the Moods sheet (up to 8, in order).
  effectFavourites: list(env.ACCENT_FAVOURITES, []).slice(0, 8),
  // Poster labels. Network is off by default because Plex posters decorated by Kometa already
  // carry the network; the detail pane always shows it.
  ui: {
    // 'classic' is the room as built (chocolate, copper); 'sofa' re-skins the dark surfaces in the
    // couch's slate tweed. The panel can still try one with #/lobby?theme=sofa.
    theme: env.THEME === 'sofa' ? 'sofa' : 'classic',
    // Holiday accent on top of the theme: 'auto' follows the calendar (see accents.mjs).
    accent: env.ACCENT || 'auto',
    // 0..100: how much weather the accent puts over the lobby (25 is the original amount).
    accentIntensity: Math.max(0, Math.min(100, Number(env.ACCENT_INTENSITY ?? 50) || 0)),
    birthdays: env.BIRTHDAYS || '',
    // Cinema mode: the panel dims itself when the room is dark and nothing is playing.
    cinema: env.CINEMA_MODE !== 'false',
    qualityBadges: env.SHOW_QUALITY_BADGES !== 'false',
    networkBadges: env.SHOW_NETWORK_BADGES === 'true',
    // Plex sessions are only the theater's own when the player name is set.
    // Sessions belong to this room: Plex with PLEX_PLAYER_NAME, or always with Stremio (the panel
    // builds them from the Streamer).
    theaterSessions: Boolean(env.PLEX_PLAYER_NAME) || Boolean((env.STREMIO_EMAIL && env.STREMIO_PASSWORD) || env.STREMIO_AUTH_KEY),
  },
  // Extra origins allowed to embed the panel (the HA dashboard), space- or comma-separated.
  frameAncestors: (env.FRAME_ANCESTORS || '').split(/[\s,]+/).filter((o) => /^https?:\/\/[\w.-]+(:\d+)?$/.test(o)),
  // The admin page's password; only from the environment, so the page can't lock itself open.
  adminPassword: process.env.ADMIN_PASSWORD || '',
  };
  if (!c.entities.musicPlayers.length) c.entities.musicPlayers = [c.entities.musicPlayer];
  return c;
}

// The soundbar's entities from its name stem, as jbl_integration names them: "JBL Bar 1300X"
// becomes the stem jbl_bar_1300x, and its rears are their own devices under it.
export function soundbarIds(prefix, rears = ['left', 'right']) {
  const p = String(prefix || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!p) return null;
  return {
    prefix: p,
    volume: `number.${p}_volume`, power: `switch.${p}_power`,
    night: `switch.${p}_night_mode`, pureVoice: `switch.${p}_purevoice`, smart: `switch.${p}_smart_mode`,
    preset: `select.${p}_eq_preset`,
    bands: ['125hz', '250hz', '500hz', '1000hz', '2000hz', '4000hz', '8000hz'].map((b) => `number.${p}_${b}`),
    custom: ['eq_1_low', 'eq_2_mid', 'eq_3_high'].map((b) => `number.${p}_${b}`),
    buttons: { mute: `button.${p}_mute`, volumeUp: `button.${p}_increase_volume`, volumeDown: `button.${p}_lower_volume`, bass: `button.${p}_bass`, rear: `button.${p}_rear`, atmos: `button.${p}_atmos`, calibration: `button.${p}_calibration`, moment: `button.${p}_moment`, playPause: `button.${p}_play_pause` },
    rears: rears.map((ch) => { const c = ch.trim().toLowerCase(); return { channel: c, battery: `sensor.${p}_rear_speaker_${c}_battery`, charging: `binary_sensor.${p}_rear_speaker_${c}_charging`, docked: `binary_sensor.${p}_rear_speaker_${c}_docked` }; }),
  };
}

export const soundbarEntities = (sb) => !sb ? [] : [sb.volume, sb.power, sb.night, sb.pureVoice, sb.smart, sb.preset, ...sb.bands, ...sb.custom, ...sb.rears.flatMap((r) => [r.battery, r.charging, r.docked])];

export const config = build(effectiveVars());

export function watchedEntities() {
  const e = config.entities;
  return [
    e.appleTv, e.appleTvRemote, e.avr, e.stremioPlayer, e.roomOn, e.plug, e.projectorPower, e.plexPlayer, e.projectorPlexPlayer, ...e.musicPlayers, e.projector,
    ...e.lights, e.temperature, e.occupancy, e.tautulli, e.pictureMode, e.accentSpeed, e.accentIntensity,
    ...e.dogSensors, ...e.projectorTemps, ...soundbarEntities(e.soundbar),
    'input_select.theater_scene',
  ].filter(Boolean);
}

// Admin page API: view and change the panel's settings from a laptop instead of editing the
// Unraid container. Settings are the same names as the environment variables; what is saved here
// wins over the container's value, and a blank field falls back to it.
//
// Protected by ADMIN_PASSWORD (environment only). Sign-in sets a signed, HttpOnly, SameSite=Strict
// cookie; secrets are write-only (the page is told whether one is set, never its value).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config, settings, saveSettings, effectiveVars } from './config.mjs';
import { loadGames, loadGamesFile, STAT_ROLES } from './games.mjs';
import * as plex from './plex.mjs';

// type: text | secret | entity | list (comma-separated) | libraries | effects | select | bool | apps (Name=package list)
export const FIELDS = [
  { group: 'Home Assistant', key: 'HA_URL', label: 'URL', type: 'text', placeholder: 'http://10.2.3.6:8123' },
  { group: 'Home Assistant', key: 'HA_TOKEN', label: 'Long-lived access token', type: 'secret' },

  { group: 'Home Assistant device', key: 'ESPHOME_ENABLED', label: 'Appear in Home Assistant as a device', type: 'bool', default: true, help: 'The panel speaks the ESPHome native API, so Home Assistant\'s own ESPHome integration adds it like a board: theme, accent, cinema mode, sleep timer, scenes and the Mystery box as controls, what is playing as sensors, and play/navigate/voice as actions. Add it under Settings > Devices & services > ESPHome with this container\'s address and the port below.' },
  { group: 'Home Assistant device', key: 'ESPHOME_PORT', label: 'Port', type: 'text', placeholder: '6053', help: 'The port Home Assistant connects to. 6053 is what ESPHome boards use; change it if something else on the host has it.' },
  { group: 'Home Assistant device', key: 'ESPHOME_NOISE_KEY', label: 'Encryption key', type: 'secret', help: 'Optional. A 32-byte base64 key (openssl rand -base64 32), the same kind an ESPHome node uses; give Home Assistant the same key when adding the device. Blank connects in plain text, which is fine on a trusted network.' },
  { group: 'Home Assistant device', key: 'ESPHOME_NAME', label: 'Device name', type: 'text', placeholder: 'theater-panel', help: 'Lower-case with hyphens, like an ESPHome node name; entity ids start with it. Changing it makes a new device in Home Assistant.' },
  { group: 'Home Assistant device', key: 'ESPHOME_FRIENDLY_NAME', label: 'Shown as', type: 'text', placeholder: 'Theater panel' },
  { group: 'Home Assistant device', key: 'ESPHOME_AREA', label: 'Suggested area', type: 'text', placeholder: 'Home Theater' },
  { group: 'Home Assistant device', key: 'ESPHOME_MDNS', label: 'Announce over mDNS', type: 'bool', default: false, help: 'Only useful when the container shares a network segment with Home Assistant (host networking). On a bridge or macvlan network add the device by address instead.' },

  { group: 'Plex', key: 'PLEX_URL', label: 'URL', type: 'text', placeholder: 'http://10.2.6.3:32400' },
  { group: 'Plex', key: 'PLEX_TOKEN', label: 'Token', type: 'secret' },
  { group: 'Plex', key: 'PLEX_ACCOUNT_TOKEN', label: 'Plex account', type: 'plexlogin', help: 'For the watchlist, which lives on plex.tv rather than on the server. Sign in with the button; the panel gets a token from plex.tv and never sees the password.' },
  { group: 'Plex', key: 'PLEX_LIBRARIES', label: 'Libraries, in tab order', type: 'libraries', help: 'Movie libraries are merged into one Movies tab. Blank shows every movie and TV library.' },
  { group: 'Plex', key: 'PLAY_TARGET', label: 'Play on', type: 'select', options: [['appletv', 'Apple TV — Plex app'], ['plezy', 'Projector — Plezy'], ['plex', 'Projector — Plex app']], help: 'Which app Play and Resume open. Plezy is opened with a link over ADB; the Plex apps are driven as Plex clients.' },
  { group: 'Plex', key: 'ENTITY_PROJECTOR_PLEX_PLAYER', label: "Projector's Plex client", type: 'entity', domain: 'media_player', help: 'Only for "Projector — Plex app": HA\'s Plex client for the projector (Plex for Android (TV) - AURORA PRO).' },
  { group: 'Plex', key: 'HISTORY_ACCOUNTS', label: 'Whose taste to follow', type: 'list', help: "Plex account names whose watch history feeds \u201cYou'll love this\u201d and the Mystery box. Blank follows the whole house." },
  { group: 'Plex', key: 'PLEX_PLAYER_NAME', label: 'Theater player name', type: 'text', help: "The client's name as Plex reports it, to show what's playing (the projector is AURORA PRO)." },
  { group: 'Mystery box', key: 'MYSTERY_YEARS', label: 'Only films from the last (years)', type: 'text', placeholder: '10', help: '0 looks at every year.' },
  { group: 'Mystery box', key: 'MYSTERY_MIN_RATING', label: 'Lowest rating', type: 'text', placeholder: '7', help: "Plex's audience rating, 0-10. A film with no rating is left out. 0 takes anything." },
  { group: 'Mystery box', key: 'MYSTERY_MAX_MINUTES', label: 'Longest film (minutes)', type: 'text', help: 'Blank for any length.' },
  { group: 'Mystery box', key: 'MYSTERY_EXCLUDE_GENRES', label: 'Never these genres', type: 'list', help: 'Genres as Plex names them: Horror, Documentary, Animation... Blank excludes nothing.' },
  { group: 'Mystery box', key: 'MYSTERY_EXCLUDE_LIBRARIES', label: 'Never these libraries', type: 'libraries', help: "A kids' or a documentary library the box should leave alone. Blank draws from every movie library." },
  { group: 'Mystery box', key: 'MYSTERY_SETTLE_DAYS', label: 'Let new arrivals settle (days)', type: 'text', placeholder: '2', help: 'Nothing added to Plex more recently than this, so a half-finished download or an unmatched title never comes up. 0 draws straight away.' },
  { group: 'Mystery box', key: 'MYSTERY_FAMILY', label: 'Family night: G and PG only', type: 'bool', default: false },
  { group: 'Mystery box', key: 'MYSTERY_QUALITY', label: 'Picture quality', type: 'select', options: [['any', 'Any'], ['prefer4k', 'Prefer 4K'], ['4k', '4K only'], ['preferhdr', 'Prefer HDR'], ['hdr', 'HDR only']], help: 'Prefer triples a 4K (or HDR) film\'s odds in the draw without ruling the rest out; only makes it a showcase draw.' },
  { group: 'Mystery box', key: 'MYSTERY_SKIP_DISLIKED', label: 'Skip what the house rated two stars or under', type: 'bool', default: true, help: 'The "How was it?" card\'s ratings. Off, a panned film can still be drawn, though its genres already count against it.' },
  { group: 'Mystery box', key: 'MYSTERY_RATED_ONLY', label: 'Only films with a rating', type: 'bool', default: true, help: 'G, PG, PG-13, R, NC-17 or a TV rating. Festival and straight-to-streaming titles that never got one are left out.' },
  { group: 'Mystery box', key: 'MYSTERY_MIN_CONTENT_RATING', label: 'Nothing rated below', type: 'select', options: [['any', 'Any'], ['PG', 'PG'], ['PG-13', 'PG-13'], ['R', 'R']], help: 'TV ratings count as their film equivalents (TV-14 as PG-13, TV-MA as R). PG keeps G-rated kids\' films out of an adults\' night; Family night above still applies on top.' },
  { group: 'Mystery box', key: 'MYSTERY_MAINSTREAM_ONLY', label: 'Only mainstream studios', type: 'bool', default: true, help: 'The majors and their usual partners (Disney, Warner, Universal, Paramount, Sony, Lionsgate, A24, Netflix, Legendary, Blumhouse...). Keeps out TV-movie houses, festival producers and fan compilations, which Plex often rates highly on a handful of votes.' },
  { group: 'Mystery box', key: 'MYSTERY_STUDIOS_EXTRA', label: 'Also count as mainstream', type: 'list', help: 'Studio names as Plex shows them on a film\'s page, for anything the built-in list misses.' },
  { group: 'Mystery box', key: 'MYSTERY_STUDIOS_EXCLUDE', label: 'Never these studios', type: 'list', help: 'Studio names as Plex shows them, matched loosely: "Hallmark" catches Hallmark Media and Hallmark Channel. Applies whatever else is on.' },

  { group: 'Seerr', key: 'SEERR_URL', label: 'URL', type: 'text' },
  { group: 'Seerr', key: 'SEERR_PUBLIC_URL', label: 'Address for phones', type: 'text', placeholder: 'https://seerr.bauercoulson.com', help: "What the Scan to request QR opens on a guest's phone. The URL above is how the panel reaches Seerr on your network; this is how a phone reaches it from anywhere. Blank uses the URL above." },
  { group: 'Seerr', key: 'SEERR_API_KEY', label: 'API key', type: 'secret' },
  { group: 'Seerr', key: 'SEERR_USER_ID', label: 'Request as user id', type: 'text' },
  { group: 'Seerr', key: 'SEERR_REGION', label: 'Streaming region', type: 'text', placeholder: 'US' },

  { group: 'TMDB', key: 'TMDB_API_KEY', label: 'API key', type: 'secret', help: 'Free, from themoviedb.org > Settings > API (the v3 key or the v4 read access token, either works). Only public lists are read. Blank: the holiday shelves come from Kometa\'s collections and TMDB\'s tags instead.' },
  { group: 'TMDB', key: 'TMDB_LIST_HALLOWEEN', label: 'Halloween list', type: 'text', placeholder: '7061968', help: 'The number from the list\'s address on themoviedb.org (themoviedb.org/list/7061968-halloween). Only films you own are shown, in the list\'s order.' },
  { group: 'TMDB', key: 'TMDB_LIST_CHRISTMAS', label: 'Christmas list', type: 'text', placeholder: '5915', help: 'Default: "The Best of Christmas", 105 films.' },
  { group: 'Entities', key: 'ENTITY_PROJECTOR', label: 'Projector (ADB media player)', type: 'entity', domain: 'media_player' },
  { group: 'Entities', key: 'ENTITY_APPLE_TV', label: 'Apple TV', type: 'entity', domain: 'media_player' },
  { group: 'Entities', key: 'ENTITY_APPLE_TV_REMOTE', label: 'Apple TV remote', type: 'entity', domain: 'remote' },
  { group: 'Entities', key: 'ENTITY_PLEX_PLAYER', label: 'Plex player', type: 'entity', domain: 'media_player' },
  { group: 'Entities', key: 'ENTITY_MUSIC_PLAYERS', label: 'Music players (first is the theater)', type: 'list', domain: 'media_player' },
  { group: 'Entities', key: 'ENTITY_LIGHTS', label: 'Lights', type: 'list', domain: 'light' },
  { group: 'Entities', key: 'ENTITY_ACCENT_SPEED', label: 'Effect speed (input_number)', type: 'entity', domain: 'input_number' },
  { group: 'Entities', key: 'ENTITY_ACCENT_INTENSITY', label: 'Effect intensity (input_number)', type: 'entity', domain: 'input_number' },
  { group: 'Entities', key: 'ENTITY_PICTURE_MODE', label: 'Picture mode (input_select)', type: 'entity', domain: 'input_select' },
  { group: 'Entities', key: 'ENTITY_TEMPERATURE', label: 'Temperature', type: 'entity', domain: 'sensor' },
  { group: 'Soundbar', key: 'SOUNDBAR_PREFIX', label: 'Soundbar name, as Home Assistant spells it', type: 'text', placeholder: 'jbl_bar_1300x', help: "The stem of the JBL integration's entity ids: for a device named \"JBL Bar 1300X\" every entity is number.jbl_bar_1300x_volume, switch.jbl_bar_1300x_night_mode and so on. Blank keeps volume on the Apple TV." },
  { group: 'Soundbar', key: 'SOUNDBAR_REARS', label: 'Rear speaker channels', type: 'list', placeholder: 'left, right', help: 'The channels the integration names the detachable rears by. Their battery, charging and docked sensors follow.' },
  { group: 'Soundbar', key: 'SOUNDBAR_STEP', label: 'Volume step', type: 'text', placeholder: '2', help: 'How much one tap of volume up or down moves the bar (0-100).' },
  { group: 'Soundbar', key: 'SOUNDBAR_MOVIE_SMART', label: 'Movie time turns Smart mode on and Night mode off', type: 'bool', default: true },
  { group: 'Soundbar', key: 'THX_URL', label: 'THX sound URL', type: 'text', placeholder: 'https://home-iot.coulson.io/local/theater/thx.mp3', help: 'The Deep Note, played on the theater speaker after a five-second countdown from the Sound sheet. Blank hides the button.' },
  { group: 'Soundbar', key: 'SOUNDBAR_CALIBRATION_SECONDS', label: 'Calibration takes about (seconds)', type: 'text', placeholder: '45', help: 'How long the panel asks the room to keep quiet after Calibrate.' },
  { group: 'Entities', key: 'ENTITY_PROJECTOR_TEMPS', label: 'Projector temperatures', type: 'list', domain: 'sensor', help: "The projector plugin's temperature sensors (red laser first): a line on the Projector card, and a nudge to take a break when the laser runs hot." },
  { group: 'Entities', key: 'PROJECTOR_HOT_C', label: 'Projector runs hot at (°C)', type: 'text', placeholder: '65' },
  { group: 'Entities', key: 'ENTITY_OCCUPANCY', label: 'Occupancy', type: 'entity', domain: 'binary_sensor' },
  { group: 'Entities', key: 'ENTITY_DOG_SENSORS', label: 'Dog at the door (binary sensors)', type: 'list', domain: 'binary_sensor', help: 'Any of these turning on puts a card on the panel with a camera snapshot - the deck camera\'s barking and animal detections. Blank turns it off.' },
  { group: 'Entities', key: 'ENTITY_DOG_CAMERA', label: 'Dog camera', type: 'entity', domain: 'camera', help: 'The snapshot on that card.' },
  { group: 'Entities', key: 'DOG_NAME', label: 'Dog\'s name', type: 'text', placeholder: 'Ruby' },
  { group: 'Entities', key: 'ENTITY_TAUTULLI', label: 'Tautulli watching', type: 'entity', domain: 'sensor' },

  { group: 'Lights', key: 'ACCENT_FAVOURITES', label: 'Favourite effects (up to 8)', type: 'effects', help: 'Shown first in the panel\'s Moods sheet. The rest stay under the mood tabs.' },

  { group: 'Projector apps', key: 'PROJECTOR_APPS', label: 'Apps', type: 'apps', help: 'Open on the projector over ADB. The package is the Android app id.' },

  { group: 'Games', key: 'STEAM_API_KEY', label: 'Steam Web API key', type: 'secret', help: 'steamcommunity.com/dev/apikey' },
  { group: 'Games', key: 'STEAM_ID', label: 'SteamID64', type: 'text' },

  { group: 'Access', key: 'TRUST_NETWORKS', label: 'Addresses that skip the panel key', type: 'list', placeholder: '10.2.0.0/16', help: 'The wall panel and anything on these networks get straight in. Everything else needs the key. Blank means everyone needs it.' },
  { group: 'Access', key: 'TRUSTED_PROXIES', label: 'Proxies whose forwarded address is believed', type: 'list', help: 'Traefik and the k3s ingress. Private ranges by default.' },

  { group: 'Display', key: 'THEME', label: 'Theme', type: 'select', options: [['classic', 'Classic — chocolate & copper'], ['sofa', 'Sofa — slate tweed & copper']], help: 'Sofa keeps the plaster wall and copper accent, and re-skins the dark cards, chips and Showtime in the couch\'s slate tweed. Open panels switch as soon as you save.' },
  { group: 'Display', key: 'ACCENT', label: 'Holiday accent', type: 'select', options: [['auto', 'Auto — by the calendar'], ['none', 'None'], ['halloween', 'Halloween'], ['thanksgiving', 'Thanksgiving'], ['christmas', 'Christmas'], ['newyear', 'New Year'], ['valentines', "Valentine's"], ['birthday', 'Birthday'], ['winter', 'Winter'], ['spring', 'Spring'], ['summer', 'Summer'], ['fall', 'Autumn']], help: 'Sits on top of the theme: the highlight colour, the rail\'s idle glow, an emblem by the clock and a little weather over the lobby. Auto (Australia): Halloween all October, Christmas Dec 1–30, New Year on the Eve, Valentine\'s Feb 10–14, and the southern-hemisphere season in between (summer Dec–Feb, autumn Mar–May, winter Jun–Aug, spring Sep–Nov). Thanksgiving only if picked here.' },
  { group: 'Display', key: 'ACCENT_INTENSITY', label: 'Accent weather', type: 'range', min: 0, max: 100, step: 5, default: 50, unit: '%', help: 'How much falls, drifts and flaps over the lobby: 0 is none, 25 is the original amount, 100 is four times that.' },
  { group: 'Display', key: 'BIRTHDAYS', label: 'Birthdays', type: 'text', placeholder: 'Alice=01-01, Bob=07-04', help: 'Name=MM-DD, comma separated. On the day the birthday accent wins.' },
  { group: 'Projector apps', key: 'PREROLL_URL', label: 'Pre-roll sound URL', type: 'text', placeholder: 'https://ht-kiosk.coulson.io/assets/preroll.mp3', help: 'A deep swell on the theater speakers while the lights go down, before the film starts. Must be a URL the speaker itself can fetch; the panel serves its own at /assets/preroll.mp3 with no key needed. Blank turns pre-roll off.' },
  { group: 'Projector apps', key: 'PREROLL_SECONDS', label: 'Pre-roll length (seconds)', type: 'text', placeholder: '16', help: 'How long to wait before the film starts. The panel\'s own swell runs 17 seconds.' },
  { group: 'Projector apps', key: 'PREROLL_ENABLED', label: 'Pre-roll on', type: 'bool', default: true, help: 'Off keeps the URL but skips the swell; the same switch is on the Home Assistant device.' },
  { group: 'Projector apps', key: 'PREROLL_MOVIES_ONLY', label: 'Pre-roll for films only', type: 'bool', default: true, help: 'A swell before a film is an event; before the fourth episode of a sitcom it is a delay. Off plays it for episodes too. Either way the Play button offers it for the title in front of you.' },
  { group: 'Projector apps', key: 'INTERMISSION_URL', label: 'Intermission march URL', type: 'text', placeholder: 'https://ht-kiosk.coulson.io/assets/intermission.mp3', help: "Plays in the room when Intermission starts, while the panel shows the snack bar. Blank uses the panel's own march when the pre-roll URL points at /assets/preroll.mp3; clear both to have no sound." },
  { group: 'Tonight', key: 'TRAILERS_ENABLED', label: 'Trailers before the film', type: 'bool', default: true, help: 'Coming attractions: trailers for films in the library nobody has seen yet, played on the projector before the feature. Needs the TMDB key.' },
  { group: 'Tonight', key: 'TRAILERS_COUNT', label: 'How many trailers', type: 'text', placeholder: '2' },
  { group: 'Tonight', key: 'TRAILERS_SECONDS', label: 'Seconds per trailer', type: 'text', placeholder: '150', help: 'The projector moves to the next trailer after this long; most run about two and a half minutes.' },
  { group: 'Tonight', key: 'TRAILERS_PACKAGE', label: 'App that plays them', type: 'text', placeholder: 'org.smarttube.stable', help: 'The YouTube app on the projector, by package name. SmartTube is the default; the official app is com.google.android.youtube.tv.' },
  { group: 'Tonight', key: 'PRESHOW_MINUTES', label: 'Pre-show lights before the trailers (minutes)', type: 'text', placeholder: '10', help: 'For a scheduled evening: the Pre-show scene runs this long before the trailers start. 0 skips it.' },
  { group: 'Tonight', key: 'AUTO_INTERMISSION_MINUTES', label: 'Intermission for films longer than (minutes)', type: 'text', placeholder: '120', help: 'An evening started from the panel takes its break at the halfway mark of a film at least this long. 0 never does.' },
  { group: 'Tonight', key: 'GUEST_HOURS', label: 'Guest remote lasts (hours)', type: 'text', placeholder: '6', help: 'How long the link on a guest\'s phone works after the QR is shown.' },
  { group: 'Projector apps', key: 'INTERMISSION_MINUTES', label: 'Intermission length (minutes)', type: 'text', placeholder: '15', help: 'The countdown on the snack bar screen. Five more minutes on the screen adds to it.' },
  { group: 'Year in review', key: 'WRAPPED_DATE', label: 'Send the year\'s numbers on (MM-DD)', type: 'text', placeholder: '12-26', help: 'The Wrapped message: hours, plays, the top titles, who watched most, the longest sitting. Goes out once, after 9 in the morning on that day.' },
  { group: 'Year in review', key: 'WRAPPED_NOTIFY', label: 'Send it to', type: 'list', domain: 'notify', help: 'Home Assistant notify entities: phones, the kitchen display. Empty sends nothing.' },
  { group: 'Display', key: 'ARRIVAL_HOURS', label: 'Show new arrivals for (hours)', type: 'text', placeholder: '48' },
  { group: 'Display', key: 'IDLE_MINUTES', label: 'Minutes before the Now Showing screen', type: 'text', placeholder: '8', help: '0 keeps the panel where it is. Any touch brings it straight back.' },
  { group: 'Display', key: 'CINEMA_MODE', label: 'Dim the panel when the room is dark', type: 'bool', default: true, help: 'Cinema mode: whenever the downlights are off or under a quarter, the panel drops to a dark palette instead of lighting the room from the wall. Showtime and the idle screen are dark already.' },
  { group: 'Display', key: 'SHOW_QUALITY_BADGES', label: '4K / HDR / Dolby Vision labels on posters', type: 'bool', default: true },
  { group: 'Display', key: 'SHOW_NETWORK_BADGES', label: 'Streaming network labels on posters', type: 'bool', default: false },
  { group: 'Display', key: 'FRAME_ANCESTORS', label: 'Pages allowed to embed the panel', type: 'list', help: 'The Home Assistant dashboard Kiosk Satellite shows.' },
];
const BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

// Fields that must hold an http(s) URL. A bare "10.2.3.6:8123" would be saved happily and then
// make the HA websocket constructor throw on every reconnect, so it is refused here instead.
const URL_KEYS = new Set(['HA_URL', 'PLEX_URL', 'SEERR_URL']);
function checkUrl(key, s) {
  let u;
  try { u = new URL(s); } catch { u = null; }
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) {
    throw httpError(400, `${BY_KEY[key].group} URL must start with http:// or https:// (got "${s}")`);
  }
}

// ---------- sessions ----------

const COOKIE = 'tp_admin';
const DAY = 86400e3;
// Signing key: derived from the admin password, so changing the password signs everyone out.
const key = () => createHmac('sha256', 'theater-panel-admin').update(config.adminPassword).digest();
const sign = (v) => createHmac('sha256', key()).update(v).digest('base64url');

export function isAdmin(req) {
  if (!config.adminPassword) return false;
  const raw = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '')?.[1];
  if (!raw) return false;
  const [exp, nonce, mac] = decodeURIComponent(raw).split('.');
  if (!mac || Number(exp) < Date.now()) return false;
  const a = Buffer.from(mac); const b = Buffer.from(sign(`${exp}.${nonce}`));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Wrong passwords lock the page for a while; parallel guesses hit the same counter.
let fails = 0;
let lockedUntil = 0;

export async function login(res, body, https = true) {
  if (!config.adminPassword) throw httpError(403, 'Set ADMIN_PASSWORD on the container to use the admin page.');
  if (Date.now() < lockedUntil) throw httpError(429, `Too many attempts. Try again in ${Math.ceil((lockedUntil - Date.now()) / 1000)}s.`);
  const a = Buffer.from(String(body.password || '')); const b = Buffer.from(config.adminPassword);
  if (!(a.length === b.length && timingSafeEqual(a, b))) {
    fails += 1;
    if (fails >= 5) { lockedUntil = Date.now() + Math.min(15 * 60e3, 30e3 * 2 ** (fails - 5)); }
    await new Promise((r) => setTimeout(r, 800));
    throw httpError(401, 'Wrong password');
  }
  fails = 0; lockedUntil = 0;
  const exp = Date.now() + 30 * DAY; const nonce = randomBytes(9).toString('base64url');
  const v = `${exp}.${nonce}.${sign(`${exp}.${nonce}`)}`;
  res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(v)}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Strict${https ? '; Secure' : ''}`);
  return { ok: true };
}

export function logout(res) {
  res.setHeader('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
  return { ok: true };
}

export function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// ---------- settings ----------

// What the page shows: each field's saved value, the container's value underneath it, and for
// secrets only whether one is set.
export async function view() {
  const saved = settings().vars;
  const env = process.env;
  const values = {};
  for (const f of FIELDS) {
    const own = saved[f.key]; const base = env[f.key];
    values[f.key] = f.type === 'secret' || f.type === 'plexlogin'
      ? { saved: Boolean(own), container: Boolean(base) }
      : { saved: own ?? '', container: base ?? '' };
  }
  const gamesSaved = Boolean(settings().games);
  return {
    fields: FIELDS, values, rev: settings().rev || 0,
    // The link the wall panel (and any browser) needs: without the key everything returns 401.
    panelKey: config.panelKey,
    open: !config.panelKey,
    // Who is asking right now, so the page can suggest a sensible trusted network.
    trustedNetworks: config.trustedNetworks,
    // Settings still coming from the container (what Import would copy).
    fromContainer: FIELDS.filter((f) => process.env[f.key] && !saved[f.key]).map((f) => f.key),
    games: (await loadGames()) || { switcher: {}, sources: [] },
    gamesSource: gamesSaved ? 'admin' : (await loadGamesFile()) ? 'file' : 'none',
  };
}

// The panel's own settings sheet (seven taps on the version number in the rail): the harmless
// knobs only - the Mystery box rules, the look, the pre-roll timing - and nothing that connects
// to anything: no URLs, tokens, entities or networks. Values are the effective ones: the saved
// value, else the container's, else the field's default.
const TWEAK_KEYS = new Set([
  ...FIELDS.filter((f) => f.group === 'Mystery box').map((f) => f.key),
  'THEME', 'ACCENT', 'ACCENT_INTENSITY', 'BIRTHDAYS', 'ARRIVAL_HOURS', 'IDLE_MINUTES', 'CINEMA_MODE', 'SHOW_QUALITY_BADGES', 'SHOW_NETWORK_BADGES',
  'PREROLL_ENABLED', 'PREROLL_MOVIES_ONLY', 'PREROLL_SECONDS', 'INTERMISSION_MINUTES', 'WRAPPED_DATE',
  ...FIELDS.filter((f) => f.group === 'Tonight').map((f) => f.key),
]);

export async function tweaks() {
  const saved = settings().vars;
  const fields = FIELDS.filter((f) => TWEAK_KEYS.has(f.key))
    .map((f) => ({ ...f, value: saved[f.key] ?? process.env[f.key] ?? (f.default == null ? '' : String(f.default)) }));
  const libraries = fields.some((f) => f.type === 'libraries') ? await plexLibraries().catch(() => []) : [];
  return { fields, libraries: libraries.filter((l) => l.type === 'movie').map((l) => l.title) };
}

export function saveTweaks(values = {}) {
  return save({ values: Object.fromEntries(Object.entries(values).filter(([k]) => TWEAK_KEYS.has(k))) });
}

// body: { values: { KEY: string | null }, games?: object }. For secrets, '' or a missing key
// keeps the saved secret and null removes it; for everything else '' falls back to the container.
export function save(body) {
  const cur = settings();
  // A page loaded before someone else's save (another tab, an import) must reload first.
  if (body.rev !== undefined && body.rev !== (cur.rev || 0)) throw httpError(409, 'Settings changed since this page loaded. Reload and try again.');
  const vars = { ...cur.vars };
  for (const [k, v] of Object.entries(body.values || {})) {
    const f = BY_KEY[k];
    if (!f) continue;
    if (f.type === 'secret') {
      if (v === null) delete vars[k];
      else if (typeof v === 'string' && v.trim()) vars[k] = v.trim();
      continue;
    }
    const s = v == null ? '' : String(v).trim();
    if (s !== '' && URL_KEYS.has(k)) checkUrl(k, s);
    if (s === '') delete vars[k]; else vars[k] = s;
  }
  let games = cur.games;
  if (body.games !== undefined) games = body.games === null ? null : cleanGames(body.games);
  saveSettings({ vars, games, rev: (cur.rev || 0) + 1 });
  return { ok: true };
}

// Copy every setting that only exists on the container (tokens included) and the games.json
// sources into the saved settings, so the container's variables can then be deleted.
export async function importContainer(rev) {
  const cur = settings();
  if (rev !== undefined && rev !== (cur.rev || 0)) throw httpError(409, 'Settings changed since this page loaded. Reload and try again.');
  const vars = { ...cur.vars };
  const copied = [];
  for (const f of FIELDS) {
    const v = process.env[f.key];
    if (v && !vars[f.key]) { vars[f.key] = v; copied.push(f.key); }
  }
  let games = cur.games;
  if (!games) { const file = await loadGamesFile(); if (file) { games = cleanGames(file); copied.push('games.json'); } }
  saveSettings({ vars, games, rev: (cur.rev || 0) + 1 });
  return { ok: true, copied };
}

const ID = /^[a-z0-9_-]{1,32}$/;
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
function cleanGames(g) {
  const out = { v: 2, switcher: {}, sources: [] };
  if (g.switcher?.entity) {
    if (!ENTITY.test(g.switcher.entity)) throw httpError(400, `Bad switcher entity: ${g.switcher.entity}`);
    out.switcher = { entity: g.switcher.entity, projectorInput: String(g.switcher.projectorInput || 'HDMI 3') };
  }
  for (const s of g.sources || []) {
    const id = String(s.id || s.name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
    if (!ID.test(id) || !s.name) throw httpError(400, 'Every source needs a name');
    const src = { id, name: String(s.name).slice(0, 24), icon: String(s.icon || 'pad'), via: s.via === 'switcher' ? 'switcher' : 'projector' };
    if (src.via === 'switcher') {
      const n = Number(s.input);
      if (Number.isInteger(n) && n >= 1 && n <= 8) src.input = n;
      else src.option = String(s.option || s.name); // older configs: the option name itself
    } else src.projectorInput = String(s.projectorInput || 'HDMI 2');
    if (s.games === false) src.games = false;
    if (s.haScript) src.haScript = String(s.haScript);
    out.sources.push(src);
  }
  if (g.pc) out.pc = cleanPc(g.pc);
  return out;
}

// The gaming PC block is read at boot (its entities join the HA subscription), so a malformed one
// saved here would crash the server every time it started. Only the shapes the panel draws are
// kept: strings for names, entity ids for anything HA is asked about.
const SENSOR_KINDS = ['percent', 'temp', 'value'];
function cleanPc(pc) {
  if (typeof pc !== 'object' || Array.isArray(pc)) throw httpError(400, 'pc must be an object');
  const entity = (v, what) => {
    if (!ENTITY.test(String(v))) throw httpError(400, `Bad ${what}: ${v}`);
    return String(v);
  };
  const out = { name: String(pc.name || 'Gaming PC').slice(0, 40) };
  if (pc.power) out.power = entity(pc.power, 'PC power entity');
  if (pc.launchScript) out.launchScript = entity(pc.launchScript, 'PC launch script');
  if (pc.sensors !== undefined) {
    if (!Array.isArray(pc.sensors)) throw httpError(400, 'pc.sensors must be a list');
    out.sensors = pc.sensors.map((s) => ({
      entity: entity(s?.entity, 'PC sensor'),
      label: String(s.label || '').slice(0, 24),
      kind: SENSOR_KINDS.includes(s.kind) ? s.kind : 'value',
    }));
  }
  if (pc.stats) {
    if (typeof pc.stats !== 'object' || Array.isArray(pc.stats)) throw httpError(400, 'pc.stats must be an object');
    const stats = {};
    for (const role of STAT_ROLES) if (pc.stats[role]) stats[role] = entity(pc.stats[role], `stats ${role}`);
    if (pc.stats.cores !== undefined) {
      if (!Array.isArray(pc.stats.cores)) throw httpError(400, 'pc.stats.cores must be a list');
      stats.cores = pc.stats.cores.map((c) => entity(c, 'core sensor'));
    }
    out.stats = stats;
  }
  return out;
}

// ---------- helpers for the page ----------

// The room's own moods: the effects built for the accent lights. Other lights (the WLED strip)
// carry hundreds of stock effects, which are not what the panel offers.
export function lightEffects(ha) {
  const ids = config.entities.lights;
  const accent = ids.find((id) => /accent/.test(id)) || ids[0];
  const list = ha.states[accent]?.attributes?.effect_list || [];
  return list.filter((e) => e !== 'None' && !/^Calibrate/i.test(e));
}

// Plex's movie and TV libraries, for the library picker.
export async function plexLibraries() {
  const { url, token } = config.plex;
  if (!url) return [];
  const r = await fetch(`${url}/library/sections?X-Plex-Token=${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw httpError(502, `Plex ${r.status}`);
  return ((await r.json()).MediaContainer.Directory || [])
    .filter((d) => d.type === 'movie' || d.type === 'show')
    .map((d) => ({ title: d.title, type: d.type }));
}

// Entity ids and names from HA, for the pickers.
export async function haEntities(ha) {
  const states = await ha.request({ type: 'get_states' });
  return states.map((s) => ({
    id: s.entity_id, name: s.attributes?.friendly_name || '',
    ...(s.entity_id.startsWith('select.') || s.entity_id.startsWith('input_select.') ? { options: s.attributes?.options || [] } : {}),
  }));
}

// Try a service with the settings as they would be after saving (unsaved field values win).
export async function test(service, values = {}) {
  const v = { ...effectiveVars() };
  for (const [k, val] of Object.entries(values)) if (typeof val === 'string' && val.trim()) v[k] = val.trim();
  const t = AbortSignal.timeout(8000);
  const need = { ha: ['HA_URL', 'HA_TOKEN'], plex: ['PLEX_URL', 'PLEX_TOKEN'], seerr: ['SEERR_URL', 'SEERR_API_KEY'], tmdb: ['TMDB_API_KEY'], wrapped: ['WRAPPED_NOTIFY'] }[service];
  if (!need) throw httpError(400, 'Unknown service');
  const gone = need.filter((k) => !v[k]);
  if (gone.length) return { ok: false, detail: `${gone.join(' and ')} not set` };
  try {
    if (service === 'ha') {
      const r = await fetch(`${v.HA_URL.replace(/\/$/, '')}/api/`, { headers: { Authorization: `Bearer ${v.HA_TOKEN}` }, signal: t });
      return r.ok ? { ok: true, detail: (await r.json()).message } : { ok: false, detail: `HTTP ${r.status}` };
    }
    if (service === 'plex') {
      const r = await fetch(`${v.PLEX_URL.replace(/\/$/, '')}/identity?X-Plex-Token=${encodeURIComponent(v.PLEX_TOKEN || '')}`, { headers: { Accept: 'application/json' }, signal: t });
      const libs = await fetch(`${v.PLEX_URL.replace(/\/$/, '')}/library/sections?X-Plex-Token=${encodeURIComponent(v.PLEX_TOKEN || '')}`, { headers: { Accept: 'application/json' }, signal: t });
      if (!libs.ok) return { ok: false, detail: `HTTP ${libs.status}` };
      const names = ((await libs.json()).MediaContainer.Directory || []).map((d) => d.title);
      return { ok: r.ok, detail: `Libraries: ${names.join(', ')}` };
    }
    if (service === 'seerr') {
      const r = await fetch(`${v.SEERR_URL.replace(/\/$/, '')}/api/v1/settings/main`, { headers: { 'X-Api-Key': v.SEERR_API_KEY || '' }, signal: t });
      return r.ok ? { ok: true, detail: (await r.json()).applicationTitle || 'Connected' } : { ok: false, detail: `HTTP ${r.status}` };
    }
    if (service === 'tmdb') {
      // Read the Christmas list: proves the key and that the list exists.
      const id = String(v.TMDB_LIST_CHRISTMAS || '5915').match(/\d+/)?.[0] || '5915';
      const key = v.TMDB_API_KEY, bearer = key.startsWith('eyJ');
      const r = await fetch(`https://api.themoviedb.org/3/list/${id}${bearer ? '' : `?api_key=${encodeURIComponent(key)}`}`,
        { headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${key}` } : {}) }, signal: t });
      if (!r.ok) return { ok: false, detail: r.status === 401 ? 'TMDB refused the key' : r.status === 404 ? 'That list was not found' : `HTTP ${r.status}` };
      const d = await r.json();
      return { ok: true, detail: `"${d.name || 'Christmas list'}": ${d.item_count ?? d.items?.length ?? '?'} films` };
    }
  } catch (e) { return { ok: false, detail: e.message }; }
  throw httpError(400, 'Unknown service');
}

// The plex.tv sign-in for the watchlist: start hands back a code and the page to approve it on;
// check polls until plex.tv has the token, then saves it like any other setting.
export const plexPinStart = () => plex.pinStart();
export async function plexPinCheck(id) {
  const token = await plex.pinCheck(id);
  if (!token) return { done: false };
  const who = await plex.account(token).catch(() => null);
  save({ values: { PLEX_ACCOUNT_TOKEN: token } });
  return { done: true, username: who?.username || who?.title || 'signed in' };
}
export const plexAccount = () => plex.account().catch((e) => ({ error: e.message }));

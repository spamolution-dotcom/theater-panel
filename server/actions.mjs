// Everything the panel can make happen. The panel never calls arbitrary HA services: each
// action here maps to one allowlisted call, mostly the theater_* scripts in ha/theater.yaml,
// so the same behavior is available to Pico remotes, voice and automations too.

import { config } from './config.mjs';
import * as accents from './accents.mjs';
import * as plex from './media.mjs';
import { extImage } from './images.mjs';
import * as games from './games.mjs';
import { httpError } from './admin.mjs';

const SCENES = ['pre_show', 'movie_time', 'intermission', 'lights_up', 'all_off'];
// When the room's speaker is not there, a sound goes to the wall panel instead (it plays it
// through its own speaker). index.mjs wires this to the live connection.
let toPanels = () => {};
export const onPanelSound = (fn) => { toPanels = fn; };
const up = (ha, id) => Boolean(id) && !['unavailable', 'unknown', undefined].includes(ha.states[id]?.state);
// What the panel plays when no speaker can: its own sounds by path (so the same file plays from
// whichever address the panel was opened on), anything else by its full http(s) address, which
// the panel fetches itself (a sound under Home Assistant's www folder, say).
const panelPath = (url) => {
  try { const u = new URL(url); return u.pathname.startsWith('/assets/') ? u.pathname : /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
};

export const script = (ha, name, variables = {}) => ha.callService('script', 'turn_on', { variables }, { target: { entity_id: `script.theater_${name}` } });

export async function runAction(ha, body) {
  const e = config.entities;
  switch (body.action) {
    case 'scene': {
      if (!SCENES.includes(body.name)) throw new Error('Unknown scene');
      const run = await script(ha, body.name);
      // The bar follows the room: a film gets Smart mode and no Night mode, unless told otherwise.
      if (body.name === 'movie_time' && e.soundbar && config.soundbarMovieSmart) {
        soundbar(ha, { cmd: 'smart', on: true }).catch(() => {});
        soundbar(ha, { cmd: 'night', on: false }).catch(() => {});
      }
      // The break gets its jingle: the panel shows the snack bar, the room hears the march.
      if (body.name === 'intermission' && config.intermission.url && body.quiet !== true) {
        const speaker = e.musicPlayers[0] || e.musicPlayer;
        if (up(ha, speaker)) {
          script(ha, 'snipe', { speaker, url: config.intermission.url })
            .catch((err) => console.warn('[intermission] no march:', err.message));
        } else if (panelPath(config.intermission.url)) toPanels({ url: panelPath(config.intermission.url) });
      }
      return run;
    }

    case 'play': {
      // With a pre-roll configured, the swell starts on the theater speakers while the lights go
      // down and the film follows a few seconds later. Returns at once so the panel is not held
      // open for the length of the swell. A film gets it; the next episode of a sitcom does not,
      // unless the Play button says otherwise (body.preroll true or false decides).
      if (!body.noPreroll && wantsPreroll(body)) {
        // The theater's speaker is the Apple TV over AirPlay, which is asleep whenever a film
        // plays on the projector. Then the lights still go down and the panel plays the swell.
        const speaker = e.musicPlayers[0] || e.musicPlayer;
        const url = prerollUrl();
        const onSpeaker = up(ha, speaker);
        await script(ha, 'preroll', { speaker, url: onSpeaker ? url : '' });
        if (!onSpeaker && panelPath(url)) toPanels({ url: panelPath(url) });
        setTimeout(() => runAction(ha, { ...body, noPreroll: true }).catch((err) => console.warn('[preroll] film did not start:', err.message)), config.preroll.seconds * 1000);
        return { preroll: config.preroll.seconds };
      }
      if (config.playTarget === 'stremio') return playStremio(ha, body);
      // Store the chosen tracks on the Plex part first, then hand over to HA, which wakes the
      // projector, opens Plex on the Apple TV, starts playback and runs Movie time.
      // Both ids become path segments on the Plex server, so only plain numbers are accepted.
      if (!/^\d+$/.test(String(body.ratingKey))) throw httpError(400, 'Bad ratingKey');
      if (body.partId != null && !/^\d+$/.test(String(body.partId))) throw httpError(400, 'Bad partId');
      if (body.partId && (body.audioStreamID != null || body.subtitleStreamID != null)) {
        await plex.setStreams(body.partId, body).catch((err) => console.warn('[plex] setStreams', err.message));
      }
      plex.staleMovies(); // watched / in-progress state is about to change
      if (config.playTarget === 'plezy') {
        // Plezy resumes by itself, so Start over clears the saved position first.
        if (!body.offset) await plex.clearProgress(body.ratingKey).catch((err) => console.warn('[plex] start over', err.message));
        const id = `plezy_${await plex.machineId()}_${Number(body.ratingKey)}`;
        return script(ha, 'play_projector', {
          projector: e.projector, apple_tv: e.appleTv, package: config.plezyPackage,
          uri: `plezy://play?content_id=${id}`,
        });
      }
      if (config.playTarget === 'plex') {
        // The official Plex app on the projector: open it over ADB, then play through its Plex client.
        return script(ha, 'play_projector_plex', {
          projector: e.projector, apple_tv: e.appleTv, package: config.projectorPlexPackage,
          plex_player: e.projectorPlexPlayer,
          rating_key: String(body.ratingKey),
          media_type: body.type === 'episode' ? 'episode' : 'movie',
          offset: Math.round((body.offset || 0) / 1000),
        });
      }
      return script(ha, 'play_plex', {
        rating_key: String(body.ratingKey),
        media_type: body.type === 'episode' ? 'episode' : 'movie',
        offset: Math.round((body.offset || 0) / 1000),
        apple_tv: e.appleTv,
        plex_player: e.plexPlayer,
      });
    }

    // Light effects and their speed / intensity helpers (the picker on the Lights card).
    case 'light_effect': {
      if (!e.lights.includes(body.entity_id)) throw new Error('Unknown light');
      const effect = String(body.effect || '').slice(0, 64);
      if (!effect) throw new Error('No effect');
      return ha.callService('light', 'turn_on', { effect }, { target: { entity_id: body.entity_id } });
    }

    case 'light_number': {
      const allowed = [e.accentSpeed, e.accentIntensity].filter(Boolean);
      if (!allowed.includes(body.entity_id)) throw new Error('Unknown helper');
      return ha.callService('input_number', 'set_value', { value: clamp(Number(body.value), 0, 255) }, { target: { entity_id: body.entity_id } });
    }

    case 'soundbar': return soundbar(ha, body);

    // The Deep Note: on the theater speaker when it is up, on the panel itself otherwise, the
    // same way the pre-roll and the march travel. The panel counts down before asking.
    case 'thx': {
      if (!config.thxUrl) throw new Error('No THX sound on the settings page');
      const speaker = e.musicPlayers[0] || e.musicPlayer;
      if (up(ha, speaker)) return script(ha, 'snipe', { speaker, url: config.thxUrl });
      if (panelPath(config.thxUrl)) { toPanels({ url: panelPath(config.thxUrl) }); return { panel: true }; }
      throw new Error('The theater speaker is not up');
    }

    case 'transport': {
      if (config.playTarget === 'stremio') return streamerTransport(ha, body);
      // Volume and mute go to the soundbar once there is one: it is the thing making the sound.
      if (e.soundbar && ['vol_up', 'vol_down', 'mute'].includes(body.cmd)) return soundbar(ha, { cmd: body.cmd, on: body.muted });
      // Films in Plezy play on the projector's own Android, where the Apple TV cannot pause
      // them: whichever player actually has something going gets the button.
      if (transportTarget(ha) === 'projector') return projectorKey(ha, body);
      const target = { entity_id: e.appleTv };
      const map = { play_pause: 'media_play_pause', play: 'media_play', pause: 'media_pause', stop: 'media_stop', vol_up: 'volume_up', vol_down: 'volume_down' };
      if (map[body.cmd]) return ha.callService('media_player', map[body.cmd], {}, { target });
      if (body.cmd === 'mute') return ha.callService('media_player', 'volume_mute', { is_volume_muted: Boolean(body.muted) }, { target });
      if (body.cmd === 'seek_rel') {
        const s = ha.states[e.appleTv]?.attributes || {};
        const pos = livePosition(s);
        if (pos == null) throw new Error('Position unknown');
        const to = Math.max(0, Math.min((s.media_duration || Infinity) - 1, pos + Number(body.seconds || 0)));
        return ha.callService('media_player', 'media_seek', { seek_position: to }, { target });
      }
      throw new Error('Unknown transport command');
    }

    case 'light': {
      if (!e.lights.includes(body.entity_id)) throw new Error('Unknown light');
      const target = { entity_id: body.entity_id };
      if (body.on === false) return ha.callService('light', 'turn_off', {}, { target });
      const data = {};
      if (body.brightness_pct != null) data.brightness_pct = clamp(body.brightness_pct, 1, 100);
      if (body.rgb_color) data.rgb_color = body.rgb_color.slice(0, 3).map((n) => clamp(n, 0, 255));
      if (body.color_temp_kelvin) data.color_temp_kelvin = clamp(body.color_temp_kelvin, 2000, 6500);
      return ha.callService('light', 'turn_on', data, { target });
    }

    case 'aisle_glow': return script(ha, 'aisle_glow');

    // This fork's Cinema card: start the room (your movie scene), Denon volume and input.
    case 'cinema': {
      if (body.cmd === 'on') return ha.callService('input_boolean', 'turn_on', {}, { target: { entity_id: e.roomOn } });
      if (body.cmd === 'volume') {
        // Capped at 75%: a slip of the finger on a wall tablet should not blow the speakers.
        const level = Math.min(0.75, clamp(Number(body.value), 0, 100) / 100);
        return ha.callService('media_player', 'volume_set', { volume_level: Math.round(level * 100) / 100 }, { target: { entity_id: e.avr } });
      }
      if (body.cmd === 'source') {
        const allowed = ['GoogleTVStreamer', 'Xbox One'];
        if (!allowed.includes(body.source)) throw httpError(400, 'Unknown source');
        return ha.callService('media_player', 'select_source', { source: body.source }, { target: { entity_id: e.avr } });
      }
      throw httpError(400, 'Unknown cinema command');
    }

    case 'projector': {
      const allowed = { power_on: [], power_off: [], light_on: [], light_off: [], source: ['source'], picture: ['mode'] };
      if (!(body.cmd in allowed)) throw new Error('Unknown projector command');
      const vars = { projector: e.projector, apple_tv: e.appleTv };
      for (const k of allowed[body.cmd]) vars[k] = String(body[k] || '');
      if (body.cmd === 'source' && vars.source === 'Apple TV') games.setActive('appletv');
      return script(ha, `projector_${body.cmd}`, vars);
    }

    case 'picture_next': {
      // Next picture mode; HA's automation applies it to the projector over ADB.
      if (!e.pictureMode) throw new Error('No picture mode entity set');
      return ha.callService('input_select', 'select_next', { cycle: true }, { target: { entity_id: e.pictureMode } });
    }

    case 'projector_app': {
      // Only apps listed in PROJECTOR_APPS; HA wakes the projector first if it is off.
      const app = config.projectorApps.find((a) => a.package === body.package);
      if (!app) throw new Error('Unknown projector app');
      games.setActive(null);
      return script(ha, 'projector_app', { projector: e.projector, apple_tv: e.appleTv, package: app.package });
    }

    case 'music': {
      const player = e.musicPlayers.includes(body.entity_id) ? body.entity_id : e.musicPlayer;
      const target = { entity_id: player };
      const simple = { play_pause: 'media_play_pause', next: 'media_next_track', previous: 'media_previous_track' };
      if (simple[body.cmd]) return ha.callService('media_player', simple[body.cmd], {}, { target });
      if (body.cmd === 'volume') return ha.callService('media_player', 'volume_set', { volume_level: clamp(body.level, 0, 1) }, { target });
      if (body.cmd === 'shuffle') return ha.callService('media_player', 'shuffle_set', { shuffle: Boolean(body.on) }, { target });
      if (body.cmd === 'repeat') return ha.callService('media_player', 'repeat_set', { repeat: ['off', 'all', 'one'].includes(body.mode) ? body.mode : 'off' }, { target });
      if (body.cmd === 'play_media') {
        return ha.callService('music_assistant', 'play_media', {
          media_id: String(body.uri), media_type: body.media_type, enqueue: body.enqueue || 'replace',
        }, { target });
      }
      if (body.cmd === 'transfer') {
        const to = e.musicPlayers.includes(body.to) ? body.to : null;
        if (!to) throw new Error('Unknown player');
        return ha.callService('music_assistant', 'transfer_queue', { source_player: player, auto_play: true }, { target: { entity_id: to } });
      }
      throw new Error('Unknown music command');
    }

    case 'game_source': return games.selectSource(ha, String(body.id));
    case 'game_pc_power': return games.pcPower(ha, body.on !== false);
    case 'game_launch': return games.launchSteamGame(ha, body.appid);

    default: throw httpError(400, 'Unknown action');
  }
}

// Which player the Showtime buttons should drive: the Apple TV while it is actually playing or
// paused on something, otherwise the projector (Plezy or the Plex app on its own Android).
const ACTIVE = ['playing', 'paused', 'buffering'];
export function transportTarget(ha) {
  const e = config.entities;
  if (ACTIVE.includes(ha.states[e.appleTv]?.state)) return 'appletv';
  const proj = ha.states[e.projector]?.state;
  if (e.projector && proj && !['unavailable', 'unknown', 'off'].includes(proj)) return 'projector';
  return 'appletv';
}

// The projector's buttons, as Android key presses over ADB. Play and pause are the separate
// keys rather than the toggle wherever the panel knows which it wants, so a missed state can't
// flip the film the wrong way. Skips are the media fast-forward / rewind keys; how far they jump
// is up to the app playing.
const KEYS = {
  play_pause: 85, play: 126, pause: 127, stop: 86,
  vol_up: 24, vol_down: 25, mute: 164,
};
function projectorKey(ha, body) {
  let code = KEYS[body.cmd];
  if (body.cmd === 'seek_rel') code = Number(body.seconds) < 0 ? 89 : 90;
  if (!code) throw new Error('Unknown transport command');
  return ha.callService('androidtv', 'adb_command', { command: `input keyevent ${code}` }, { target: { entity_id: config.entities.projector } });
}

// HA reports media_position as of media_position_updated_at; add the time since then when playing.
export function livePosition(a, state) {
  if (a.media_position == null) return null;
  let pos = a.media_position;
  if ((state ?? 'playing') === 'playing' && a.media_position_updated_at) {
    pos += (Date.now() - Date.parse(a.media_position_updated_at)) / 1000;
  }
  return pos;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n)));

// The soundbar, through the JBL integration's entities: volume as a number, the modes as
// switches, the EQ as a select and seven numbers, the rest as buttons the bar's remote has.
async function soundbar(ha, body) {
  const sb = config.entities.soundbar;
  if (!sb) throw new Error('No soundbar on the settings page');
  const number = (id, value) => ha.callService('number', 'set_value', { value }, { target: { entity_id: id } });
  const press = (id) => ha.callService('button', 'press', {}, { target: { entity_id: id } });
  const flip = (id, on) => ha.callService('switch', on ? 'turn_on' : 'turn_off', {}, { target: { entity_id: id } });
  const level = () => Number(ha.states[sb.volume]?.state);
  switch (body.cmd) {
    case 'volume': return number(sb.volume, clamp(body.value, 0, 100));
    case 'vol_up': return Number.isFinite(level()) ? number(sb.volume, clamp(level() + config.soundbarStep, 0, 100)) : press(sb.buttons.volumeUp);
    case 'vol_down': return Number.isFinite(level()) ? number(sb.volume, clamp(level() - config.soundbarStep, 0, 100)) : press(sb.buttons.volumeDown);
    case 'mute': return press(sb.buttons.mute);
    case 'night': return flip(sb.night, Boolean(body.on));
    case 'purevoice': return flip(sb.pureVoice, Boolean(body.on));
    case 'smart': return flip(sb.smart, Boolean(body.on));
    // Late night: quieter dynamics and clearer speech together, and back again.
    case 'late_night': return Promise.all([flip(sb.night, Boolean(body.on)), flip(sb.pureVoice, Boolean(body.on))]);
    case 'power': return flip(sb.power, Boolean(body.on));
    case 'preset': return ha.callService('select', 'select_option', { option: String(body.option || '').slice(0, 64) }, { target: { entity_id: sb.preset } });
    case 'band': {
      const i = Number(body.index);
      if (!Number.isInteger(i) || i < 0 || i >= sb.bands.length) throw new Error('Unknown band');
      return number(sb.bands[i], clamp(body.value, -9, 9));
    }
    case 'custom': {
      const i = Number(body.index);
      if (!Number.isInteger(i) || i < 0 || i >= sb.custom.length) throw new Error('Unknown band');
      return number(sb.custom[i], clamp(body.value, -9, 9));
    }
    case 'bass': return press(sb.buttons.bass);
    case 'rear': return press(sb.buttons.rear);
    case 'atmos': return press(sb.buttons.atmos);
    case 'moment': return press(sb.buttons.moment);
    case 'calibrate': return press(sb.buttons.calibration);
    default: throw new Error('Unknown soundbar command');
  }
}

// Which swell: the creature feature sting while the Halloween accent is up, the usual one
// otherwise. (The accent follows the calendar unless it is pinned on the settings page.)
export function prerollUrl() {
  const accent = accents.resolve(config.ui.accent, accents.parseBirthdays(config.ui.birthdays));
  return accent.id === 'halloween' && config.preroll.spookyUrl ? config.preroll.spookyUrl : config.preroll.url;
}

// Whether this Play should be led in by the swell: the panel's own choice when it made one,
// otherwise the rule (configured at all, and a film rather than an episode).
export function wantsPreroll(body = {}) {
  if (!config.preroll.url || !config.preroll.enabled) return false;
  if (body.preroll === true || body.preroll === false) return body.preroll;
  return !(config.preroll.moviesOnly && body.type === 'episode');
}

// ---------- Music Assistant data, read through HA's music_assistant actions ----------

let maEntry = null;
async function maEntryId(ha) {
  if (maEntry) return maEntry;
  const entries = await ha.request({ type: 'config_entries/get', domain: 'music_assistant' });
  maEntry = entries.find((x) => x.state === 'loaded')?.entry_id || entries[0]?.entry_id;
  if (!maEntry) throw new Error('Music Assistant integration not found in HA');
  return maEntry;
}

function mapMusic(i) {
  return {
    uri: i.uri,
    type: i.media_type,
    name: i.name,
    artist: (i.artists || []).map((a) => a.name).join(', ') || i.owner || undefined,
    album: i.album?.name,
    year: i.year,
    duration: i.duration,
    // MA's image proxy serves originals at size=0; ask for 512 (it accepts 80, 160, 256, 512, 1024).
    image: extImage(typeof i.image === 'string' ? i.image.replace(/([?&]size=)0\b/, '$1512') : i.image?.path),
  };
}

export async function musicLibrary(ha, { type = 'album', order = 'timestamp_added_desc', limit = 24, favorite } = {}) {
  const res = await ha.callService('music_assistant', 'get_library', {
    config_entry_id: await maEntryId(ha), media_type: type, order_by: order, limit: Number(limit),
    ...(favorite ? { favorite: true } : {}),
  }, { returnResponse: true });
  return (res?.items || []).map(mapMusic);
}

export async function musicSearch(ha, query) {
  const res = await ha.callService('music_assistant', 'search', {
    config_entry_id: await maEntryId(ha), name: String(query), limit: 12,
  }, { returnResponse: true });
  const out = {};
  for (const k of ['artists', 'albums', 'tracks', 'playlists', 'radio']) out[k] = (res?.[k] || []).map(mapMusic);
  return out;
}

export async function musicQueue(ha, entityId) {
  const player = config.entities.musicPlayers.includes(entityId) ? entityId : config.entities.musicPlayer;
  const state = ha.states[player]?.state;
  if (!state || state === 'unavailable') return { player, unavailable: true };
  const res = await ha.callService('music_assistant', 'get_queue', {}, { target: { entity_id: player }, returnResponse: true }).catch(() => null);
  const q = res?.[player];
  if (!q) return null;
  const item = (x) => x && ({
    id: x.queue_item_id, name: x.name, duration: x.duration,
    ...(x.media_item ? mapMusic(x.media_item) : {}),
  });
  return {
    player, name: q.display_name || q.name, shuffle: q.shuffle_enabled, repeat: q.repeat_mode,
    elapsed: q.elapsed_time, current: item(q.current_item), next: item(q.next_item),
    // get_queue returns the current and next item only; items is the queue length.
    count: typeof q.items === 'number' ? q.items : (q.items || []).length,
  };
}

// ---------- Stremio on the Google TV Streamer (this fork) ----------

// The title the panel last sent to the Streamer. Stremio's own "now playing" comes from its cloud
// sync and can be hours stale, so the panel remembers what it asked for.
let launched = null;
export const lastLaunched = () => launched;

// A Stremio deep link opens the title's stream list in the Stremio app on the Streamer; someone in
// the room picks the stream with the remote. Ids: tt… (film or series), tt…:S:E (episode).
export function stremioLink(id, type) {
  const s = String(id || '');
  if (!/^[A-Za-z0-9_.%-]+(?::\d+:\d+)?$/.test(s)) throw httpError(400, 'Bad title id');
  const [base, season, episode] = s.split(':');
  if (season && episode) return `stremio:///detail/series/${base}/${s}`;
  if (type === 'show') return `stremio:///detail/series/${base}`;
  return `stremio:///detail/movie/${base}/${base}`;
}

async function playStremio(ha, body) {
  const link = stremioLink(body.ratingKey, body.type);
  const kind = body.type === 'episode' || body.type === 'show' ? 'episode' : 'movie';
  launched = { id: String(body.ratingKey), type: body.type, title: body.title || null, at: Date.now() };
  plex.item(String(body.ratingKey)).then((it) => { if (launched?.id === String(body.ratingKey)) launched = { ...launched, ...it, at: launched.at }; }).catch(() => {});
  plex.staleMovies();
  return script(ha, 'play_stremio', { link, kind });
}

// Pause and play are key presses on the Streamer's remote (Stremio's player takes them); volume and
// mute go to the Denon, which is the thing making the sound.
async function streamerTransport(ha, body) {
  const e = config.entities;
  const key = { play_pause: 'MEDIA_PLAY_PAUSE', play: 'MEDIA_PLAY', pause: 'MEDIA_PAUSE', stop: 'MEDIA_STOP' }[body.cmd];
  if (key) return ha.callService('remote', 'send_command', { command: key }, { target: { entity_id: e.appleTvRemote } });
  if (body.cmd === 'seek_rel') {
    const n = Number(body.seconds || 0);
    return ha.callService('remote', 'send_command', { command: n < 0 ? 'MEDIA_REWIND' : 'MEDIA_FAST_FORWARD' }, { target: { entity_id: e.appleTvRemote } });
  }
  const target = { entity_id: e.avr };
  if (body.cmd === 'vol_up') return ha.callService('media_player', 'volume_up', {}, { target });
  if (body.cmd === 'vol_down') return ha.callService('media_player', 'volume_down', {}, { target });
  if (body.cmd === 'mute') return ha.callService('media_player', 'volume_mute', { is_volume_muted: Boolean(body.muted) }, { target });
  throw new Error('Unknown transport command');
}

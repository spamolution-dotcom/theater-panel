// Everything the panel can make happen. The panel never calls arbitrary HA services: each
// action here maps to one allowlisted call, mostly the theater_* scripts in ha/theater.yaml,
// so the same behavior is available to Pico remotes, voice and automations too.

import { config } from './config.mjs';
import * as accents from './accents.mjs';
import * as plex from './media.mjs';
import { extImage } from './images.mjs';
import * as games from './games.mjs';
import { httpError } from './admin.mjs';
import { xboxAction } from './xbox.mjs';
import * as player from './player.mjs';

// Launch links as documented for the Android TV Remote integration
// (https://www.home-assistant.io/integrations/androidtv_remote/). Stremio is not in the docs;
// its stremio:/// scheme is the one already proven by the play-stream script.
const APP_URLS = {
  netflix: 'https://www.netflix.com/title',
  youtube: 'https://www.youtube.com',
  prime: 'https://app.primevideo.com',
  stremio: 'stremio:///',
};
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

// The Denon keeps its last input, so after an Xbox session a film would start on the Xbox
// input. Before anything opens on the player (the Streamer or the Shield), put the Denon back on
// its input when it is on something else. Only when the Denon is already on: from cold, HA's
// start sequence sets the input itself.
// The Denon on its HEOS / NET input reports 'playing' or 'paused', not 'on', so anything but off
// or unreachable counts as on: else a film or app opened after music stayed on the music input.
async function toStreamer(ha) {
  const avr = config.entities.avr;
  const s = ha.states[avr];
  const input = config.entities.playerInput;
  if (!avr || !s || ['off', 'standby', 'unavailable', 'unknown'].includes(s.state) || !s.attributes?.source || s.attributes.source === input) return;
  await ha.callService('media_player', 'select_source', { source: input }, { target: { entity_id: avr } })
    .catch((err) => console.warn('[input] could not switch the Denon to the player:', err.message));
}

export const script = (ha, name, variables = {}) => ha.callService('script', 'turn_on', { variables }, { target: { entity_id: `script.theater_${name}` } });

// A light in the settings may be a group (light.media: four Hue downlights). Its members are
// what effects and Album colours act on, as the group itself has neither.
export function lightMembers(ha, id) {
  const m = ha.states[id]?.attributes?.entity_id;
  return Array.isArray(m) ? m.filter((x) => /^light\./.test(x)) : [];
}
const lightAllowed = (ha, id) => config.entities.lights.includes(id) || config.entities.lights.some((g) => lightMembers(ha, g).includes(id));

// One light command at a time per light. A slider sends as the finger moves, and a Hue bridge
// takes only a few commands a second: without this they queued in HA until requests timed out.
// While one is in flight only the newest waits; the ones it replaces answer { superseded }.
const lightQueue = new Map();
export function lightCall(ha, id, data, service = 'turn_on') {
  const key = Array.isArray(id) ? id.join(',') : id;
  let q = lightQueue.get(key);
  if (!q) lightQueue.set(key, (q = { busy: false, next: null }));
  return new Promise((resolve, reject) => {
    if (q.next) q.next.resolve({ superseded: true });
    q.next = { service, data, resolve, reject };
    pumpLights(ha, id, q);
  });
}
async function pumpLights(ha, id, q) {
  if (q.busy || !q.next) return;
  const job = q.next;
  q.next = null;
  q.busy = true;
  try { job.resolve(await ha.callService('light', job.service, job.data, { target: { entity_id: id } })); }
  catch (err) { job.reject(err); }
  finally { q.busy = false; pumpLights(ha, id, q); }
}

// Music playing through Music Assistant (the Denon over HEOS, or the Streamer) pauses before a
// film, a show, a Streamer app or the Xbox starts, so the two never play over each other.
const STARTS = (body) => body.action === 'play' || body.action === 'app' || (body.action === 'xbox' && ['start', 'launch'].includes(body.cmd));
async function pauseMusic(ha) {
  const playing = config.entities.musicPlayers.filter((id) => ha.states[id]?.state === 'playing');
  if (!playing.length) return;
  await ha.callService('media_player', 'media_pause', {}, { target: { entity_id: playing } })
    .catch((err) => console.warn('[music] could not pause before the film:', err.message));
}

export async function runAction(ha, body) {
  const e = config.entities;
  if (STARTS(body)) await pauseMusic(ha);
  switch (body.action) {
    case 'scene': {
      if (!SCENES.includes(body.name)) throw new Error('Unknown scene');
      // Pre-show starts the cinema on the chosen player and plays its music there (HA's
      // theater_pre_show takes `player`: shield or streamer).
      const run = await script(ha, body.name, body.name === 'pre_show' ? { player: e.player } : {});
      // HA's All off ends the movie and Xbox scenes; the Shield's scene ends here too.
      if (body.name === 'all_off' && e.shield && ha.states[e.shield.room]?.state === 'on') {
        await ha.callService('input_boolean', 'turn_off', {}, { target: { entity_id: e.shield.room } }).catch(() => {});
      }
      // The bar follows the room: a film gets Smart mode and no Night mode, unless told otherwise.
      if (body.name === 'movie_time' && e.soundbar && config.soundbarMovieSmart) {
        soundbar(ha, { cmd: 'smart', on: true }).catch(() => {});
        soundbar(ha, { cmd: 'night', on: false }).catch(() => {});
      }
      // The break gets its jingle: the panel shows the snack bar, the room hears the march.
      if (body.name === 'intermission' && config.intermission.url && body.quiet !== true) {
        const speaker = e.soundSpeaker;
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
        const speaker = e.soundSpeaker;
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
      if (!lightAllowed(ha, body.entity_id)) throw new Error('Unknown light');
      const effect = String(body.effect || '').slice(0, 64);
      if (!effect) throw new Error('No effect');
      // A group without effects of its own: its bulbs' effects, on all of them.
      const own = ha.states[body.entity_id]?.attributes?.effect_list;
      const members = lightMembers(ha, body.entity_id);
      const target = !(own && own.length > 1) && members.length ? members : body.entity_id;
      return lightCall(ha, target, { effect });
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
      const speaker = e.soundSpeaker;
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

    // The phone remote's TV pad: Google TV Streamer keys through HA's Android TV Remote.
    case 'tv_key': {
      const keys = { up: 'DPAD_UP', down: 'DPAD_DOWN', left: 'DPAD_LEFT', right: 'DPAD_RIGHT', ok: 'DPAD_CENTER', back: 'BACK', home: 'HOME' };
      const command = keys[body.key];
      if (!command) throw httpError(400, 'Unknown key');
      return ha.callService('remote', 'send_command', { command }, { target: { entity_id: e.appleTvRemote } });
    }

    case 'light': {
      if (!lightAllowed(ha, body.entity_id)) throw new Error('Unknown light');
      if (body.on === false) return lightCall(ha, body.entity_id, {}, 'turn_off');
      const data = {};
      if (body.brightness_pct != null) data.brightness_pct = clamp(body.brightness_pct, 1, 100);
      if (body.rgb_color) data.rgb_color = body.rgb_color.slice(0, 3).map((n) => clamp(n, 0, 255));
      if (body.color_temp_kelvin) data.color_temp_kelvin = clamp(body.color_temp_kelvin, 2000, 6500);
      return lightCall(ha, body.entity_id, data);
    }

    case 'aisle_glow': return script(ha, 'aisle_glow');

    // An app on the Streamer. The cinema off: start it, answer at once (the panel shows the warm-up
    // screen), and open the app once the Streamer and the Denon are up.
    case 'app': {
      const url = APP_URLS[body.id];
      if (!url) throw httpError(400, 'Unknown app');
      const open = async () => {
        await toStreamer(ha);
        // A link sent while the Google Photos screensaver is up may be swallowed: wake it first.
        if (SCREENSAVER.test(ha.states[e.appleTv]?.attributes?.app_id || '')) {
          await ha.callService('remote', 'send_command', { command: 'DPAD_CENTER' }, { target: { entity_id: e.appleTvRemote } });
          await new Promise((r) => setTimeout(r, 1500));
        }
        return ha.callService('media_player', 'play_media', { media: { media_content_type: 'url', media_content_id: url } }, { target: { entity_id: e.appleTv } });
      };
      // The projector now comes on last in the theatre sequence (it locks onto a settled HDMI
      // signal that way), so the app waits for it too, else a film could start on a blank screen.
      const projUp = () => !e.projectorPower || ha.states[e.projectorPower]?.state === 'on';
      // And for the start script to finish: it restarts the projector at the end, and an app
      // opened before that (Netflix) decides there's no Atmos.
      const ready = () => ha.states[e.appleTv]?.state === 'on' && !['unavailable', 'unknown', 'off', undefined].includes(ha.states[e.avr]?.state) && projUp() && !player.startRunning();
      // Pre-show music fades out (HA's script.theater_music_fade, ~2.5 s) before the app
      // opens, rather than being cut off by it. A missing script only costs the fade.
      const fadeMusic = () => ha.callService('script', 'theater_music_fade', {}).catch((err) => console.warn('[app] no music fade:', err.message));
      // Always bring the movie scene on (lights, blind), even when the kit is already up.
      const sceneOff = !player.roomOn();
      if (ready()) {
        await fadeMusic();
        await open();
        if (sceneOff) await ha.callService('input_boolean', 'turn_on', {}, { target: { entity_id: e.roomOn } });
        return { ok: true };
      }
      if (sceneOff) {
        await ha.callService('input_boolean', 'turn_on', {}, { target: { entity_id: e.roomOn } });
        // No warm-up music: the cinema is up in under a minute now. (Pre-show still has its music.)
      }
      (async () => {
        const until = Date.now() + 270e3;
        while (!ready() && Date.now() < until) await new Promise((r) => setTimeout(r, 2000));
        if (!ready()) { await fadeMusic(); return console.warn(`[app] ${body.id}: the cinema did not come up in time`); }
        await new Promise((r) => setTimeout(r, 5000));   // a Streamer that has just woken ignores links for a moment
        await fadeMusic();
        await open().catch((err) => console.warn(`[app] ${body.id}:`, err.message));
      })();
      return { ok: true, warming: true };
    }

    // This fork's Cinema card: start the room (your movie scene), Denon volume and input.
    case 'cinema': {
      if (body.cmd === 'on') return ha.callService('input_boolean', 'turn_on', {}, { target: { entity_id: e.roomOn } });
      // One device on or off from the Cinema card's device buttons.
      if (body.cmd === 'device') {
        const id = { power: e.plug, denon: e.avr, projector: e.projectorPower, chromecast: e.appleTv }[body.dev];
        if (!id) throw httpError(400, 'Unknown device');
        return ha.callService('homeassistant', body.on ? 'turn_on' : 'turn_off', {}, { target: { entity_id: id } });
      }
      if (body.cmd === 'volume') {
        // Capped at 75%: a slip of the finger on a wall tablet should not blow the speakers.
        const level = Math.min(0.75, clamp(Number(body.value), 0, 100) / 100);
        return ha.callService('media_player', 'volume_set', { volume_level: Math.round(level * 100) / 100 }, { target: { entity_id: e.avr } });
      }
      if (body.cmd === 'source') {
        // The Streamer's or the Shield's input is the same as choosing that player (the room moves over).
        const box = ['streamer', 'shield'].find((b) => e[b] && e[b].input === body.source);
        if (box) return player.set(box);
        if (body.source !== 'Xbox One') throw httpError(400, 'Unknown source');
        return ha.callService('media_player', 'select_source', { source: body.source }, { target: { entity_id: e.avr } });
      }
      // The cinema's blind: open, closed, or a position (0 closed .. 100 open).
      if (body.cmd === 'blind' && e.blind) {
        const target = { entity_id: e.blind };
        if (body.to === 'open') return ha.callService('cover', 'open_cover', {}, { target });
        if (body.to === 'close') return ha.callService('cover', 'close_cover', {}, { target });
        return ha.callService('cover', 'set_cover_position', { position: Math.round(clamp(Number(body.position), 0, 100)) }, { target });
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
          // A genre (from For you) goes by its uri alone: Music Assistant works out what it is.
          media_id: String(body.uri), ...(body.media_type && body.media_type !== 'genre' ? { media_type: body.media_type } : {}), enqueue: body.enqueue || 'replace',
        }, { target });
      }
      if (body.cmd === 'transfer') {
        const to = e.musicPlayers.includes(body.to) ? body.to : null;
        if (!to) throw new Error('Unknown player');
        return ha.callService('music_assistant', 'transfer_queue', { source_player: player, auto_play: true }, { target: { entity_id: to } });
      }
      throw new Error('Unknown music command');
    }

    // The cinema's player: the Streamer or the Shield (server/player.mjs).
    case 'player': return player.set(String(body.to || ''));

    case 'game_source': return games.selectSource(ha, String(body.id));
    case 'xbox': return xboxAction(ha, body);
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
  // Once HA's script.theater_play_stremio, which only knew the Streamer: now the panel does the
  // same on whichever box is the player. Start the cinema if it's off, wait for it (and for the
  // start script to finish), fade any pre-show music, open the title's stream list, and with
  // auto-play on press OK for the first stream (again 12 s later if nothing plays).
  const e = config.entities;
  const wasOff = !player.roomOn();
  if (wasOff) await ha.callService('input_boolean', 'turn_on', {}, { target: { entity_id: e.roomOn } });
  else if (ha.states[e.appleTv]?.state === 'off') await ha.callService('media_player', 'turn_on', {}, { target: { entity_id: e.appleTv } }).catch(() => {});
  const isOn = (id) => !id || ha.states[id]?.state === 'on';
  const ready = () => isOn(e.appleTv) && !['unavailable', 'unknown', 'off', undefined].includes(ha.states[e.avr]?.state) && isOn(e.projectorPower) && !player.startRunning();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = async () => {
    for (const end = Date.now() + 270e3; !ready() && Date.now() < end;) await wait(2000);
    if (!ready()) return console.warn('[stremio] the cinema did not come up in time');
    if (wasOff) await wait(5000);   // a box that has just woken ignores links for a moment
    await ha.callService('script', 'theater_music_fade', {}).catch(() => {});
    await toStreamer(ha);
    await wakeStreamer(ha).catch(() => {});
    await ha.callService('media_player', 'play_media', { media: { media_content_type: 'url', media_content_id: link } }, { target: { entity_id: e.appleTv } });
    if (ha.states[e.autoplay]?.state !== 'on') return;
    for (let i = 0; i < 20 && ha.states[e.appleTv]?.attributes?.app_id !== 'com.stremio.one'; i++) await wait(1000);
    if (ha.states[e.appleTv]?.attributes?.app_id !== 'com.stremio.one') return;
    await wait(6000);
    // Already playing (Stremio's own autoplay): leave it. Only "playing" counts here, since a
    // previous film can leave the Shield reporting "paused" while the stream list is up.
    if (castNow(ha)?.state === 'playing') return;
    const ok = () => ha.callService('remote', 'send_command', { command: 'DPAD_CENTER' }, { target: { entity_id: e.appleTvRemote } });
    await ok();
    for (let i = 0; i < 12 && !castNow(ha); i++) await wait(1000);
    if (!castNow(ha)) await ok();
  };
  run().catch((err) => console.warn(`[stremio] ${kind}:`, err.message));
  return { ok: true, warming: !ready() };
}

// Pause and play are key presses on the Streamer's remote (Stremio's player takes them); volume and
// mute go to the Denon, which is the thing making the sound.
// The Streamer as Google Cast sees it, when Stremio is playing or paused on it (else null).
export function castNow(ha) {
  const c = ha.states[config.entities.streamerCast];
  if (!c || !['playing', 'paused', 'buffering'].includes(c.state)) return null;
  return /stremio/i.test(`${c.attributes?.app_name || ''} ${c.attributes?.app_id || ''}`) ? c : null;
}

// The Streamer's screensaver (Google TV's Ambient mode) comes on after a while paused. It ends
// Stremio's Cast session and swallows the next key, so playback buttons did nothing until someone
// pressed OK on the real remote. Press OK for them, then wait for Stremio and Cast to come back.
const SCREENSAVER = /dreamx|screensaver|backdrop|ambient/i;
async function wakeStreamer(ha) {
  const e = config.entities;
  if (!SCREENSAVER.test(ha.states[e.appleTv]?.attributes?.app_id || '')) return;
  await ha.callService('remote', 'send_command', { command: 'DPAD_CENTER' }, { target: { entity_id: e.appleTvRemote } });
  for (let i = 0; i < 20 && !castNow(ha); i++) await new Promise((r) => setTimeout(r, 500));
}

async function streamerTransport(ha, body) {
  const e = config.entities;
  if (['play_pause', 'play', 'pause', 'stop', 'seek_rel'].includes(body.cmd)) await wakeStreamer(ha);
  // Stremio's player ignores the remote's fast-forward and rewind keys, but takes play/pause and
  // seek from Google Cast: use that whenever Cast reports Stremio playing or paused.
  const cast = castNow(ha);
  if (cast) {
    const target = { entity_id: e.streamerCast };
    const svc = { play_pause: 'media_play_pause', play: 'media_play', pause: 'media_pause', stop: 'media_stop' }[body.cmd];
    if (svc) return ha.callService('media_player', svc, {}, { target });
    if (body.cmd === 'seek_rel') {
      const a = cast.attributes || {};
      const pos = livePosition(a, cast.state);
      if (pos != null) {
        const to = Math.max(0, Math.min((a.media_duration || Infinity) - 1, pos + Number(body.seconds || 0)));
        return ha.callService('media_player', 'media_seek', { seek_position: Math.round(to) }, { target });
      }
    }
  }
  const key = { play_pause: 'MEDIA_PLAY_PAUSE', play: 'MEDIA_PLAY', pause: 'MEDIA_PAUSE', stop: 'MEDIA_STOP' }[body.cmd];
  if (key) return ha.callService('remote', 'send_command', { command: key }, { target: { entity_id: e.appleTvRemote } });
  // Next / previous video (YouTube): Google Cast's next and previous track when Cast says the app
  // takes them (NEXT_TRACK 32, PREVIOUS_TRACK 16 in supported_features), else the remote's media keys.
  if (body.cmd === 'next' || body.cmd === 'prev') {
    const next = body.cmd === 'next';
    const c = ha.states[e.streamerCast];
    const feats = Number(c?.attributes?.supported_features) || 0;
    if (c && ['playing', 'paused', 'buffering'].includes(c.state) && (feats & (next ? 32 : 16))) {
      return ha.callService('media_player', next ? 'media_next_track' : 'media_previous_track', {}, { target: { entity_id: e.streamerCast } });
    }
    return ha.callService('remote', 'send_command', { command: next ? 'MEDIA_NEXT' : 'MEDIA_PREVIOUS' }, { target: { entity_id: e.appleTvRemote } });
  }
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

// TIDAL playing on the Shield, as a music player the panel's Music screens understand. The TIDAL
// app isn't a Home Assistant entity, but the Shield's media session (read over ADB by
// index.mjs's shieldTitlePoll) gives the track, artist, album, play state and position. This
// module turns that into a pretend media player, media_player.theater_panel_tidal, kept in the
// panel's copy of HA's states and sent to the screens like any other: Now playing, the Music tab's
// player list and the iPad's music screensaver all pick it up. It is listed only while TIDAL has
// something playing or paused.
//
// The cover and the track's length come from Apple's public iTunes Search API (no key), looked up
// once per track. Play/pause, next and previous go to the Shield as media keys (TIDAL answers
// them); the volume is the Denon's, which is what's making the sound.

import { config } from './config.mjs';

export const ID = 'media_player.theater_panel_tidal';
const NAME = 'Shield (TIDAL)';
let ctx = null;
const looked = new Map();   // "artist|track" -> { art, duration } | false | null (asking)
const norm = (t) => String(t || '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

export function init(context) { ctx = context; }
export const active = () => Boolean(ctx?.ha.states[ID]);

// One iTunes search per track: the cover (600 px) and the length.
function lookup(track, artist, album) {
  const key = `${norm(artist)}|${norm(track)}`;
  if (looked.has(key)) return looked.get(key) || null;
  looked.set(key, null);
  if (looked.size > 400) looked.delete(looked.keys().next().value);
  const url = `https://itunes.apple.com/search?${new URLSearchParams({ term: `${artist} ${track}`, entity: 'song', limit: '10' })}`;
  fetch(url, { signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then((d) => {
    const songs = (d.results || []).filter((s) => norm(s.artistName).includes(norm(artist)) || norm(artist).includes(norm(s.artistName)));
    const pick = songs.find((s) => norm(s.trackName) === norm(track) && (!album || norm(s.collectionName) === norm(album)))
      || songs.find((s) => norm(s.trackName) === norm(track)) || null;
    looked.set(key, pick ? { art: String(pick.artworkUrl100 || '').replace(/100x100bb/, '600x600bb') || null, duration: pick.trackTimeMillis ? pick.trackTimeMillis / 1000 : null } : false);
    refresh();
  }).catch((err) => { looked.delete(key); console.warn('[tidal] cover lookup:', err.message); });
  return null;
}

let last = null;   // the Shield's latest word: { title, artist, album, state, pos, at }
// Called with each media-session read (null when TIDAL has nothing, or the Shield is off).
export function update(m) {
  last = m;
  refresh();
}

function refresh() {
  if (!ctx) return;
  const m = last && ['playing', 'paused'].includes(last.state) && Date.now() - last.at < 60e3 ? last : null;
  const was = ctx.ha.states[ID];
  if (!m) {
    if (was) { delete ctx.ha.states[ID]; ctx.broadcast('states', { [ID]: null }); ctx.broadcast('settings', {}); }
    return;
  }
  const info = lookup(m.title, m.artist, m.album);
  const st = {
    entity_id: ID, state: m.state,
    attributes: {
      friendly_name: NAME, app_name: 'TIDAL', app_id: 'tidal',
      media_content_type: 'music', media_title: m.title, media_artist: m.artist || undefined, media_album_name: m.album || undefined,
      media_position: m.pos, media_position_updated_at: new Date(m.at).toISOString(),
      ...(info?.duration ? { media_duration: info.duration } : {}),
      ...(info?.art ? { entity_picture: info.art } : {}),
      volume_level: ctx.ha.states[config.entities.avr]?.attributes?.volume_level,
    },
  };
  // Only send it on when something a screen shows has changed (the position moves every read).
  const sig = (s) => s && JSON.stringify([s.state, s.attributes.media_title, s.attributes.media_artist, s.attributes.entity_picture, s.attributes.media_duration, Math.round((s.attributes.media_position || 0) / 15)]);
  ctx.ha.states[ID] = st;
  if (sig(was) !== sig(st)) ctx.broadcast('states', { [ID]: st });
  if (!was) ctx.broadcast('settings', {});   // the player lists now include it
}

// The Music screens' buttons for this player.
export function command(body) {
  const adb = config.entities.shield?.cast;
  const target = { entity_id: adb };
  const keys = { play_pause: 'media_play_pause', next: 'media_next_track', previous: 'media_previous_track' };
  if (keys[body.cmd]) return ctx.ha.callService('media_player', keys[body.cmd], {}, { target });
  if (body.cmd === 'volume') return ctx.ha.callService('media_player', 'volume_set', { volume_level: Math.max(0, Math.min(1, Number(body.level) || 0)) }, { target: { entity_id: config.entities.avr } });
  const err = new Error('TIDAL plays from the TIDAL app on the Shield: pick music there');
  err.status = 400;
  throw err;
}

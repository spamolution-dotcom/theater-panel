// What the Google TV Streamer is showing, for the labels on the wall panel and the phone: the app
// in front (from the Android TV Remote entity, which only knows package names) and, when the app
// reports to Google Cast (YouTube, Spotify, Netflix, Stremio, Music Assistant), its title, artist,
// play state and position from the Cast entity.
const APPS = [
  [/^com\.netflix\./, 'netflix', 'Netflix'],
  [/^com\.stremio\./, 'stremio', 'Stremio'],
  [/^com\.google\.android\.youtube/, 'youtube', 'YouTube'],
  [/^com\.teamsmart\.videomanager/, 'youtube', 'YouTube'],          // SmartTube
  [/^org\.smarttube/, 'youtube', 'YouTube'],
  // External players Stremio hands streams to: shown as Stremio.
  [/^(com\.brouken\.player|com\.mxtech\.videoplayer|org\.videolan\.vlc|org\.courville\.nova|is\.xyz\.mpv)/, 'stremio', 'Stremio'],                        // SmartTube (current package)
  [/^com\.amazon\.amazonvideo/, 'prime', 'Prime Video'],
  [/^com\.spotify\./, null, 'Spotify'],
  [/^com\.disney\./, null, 'Disney+'],
  [/^com\.plexapp\./, null, 'Plex'],
  [/launcher/, null, 'Home screen'],
  [/mediashell/, null, 'Casting'],
];
const CAST_KEYS = { Netflix: 'netflix', YouTube: 'youtube', Stremio: 'stremio', 'Prime Video': 'prime' };

const isUp = (st) => Boolean(st) && !['off', 'unavailable', 'unknown', 'standby'].includes(st.state);

export function streamerNow(tv, cast) {
  if (!isUp(tv)) return { on: false, name: 'Off', key: null };
  const pkg = tv.attributes?.app_id || '';
  const hit = APPS.find(([re]) => re.test(pkg));
  const c = cast && ['playing', 'paused', 'buffering', 'idle'].includes(cast.state) ? cast : null;
  const ca = c?.attributes || {};
  // The Cast app's own name when the package is unknown or a stand-in (Casting).
  const name = hit && !/mediashell/.test(pkg) ? hit[2] : ca.app_name || (hit ? hit[2] : 'An app');
  const key = (hit && hit[1]) || CAST_KEYS[ca.app_name] || null;
  // Cast details only when they are about the same app (a stale Cast session can outlive it).
  // (On the Shield this is the ADB entity, which names the app by its package, like the TV entity.)
  const same = c && (!hit || hit[2] === ca.app_name || ca.app_name === pkg || /mediashell|launcher/.test(pkg) || ca.app_name === 'Music Assistant');
  return {
    on: true,
    name,
    key,
    home: name === 'Home screen' && !same,
    title: same ? ca.media_title || '' : '',
    artist: same ? ca.media_artist || ca.media_series_title || '' : '',
    state: same ? c.state : null,
    cast: same ? c : null,
  };
}

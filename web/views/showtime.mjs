// Showtime: the dark screen while a movie plays. Near-black, dim amber, only the controls you
// need in the dark. In Kiosk Satellite, theater mode does the dimming natively (backlight at
// minimum, black wash, first touch swallowed to peek); elsewhere the page dims its own
// controls and a tap brightens them for a few seconds.

import { useEffect, useState } from 'preact/hooks';
import { hallway } from '../lib/role.mjs';
import { html, Icon, Pause, Play } from '../lib/ui.mjs';
import { act, get, useLoad, useStore, useEntity, livePosition, mmss, clock, getState, playbackState, castVideo } from '../lib/api.mjs';
import { enterTheater, exitTheater, wake } from '../lib/ks.mjs';
import { go, route } from '../app.mjs';
import { SleepPicker, sleepLabel } from './sleep.mjs';
import { soundFormat } from '../lib/sound.mjs';

export function Showtime() {
  const ents = useStore((s) => s.entities);
  const tv = useEntity(ents.appleTv);
  // Sessions are only this theater's player when PLEX_PLAYER_NAME is set; otherwise the first
  // one could be anybody's stream, so fall back to the Apple TV's own attributes.
  const session = useStore((s) => (s.ui?.theaterSessions ? s.sessions?.[0] : undefined));
  const [, tick] = useState(0);
  const [awake, setAwake] = useState(true);
  // Tap feedback: 'tap' the moment a button is pressed, then 'ok' (a ✓) or 'err' (red) once the
  // server answers; cleared a second later.
  const [fx, setFx] = useState({});
  const mark = (key, v) => setFx((f) => ({ ...f, [key]: v }));
  const press = (key, data) => {
    mark(key, 'tap');
    return act(data).then((r) => { mark(key, r === null ? 'err' : 'ok'); setTimeout(() => mark(key, null), r === null ? 2500 : 1100); });
  };
  const fxc = (key, on) => `dbtn${on ? ' on' : ''}${fx[key] ? ` fx-${fx[key]}` : ''}`;
  // The room as it is, not as last tapped: the Denon's volume and mute, the downlights, the scene.
  const avr = useEntity(ents.avr);
  const vol = avr?.attributes?.volume_level;
  const muted = Boolean(avr?.attributes?.is_volume_muted);
  const volText = vol == null ? '–' : String(Math.round(vol * 200) / 2);
  // What the Denon is decoding: Atmos coming through, or PCM (the Chromecast missed the handshake).
  const fmt = soundFormat(avr?.attributes?.sound_mode_raw);
  const media = useEntity(ents.lights?.[0]);
  const mediaPct = media?.state === 'on' ? Math.round(((media.attributes?.brightness || 0) / 255) * 100) : 0;
  const glowOn = media?.state === 'on' && mediaPct <= 35;
  const scene = useStore((s) => s.states['input_select.theater_scene']?.state);
  const [sleepOpen, setSleepOpen] = useState(route.params.sleep === '1');
  const sleep = useStore((s) => s.sleep);
  // The soundbar, once there is one: its level under the volume buttons, and Late night.
  const sb = useStore((s) => s.entities.soundbar);
  const sbVolume = useEntity(sb?.volume);
  const sbNight = useEntity(sb?.night);
  const sbPure = useEntity(sb?.pureVoice);
  const lateNight = sbNight?.state === 'on' && sbPure?.state === 'on';

  const native = useStore((s) => Boolean(s.theater));
  // Showtime owns theater mode: on while this screen is up, off when it goes (Full controls,
  // playback ended). Reloads keep it on, and the app re-sends the phase after the reload.
  // In the hallway the screen stays lit with its controls showing: it is a Now Playing board, not
  // the dark in-room remote.
  useEffect(() => { if (hallway) return undefined; enterTheater(); return () => { exitTheater(); }; }, []);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (hallway || native || !awake) return; const t = setTimeout(() => setAwake(false), 8000); return () => clearTimeout(t); }, [awake]);

  // Without a session (YouTube, Netflix…), what Google Cast reports on the Streamer: title, length,
  // position and the app's own thumbnail.
  const cast = useEntity(ents.streamerCast);
  const viaCast = !session && castVideo(cast);
  const src = viaCast ? cast : tv;
  const a = src?.attributes || {};
  const state = useStore((s) => playbackState(s));
  const sessionsAt = useStore((s) => s.sessionsAt) || Date.now();
  const playing = state === 'playing';
  const autoplayOn = useStore((s) => s.states[s.entities?.autoplay]?.state === 'on');
  const title = session?.showTitle || session?.title || a.media_series_title || a.media_title || (viaCast && a.app_name) || 'Now showing';
  const sub = session?.showTitle ? `S${session.season} · E${session.episode} ${session.title}` : (a.media_series_title ? a.media_title : '');
  // Position: the Plex session when there is one (it is the film, wherever it plays), carried
  // forward between polls while playing; the Apple TV's own report otherwise.
  const dur = session?.duration ? session.duration / 1000 : a.media_duration || null;
  let pos = null;
  if (session?.viewOffset != null) pos = session.viewOffset / 1000 + (playing ? (Date.now() - sessionsAt) / 1000 : 0);
  else pos = livePosition(src);
  const left = dur && pos != null ? dur - pos : null;
  const ends = left != null ? clock(new Date(Date.now() + left * 1000)).hm : '--:--';
  // The hallway board's caption: year and genre in the label, the synopsis under the title (the
  // episode's own for a show). From the same details the Watch screen shows, loaded once per title.
  const infoId = hallway && /^tt\d+/.test(session?.id || '') ? session.id : null;
  const [info] = useLoad(() => (infoId ? get(`/api/plex/item/${infoId}`).catch(() => null) : Promise.resolve(null)), [infoId]);
  const facts = info ? [info.year, info.genres?.[0]].filter(Boolean).join(' · ') : '';
  // The hallway board's "Starring" row: the cast with characters and photos (TMDB), a series' main
  // cast for an episode. Not with a soundbar (that layout keeps its own volume column).
  const board = hallway && !sb;
  const credId = board && infoId ? infoId.split(':')[0] : null;
  const [credits] = useLoad(() => (credId ? get(`/api/credits/${credId}?kind=${infoId.includes(':') ? 'show' : 'movie'}`).then((r) => r?.cast || []).catch(() => []) : Promise.resolve([])), [credId]);
  const starring = (credits || []).slice(0, 5);
  const bg = session?.art ? `background-image:url('${session.art}')` : '';

  // With native theater mode the app swallows the first touch and peeks by itself.
  const poke = () => { if (native) return; setAwake(true); wake(); };
  const t = (cmd, extra) => press(cmd === 'seek_rel' ? `seek${extra?.seconds}` : cmd, { action: 'transport', cmd, ...extra });
  // All off turns the whole cinema off (your End Movie Scene), so it takes a second tap within 4 s.
  const [offArmed, setOffArmed] = useState(false);
  useEffect(() => { if (!offArmed) return undefined; const x = setTimeout(() => setOffArmed(false), 4000); return () => clearTimeout(x); }, [offArmed]);
  const allOff = () => { if (!offArmed) { setOffArmed(true); return; } setOffArmed(false); press('alloff', { action: 'scene', name: 'all_off' }).then(() => go('lobby')); };

  // The hallway board: the poster full height down the left, the controls beside it over the
  // film's artwork, brighter than the in-room remote.
  const castPic = viaCast && a.entity_picture ? `/api/ha-image?e=${encodeURIComponent(ents.streamerCast)}&v=${encodeURIComponent(a.entity_picture)}` : null;
  const castApp = viaCast && /youtube|netflix|prime|stremio/i.test(a.app_name || '') ? String(a.app_name).toLowerCase().match(/youtube|netflix|prime|stremio/)[0] : null;
  const bigPoster = session?.posterLarge || session?.poster || castPic;

  // The controls, laid out two ways below: the hallway board (volume inside the centre card, the
  // scenes down the left, the cast along the bottom) and the classic one (volume down the left,
  // the scenes along the bottom).
  const volUpBtn = html`<button type="button" class=${fxc('vol_up')} style=${board ? '' : 'flex-grow:1'} aria-label="Volume up" disabled=${sb && Number(sbVolume?.state) >= 100} onClick=${() => t('vol_up')}><${Icon} name="volp" size=${48} w=${1.8} /></button>`;
  const volDownBtn = html`<button type="button" class=${fxc('vol_down')} style=${board ? '' : 'flex-grow:1'} aria-label="Volume down" disabled=${sb && sbVolume && Number(sbVolume.state) <= 0} onClick=${() => t('vol_down')}><${Icon} name="volm" size=${48} w=${1.8} /></button>`;
  const volBox = html`<div class="st-vol" title="Denon volume"><div class="vl"><span class="k">Volume</span><span class="mono v">${muted ? 'Muted' : volText}</span></div>
    <div class=${`vb${muted ? ' m' : ''}`}><i style=${`width:${vol != null ? Math.min(100, vol * 100) : 0}%`}></i></div></div>`;
  const muteBtn = html`<button type="button" class=${`${fxc('mute', muted)} st-mute`} style=${board ? '' : 'height:110px'} aria-label="Mute" aria-pressed=${muted ? 'true' : 'false'} onClick=${() => t('mute', { muted: !muted })}><${Icon} name="mute" size=${40} w=${1.8} /><span class="s">${muted ? 'Muted' : 'Mute'}</span></button>`;
  const transport = html`<div class="transport">
    <button type="button" class=${`skip${fx['seek-10'] ? ` fx-${fx['seek-10']}` : ''}`} aria-label="Back 10 seconds" onClick=${() => t('seek_rel', { seconds: -10 })}><${Icon} name="back" size=${64} w=${1.6} /><span class="mono" style="font-size:20px;color:var(--d-dim)">10s</span></button>
    <button type="button" class=${`pp${fx.play_pause ? ` fx-${fx.play_pause}` : ''}`} aria-label=${playing ? 'Pause' : 'Play'} onClick=${() => t('play_pause')}>
      ${playing ? html`<${Pause} size=${110} color="var(--d-text)" />` : html`<${Play} size=${110} color="var(--d-text)" />`}</button>
    <button type="button" class=${`skip${fx.seek30 ? ` fx-${fx.seek30}` : ''}`} aria-label="Forward 30 seconds" onClick=${() => t('seek_rel', { seconds: 30 })}><${Icon} name="fwd" size=${64} w=${1.6} /><span class="mono" style="font-size:20px;color:var(--d-dim)">30s</span></button>
  </div>`;
  const aisleBtn = html`<button type="button" class=${fxc('aisle', glowOn)} style="flex-grow:1" aria-pressed=${glowOn ? 'true' : 'false'} onClick=${() => press('aisle', { action: 'aisle_glow' })}><${Icon} name="bulb" size=${48} w=${1.8} /><span class="s">Aisle glow</span><span class="sub">${media?.state === 'on' ? `Lights ${mediaPct}%` : 'Off'}</span></button>`;
  const offBtn = html`<button type="button" class=${`${fxc('alloff')}${offArmed ? ' armed' : ''}`} style="flex-grow:1" onClick=${allOff}><${Icon} name="power" size=${48} w=${1.8} /><span class="s">${offArmed ? 'Tap again to turn off' : 'All off'}</span></button>`;
  const interBtn = html`<button type="button" class=${fxc('intermission', scene === 'Intermission')} style=${board ? '' : 'flex-grow:1;height:150px'} onClick=${() => press('intermission', { action: 'scene', name: 'intermission' })}>
    <span class="big"><${Icon} name="cup" size=${40} w=${1.8} />Intermission</span><span class="s">${board ? 'Pause · 30%' : 'Pause · lights 30%'}</span></button>`;
  const lightsBtn = html`<button type="button" class=${fxc('lights_up', scene === 'Lights up')} style=${board ? '' : 'flex-grow:1;height:150px'} onClick=${() => press('lights_up', { action: 'scene', name: 'lights_up' })}>
    <span class="big"><${Icon} name="sun" size=${40} w=${1.8} />Lights up</span><span class="s">Lights 100%</span></button>`;
  const sleepBtn = html`<button type="button" class=${fxc('sleep', Boolean(sleep))} style=${board ? '' : 'width:280px;height:150px'} aria-pressed=${sleep ? 'true' : 'false'} onClick=${() => setSleepOpen(true)}>
    <span class="big"><${Icon} name="moon" size=${40} w=${1.8} />Sleep</span><span class="s">${sleep ? sleepLabel(sleep) : 'Off'}</span></button>`;
  const fullBtn = html`<button type="button" class="dbtn" style=${board ? 'flex-grow:1;background:#000' : 'width:260px;height:150px;background:#000'} onClick=${() => go('lobby', { manual: true })}>
    <${Icon} name="home" size=${36} w=${1.8} color="var(--d-dim)" /><span class="s">Full controls</span></button>`;
  return html`<div class=${`showtime${hallway ? ' hall' : ''}`} style=${hallway ? '' : bg} onPointerDown=${poke}>
    ${hallway && html`<div class="st-poster">${bigPoster ? html`<img src=${bigPoster} alt="" />` : (session?.app || castApp) ? html`<div class="st-poster-app"><img src=${`/assets/apps/${session?.app || castApp}.png`} alt=${title} /></div>` : html`<div class="st-poster-t">${title}</div>`}</div>`}
    ${hallway && html`<div class="st-art" style=${bg}></div>`}
    <div class="wrap" style=${`--glow:${native || awake ? 1 : 0.55}`}>
      <header style="display:flex;justify-content:space-between;align-items:flex-end;gap:24px">
        <div style="display:flex;align-items:flex-end;gap:28px;min-width:0">
          ${!hallway && session?.poster && html`<img src=${session.poster} alt="" style="width:84px;height:126px;object-fit:cover;border-radius:6px;opacity:.45" />`}
          <div style="min-width:0"><div class="lbl">${playing ? 'Now showing' : state === 'paused' ? 'Paused' : state === 'choosing' ? (autoplayOn ? 'Starting the first stream… or pick one with the remote' : 'Pick a stream on the TV with the remote') : 'Standing by'}${hallway && facts ? ` · ${facts}` : ''}${!hallway && playing && fmt ? html`<span class=${`st-fmt ${fmt.kind}`}>${fmt.label}</span>` : null}</div>
            <h1 class="ellipsis">${title}</h1>
            ${sub && html`<div class="lbl ellipsis" style="letter-spacing:1px;margin-top:4px">${sub}</div>`}
            ${hallway && info?.summary && html`<p class="st-syn">${info.summary}</p>`}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
          ${session?.transcoding && html`<span class="warn-dim">Transcoding</span>`}
          <span class="lbl">Ends at</span><span class="ends">${ends}</span>
        </div>
      </header>
      <div style="display:flex;flex-direction:column;gap:10px">
        <div class="track"><i style=${`width:${dur && pos ? Math.min(100, (pos / dur) * 100) : 0}%`}></i></div>
        <div class="times"><span>${mmss(pos)}</span><span>${left != null ? `${mmss(left)} left` : ''}</span></div>
      </div>
      ${board ? html`<div style="flex-grow:1;display:flex;gap:28px;min-height:0">
        <div class="st-side st-scenes">${interBtn}${lightsBtn}${sleepBtn}</div>
        <div class="tp-card">${transport}
          <div class="tp-vol">${volDownBtn}${volBox}${volUpBtn}${muteBtn}</div>
        </div>
        <div class="st-side">${aisleBtn}${offBtn}${fullBtn}</div>
      </div>
      ${starring.length > 0 && html`<div class="st-castrow"><div class="k">Starring</div>
        <div class="row">${starring.map((c) => html`<div class="p" key=${c.name}>
          ${c.photo ? html`<img src=${c.photo} alt="" />` : html`<i>${c.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</i>`}
          <span><b>${c.name}</b>${c.character && html`<s>${c.character}</s>`}</span></div>`)}</div>
      </div>`}` : html`<div style="flex-grow:1;display:flex;gap:28px;min-height:0">
        <div class="st-side" style="width:220px;display:flex;flex-direction:column;gap:20px">
          ${volUpBtn}${!sb && volBox}${muteBtn}${volDownBtn}
          ${sb && html`<div class="sb-level" title="Soundbar volume"><i style=${`width:${sbVolume && !['unknown', 'unavailable'].includes(sbVolume.state) ? Number(sbVolume.state) : 0}%`}></i><span class="mono">${sbVolume && !['unknown', 'unavailable'].includes(sbVolume.state) ? sbVolume.state : '–'}</span></div>
          <button type="button" class="dbtn" style="height:90px" aria-pressed=${lateNight ? 'true' : 'false'} onClick=${() => act({ action: 'soundbar', cmd: 'late_night', on: !lateNight })}><${Icon} name="moon" size=${32} w=${1.8} /><span class="s">Late night</span></button>`}
        </div>
        ${transport}
        <div class="st-side" style="width:220px;display:flex;flex-direction:column;gap:20px">${aisleBtn}${offBtn}</div>
      </div>
      <div class="st-bottom" style="display:flex;gap:28px">${interBtn}${lightsBtn}${sleepBtn}${fullBtn}</div>`}
      ${sleepOpen && html`<${SleepPicker} onClose=${() => setSleepOpen(false)} />`}
    </div>
  </div>`;
}

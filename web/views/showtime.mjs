// Showtime: the dark screen while a movie plays. Near-black, dim amber, only the controls you
// need in the dark. In Kiosk Satellite, theater mode does the dimming natively (backlight at
// minimum, black wash, first touch swallowed to peek); elsewhere the page dims its own
// controls and a tap brightens them for a few seconds.

import { useEffect, useState } from 'preact/hooks';
import { hallway } from '../lib/role.mjs';
import { html, Icon, Pause, Play } from '../lib/ui.mjs';
import { act, useStore, useEntity, livePosition, mmss, clock, getState, playbackState } from '../lib/api.mjs';
import { enterTheater, exitTheater, wake } from '../lib/ks.mjs';
import { go, route } from '../app.mjs';
import { SleepPicker, sleepLabel } from './sleep.mjs';

export function Showtime() {
  const ents = useStore((s) => s.entities);
  const tv = useEntity(ents.appleTv);
  // Sessions are only this theater's player when PLEX_PLAYER_NAME is set; otherwise the first
  // one could be anybody's stream, so fall back to the Apple TV's own attributes.
  const session = useStore((s) => (s.ui?.theaterSessions ? s.sessions?.[0] : undefined));
  const [, tick] = useState(0);
  const [awake, setAwake] = useState(true);
  const [muted, setMuted] = useState(false);
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

  const a = tv?.attributes || {};
  const state = useStore((s) => playbackState(s));
  const sessionsAt = useStore((s) => s.sessionsAt) || Date.now();
  const playing = state === 'playing';
  const title = session?.showTitle || session?.title || a.media_series_title || a.media_title || 'Now showing';
  const sub = session?.showTitle ? `S${session.season} · E${session.episode} ${session.title}` : (a.media_series_title ? a.media_title : '');
  // Position: the Plex session when there is one (it is the film, wherever it plays), carried
  // forward between polls while playing; the Apple TV's own report otherwise.
  const dur = session?.duration ? session.duration / 1000 : a.media_duration || null;
  let pos = null;
  if (session?.viewOffset != null) pos = session.viewOffset / 1000 + (playing ? (Date.now() - sessionsAt) / 1000 : 0);
  else pos = livePosition(tv);
  const left = dur && pos != null ? dur - pos : null;
  const ends = left != null ? clock(new Date(Date.now() + left * 1000)).hm : '--:--';
  const bg = session?.art ? `background-image:url('${session.art}')` : '';

  // With native theater mode the app swallows the first touch and peeks by itself.
  const poke = () => { if (native) return; setAwake(true); wake(); };
  const t = (cmd, extra) => act({ action: 'transport', cmd, ...extra });

  return html`<div class="showtime" style=${bg} onPointerDown=${poke}>
    <div class="wrap" style=${`--glow:${native || awake ? 1 : 0.55}`}>
      <header style="display:flex;justify-content:space-between;align-items:flex-end;gap:24px">
        <div style="display:flex;align-items:flex-end;gap:28px;min-width:0">
          ${session?.poster && html`<img src=${session.poster} alt="" style="width:84px;height:126px;object-fit:cover;border-radius:6px;opacity:.45" />`}
          <div style="min-width:0"><div class="lbl">${playing ? 'Now showing' : state === 'paused' ? 'Paused' : 'Standing by'}</div>
            <h1 class="ellipsis">${title}</h1>
            ${sub && html`<div class="lbl ellipsis" style="letter-spacing:1px;margin-top:4px">${sub}</div>`}</div>
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
      <div style="flex-grow:1;display:flex;gap:28px;min-height:0">
        <div style="width:220px;display:flex;flex-direction:column;gap:20px">
          <button type="button" class="dbtn" style="flex-grow:1" aria-label="Volume up" disabled=${sb && Number(sbVolume?.state) >= 100} onClick=${() => t('vol_up')}><${Icon} name="volp" size=${48} w=${1.8} /></button>
          <button type="button" class="dbtn" style="height:110px" aria-label="Mute" aria-pressed=${muted ? 'true' : 'false'} onClick=${() => { setMuted(!muted); t('mute', { muted: !muted }); }}><${Icon} name="mute" size=${40} w=${1.8} /><span class="s">${muted ? 'Unmute' : 'Mute'}</span></button>
          <button type="button" class="dbtn" style="flex-grow:1" aria-label="Volume down" disabled=${sb && sbVolume && Number(sbVolume.state) <= 0} onClick=${() => t('vol_down')}><${Icon} name="volm" size=${48} w=${1.8} /></button>
          ${sb && html`<div class="sb-level" title="Soundbar volume"><i style=${`width:${sbVolume && !['unknown', 'unavailable'].includes(sbVolume.state) ? Number(sbVolume.state) : 0}%`}></i><span class="mono">${sbVolume && !['unknown', 'unavailable'].includes(sbVolume.state) ? sbVolume.state : '–'}</span></div>
          <button type="button" class="dbtn" style="height:90px" aria-pressed=${lateNight ? 'true' : 'false'} onClick=${() => act({ action: 'soundbar', cmd: 'late_night', on: !lateNight })}><${Icon} name="moon" size=${32} w=${1.8} /><span class="s">Late night</span></button>`}
        </div>
        <div class="transport">
          <button type="button" class="skip" aria-label="Back 10 seconds" onClick=${() => t('seek_rel', { seconds: -10 })}><${Icon} name="back" size=${64} w=${1.6} /><span class="mono" style="font-size:20px;color:var(--d-dim)">10s</span></button>
          <button type="button" class="pp" aria-label=${playing ? 'Pause' : 'Play'} onClick=${() => t('play_pause')}>
            ${playing ? html`<${Pause} size=${110} color="var(--d-text)" />` : html`<${Play} size=${110} color="var(--d-text)" />`}</button>
          <button type="button" class="skip" aria-label="Forward 30 seconds" onClick=${() => t('seek_rel', { seconds: 30 })}><${Icon} name="fwd" size=${64} w=${1.6} /><span class="mono" style="font-size:20px;color:var(--d-dim)">30s</span></button>
        </div>
        <div style="width:220px;display:flex;flex-direction:column;gap:20px">
          <button type="button" class="dbtn" style="flex-grow:1" onClick=${() => act({ action: 'aisle_glow' })}><${Icon} name="bulb" size=${48} w=${1.8} /><span class="s">Aisle glow</span></button>
          <button type="button" class="dbtn" style="flex-grow:1" onClick=${() => act({ action: 'transport', cmd: 'stop' })}><${Icon} name="x" size=${48} w=${1.8} /><span class="s">Stop</span></button>
        </div>
      </div>
      <div style="display:flex;gap:28px">
        <button type="button" class="dbtn" style="flex-grow:1;height:150px" onClick=${() => act({ action: 'scene', name: 'intermission' })}>
          <span class="big"><${Icon} name="cup" size=${40} w=${1.8} />Intermission</span><span class="s">Pause · lights 30%</span></button>
        <button type="button" class="dbtn" style="flex-grow:1;height:150px" onClick=${() => act({ action: 'scene', name: 'lights_up' })}>
          <span class="big"><${Icon} name="sun" size=${40} w=${1.8} />Lights up</span><span class="s">End show</span></button>
        <button type="button" class="dbtn" style="width:280px;height:150px" aria-pressed=${sleep ? 'true' : 'false'} onClick=${() => setSleepOpen(true)}>
          <span class="big"><${Icon} name="moon" size=${40} w=${1.8} />Sleep</span><span class="s">${sleep ? sleepLabel(sleep) : 'Off'}</span></button>
        <button type="button" class="dbtn" style="width:260px;height:150px;background:#000" onClick=${() => go('lobby', { manual: true })}>
          <${Icon} name="home" size=${36} w=${1.8} color="var(--d-dim)" /><span class="s">Full controls</span></button>
      </div>
      ${sleepOpen && html`<${SleepPicker} onClose=${() => setSleepOpen(false)} />`}
    </div>
  </div>`;
}

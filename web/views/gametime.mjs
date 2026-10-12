// Game time: the Xbox counterpart of Showtime, in the same dark, dim-amber style. Only what an
// Xbox session needs: what is playing and for how long, achievements, Denon volume, Xbox home,
// Switch game, All off and a way back to the full controls. On the hallway tablet the
// game's poster art fills the left, as the film poster does on Showtime.

import { useEffect, useState } from 'preact/hooks';
import { hallway } from '../lib/role.mjs';
import { html, Icon } from '../lib/ui.mjs';
import { act, useStore, useEntity } from '../lib/api.mjs';
import { go } from '../app.mjs';
import { soundFormat } from '../lib/sound.mjs';

const live = (st) => Boolean(st) && !['unknown', 'unavailable', ''].includes(st.state);
const haImg = (id, st) => (st?.attributes?.entity_picture ? `/api/ha-image?e=${encodeURIComponent(id)}&v=${encodeURIComponent(st.attributes.entity_picture)}&s=${encodeURIComponent(st.state || '')}` : null);
// The integration's artwork images share a prefix: image.<x>_superhero_art, _poster, _box_art.
export const artIds = (art) => {
  const base = String(art || '').replace(/_superhero_art$/, '');
  return base && base !== art ? { poster: `${base}_poster`, box: `${base}_box_art` } : { poster: null, box: null };
};

// Is a game being played? The console on and the account's Now playing sensor naming something.
export function gameOn(states, e) {
  if (!e?.xbox || states[e.xbox]?.state !== 'on') return false;
  return live(states[`sensor.${e.xboxAccount}_now_playing`]);
}

export function Gametime() {
  const e = useStore((s) => s.entities) || {};
  const now = useEntity(e.xboxAccount && `sensor.${e.xboxAccount}_now_playing`);
  const avr = useEntity(e.avr);
  const ids = artIds(e.xboxArt);
  const poster = useEntity(ids.poster);
  const box = useEntity(ids.box);
  const [, tick] = useState(0);
  const [fx, setFx] = useState({});
  const [offArmed, setOffArmed] = useState(false);
  const [posterBad, setPosterBad] = useState(false);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { if (!offArmed) return undefined; const t = setTimeout(() => setOffArmed(false), 4000); return () => clearTimeout(t); }, [offArmed]);

  const mark = (k, v) => setFx((f) => ({ ...f, [k]: v }));
  const press = (k, data) => {
    mark(k, 'tap');
    return act(data).then((r) => { mark(k, r === null ? 'err' : 'ok'); setTimeout(() => mark(k, null), r === null ? 2500 : 1100); });
  };
  const fxc = (k) => `dbtn${fx[k] ? ` fx-${fx[k]}` : ''}`;
  const t = (cmd, extra = {}) => press(cmd, { action: 'transport', cmd, ...extra });

  const a = now?.attributes || {};
  const title = live(now) ? now.state : 'Xbox';
  const genres = Array.isArray(a.genres) ? a.genres.join(', ') : a.genres;
  const since = now?.last_changed ? Math.max(0, (Date.now() - new Date(now.last_changed)) / 1000) : null;
  const played = since == null ? '–' : `${Math.floor(since / 3600)}:${String(Math.floor((since % 3600) / 60)).padStart(2, '0')}`; // h:mm
  const frac = (v) => { const m = String(v || '').match(/(\d+)\s*\/\s*(\d+)/); return m ? [Number(m[1]), Number(m[2])] : null; };
  const ach = frac(a.achievements);
  const score = frac(a.gamerscore);
  const pct = parseFloat(String(a.progress ?? ''));
  const barPct = Number.isFinite(pct) ? pct : ach && ach[1] ? (ach[0] / ach[1]) * 100 : 0;
  const vol = avr?.attributes?.volume_level;
  const muted = Boolean(avr?.attributes?.is_volume_muted);
  const fmt = soundFormat(avr?.attributes?.sound_mode_raw);
  const posterSrc = haImg(ids.poster, poster);
  useEffect(() => setPosterBad(false), [posterSrc]);
  const boxSrc = haImg(ids.box, box);
  const allOff = () => {
    if (!offArmed) { setOffArmed(true); return; }
    setOffArmed(false);
    press('alloff', { action: 'scene', name: 'all_off' }).then(() => go('lobby'));
  };

  return html`<div class=${`showtime gametime${hallway ? ' hall' : ''}`}>
    ${hallway && html`<div class="st-poster">${posterSrc && !posterBad ? html`<img src=${posterSrc} alt="" onError=${() => setPosterBad(true)} />` : html`<div class="st-poster-t">${title}</div>`}</div>`}
    <div class="wrap" style="--glow:1">
      <header style="display:flex;justify-content:space-between;align-items:flex-end;gap:24px">
        <div style="display:flex;align-items:flex-end;gap:28px;min-width:0">
          ${!hallway && boxSrc && html`<img src=${boxSrc} alt="" style="width:110px;height:110px;object-fit:cover;border-radius:10px;opacity:.5" onError=${(ev) => { ev.currentTarget.style.display = 'none'; }} />`}
          <div style="min-width:0"><div class="lbl">Now playing on Xbox${hallway && genres ? ` · ${genres}` : ''}${!hallway && fmt ? html`<span class=${`st-fmt ${fmt.kind}`}>${fmt.label}</span>` : null}</div>
            <h1 class="ellipsis">${title}</h1>
            ${!hallway && genres && html`<div class="lbl ellipsis" style="letter-spacing:1px;margin-top:4px">${genres}</div>`}
            ${hallway && a.short_description && html`<p class="st-syn">${a.short_description}</p>`}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0">
          <span class="lbl">Playing for</span><span class="ends">${played}</span>
        </div>
      </header>
      ${(ach || score) && html`<div style="display:flex;flex-direction:column;gap:10px">
        <div class="track"><i style=${`width:${Math.min(100, barPct)}%`}></i></div>
        <div class="times"><span>${ach ? `Achievements ${ach[0]} / ${ach[1]}` : ''}</span><span>${score ? `Gamerscore ${score[0]} / ${score[1]}` : ''}</span></div>
      </div>`}
      <div style="flex-grow:1;display:flex;gap:28px;min-height:0">
        <div class="st-side" style="width:220px;display:flex;flex-direction:column;gap:20px">
          <button type="button" class=${fxc('vol_up')} style="flex-grow:1" aria-label="Volume up" onClick=${() => t('vol_up')}><${Icon} name="volp" size=${48} w=${1.8} /></button>
          <div class="st-vol" title="Denon volume"><div class="vl"><span class="k">Volume</span><span class="mono v">${muted ? 'Muted' : vol == null ? '–' : String(Math.round(vol * 200) / 2)}</span></div>
            <div class=${`vb${muted ? ' m' : ''}`}><i style=${`width:${vol != null ? Math.min(100, vol * 100) : 0}%`}></i></div></div>
          <button type="button" class=${`${fxc('mute')} st-mute`} style="height:110px" aria-label="Mute" aria-pressed=${muted ? 'true' : 'false'} onClick=${() => t('mute', { muted: !muted })}><${Icon} name="mute" size=${40} w=${1.8} /><span class="s">${muted ? 'Muted' : 'Mute'}</span></button>
          <button type="button" class=${fxc('vol_down')} style="flex-grow:1" aria-label="Volume down" onClick=${() => t('vol_down')}><${Icon} name="volm" size=${48} w=${1.8} /></button>
        </div>
        <div class="transport">
          <button type="button" class=${`skip${fx.switch ? ` fx-${fx.switch}` : ''}`} onClick=${() => go('games', { manual: true })}><${Icon} name="pad" size=${64} w=${1.6} /><span class="mono" style="font-size:20px;color:var(--d-dim)">Switch game</span></button>
          <div class="gt-home">
            <button type="button" class=${`pp${fx.home ? ` fx-${fx.home}` : ''}`} aria-label="Xbox home" onClick=${() => press('home', { action: 'xbox', cmd: 'home' })}><${Icon} name="pad" size=${110} w=${1.4} /></button>
            <span class="mono" style="font-size:20px;color:var(--d-dim)">Xbox home</span>
          </div>
        </div>
        <div class="st-side" style="width:220px;display:flex;flex-direction:column;gap:20px">
          <button type="button" class=${`${fxc('alloff')}${offArmed ? ' armed' : ''}`} style="flex-grow:1" onClick=${allOff}><${Icon} name="power" size=${48} w=${1.8} /><span class="s">${offArmed ? 'Tap again to turn off' : 'All off'}</span></button>
          <button type="button" class="dbtn" style="flex-grow:1;background:#000" onClick=${() => go('games', { manual: true })}><${Icon} name="home" size=${40} w=${1.8} color="var(--d-dim)" /><span class="s">Full controls</span></button>
        </div>
      </div>
    </div>
  </div>`;
}

// Games: switch the projector to a console (through the HDMI switcher) or the gaming PC, browse
// and launch the Steam library, and watch the PC's temperatures and load.

import { useState, useRef } from 'preact/hooks';
import { html, Icon, Poster, Header, H2 } from '../lib/ui.mjs';
import { get, act, useLoad, useEntity, useStore, toast } from '../lib/api.mjs';
import { go } from '../app.mjs';
import { Xbox } from './xbox.mjs';

// With an Xbox in Home Assistant the Games screen is the Xbox; otherwise the HDMI switcher / Steam one.
export function Games() {
  const xbox = useStore((s) => Boolean(s.entities?.xbox && s.states[s.entities.xbox]));
  return xbox ? html`<${Xbox} />` : html`<${Switcher} />`;
}

function Switcher() {
  const swipe = useRef(null);
  const [g, err, reload] = useLoad(() => get('/api/games'), []);
  const [steam] = useLoad(() => get('/api/steam/library').catch(() => ({ configured: false, games: [] })), []);
  const [active, setActive] = useState(null);
  // Live from HA: the switcher select's state names the console on screen.
  const switcher = useEntity(g?.switcher?.entity);
  const switcherState = switcher?.state;
  const switchOptions = switcher?.attributes?.options || [];

  if (err) return html`<main class="view"><${Header} title="Games" kicker="Consoles and PC" /><div class="empty" style="flex-grow:1">${err.message}</div></main>`;
  if (g && !g.configured) return html`<main class="view"><${Header} title="Games" kicker="Consoles and PC" /><${Setup} /></main>`;

  const sources = (g?.sources || []).filter((s) => s.games !== false);
  const fromSwitcher = g?.sources?.find((s) => s.via === 'switcher' && (s.input ? switchOptions[s.input - 1] : s.option) === switcherState)?.id;
  const current = active || fromSwitcher || g?.active;
  async function pick(src) {
    setActive(src.id);
    const r = await act({ action: 'game_source', id: src.id });
    if (r) toast(`Switched to ${src.name}`);
    setActive(null); // from now on the HA state decides what is highlighted
    reload();
  }
  async function launch(game) {
    const pcSource = sources.find((s) => s.id === 'steam' || s.via === 'projector');
    if (pcSource && current !== pcSource.id) await pick(pcSource);
    if (await act({ action: 'game_launch', appid: game.appid })) toast(`Launching ${game.name}`);
  }

  // Swipe left for the PC stats page (the Games screen has nothing else to swipe to).
  const down = (e) => { swipe.current = { x: e.clientX, y: e.clientY }; };
  const up = (e) => {
    const st = swipe.current; swipe.current = null;
    if (st && e.clientX - st.x < -70 && Math.abs(e.clientY - st.y) < 70 && g?.pc) go('stats');
  };

  return html`<main class="view" style="touch-action:pan-y" onPointerDown=${down} onPointerUp=${up}>
    <${Header} title="Games" kicker="HDMI switcher · Gaming PC">
      ${g?.pc && html`<button type="button" class="chip" onClick=${() => go('stats')}><${Icon} name="chart" size=${20} />PC stats<${Icon} name="chev" size=${18} /></button>`}
    <//>
    <div class="game-sources" style=${`grid-template-columns:repeat(${Math.max(sources.length || 5, 1)}, minmax(0, 1fr))`}>
      ${sources.map((s) => html`<button type="button" class="game-src" aria-pressed=${current === s.id ? 'true' : 'false'} onClick=${() => pick(s)}>
        <${Icon} name=${s.icon?.includes(':') ? s.icon : ICONS[s.icon] || 'pad'} size=${44} color=${current === s.id ? 'var(--gold)' : 'var(--acc)'} w=${1.8} />
        <span class="n">${s.name}</span><span class="d">${s.via === 'switcher' ? 'HDMI switcher' : 'Gaming PC'}</span>
      </button>`)}
    </div>
    <div class="games-body">
      <section class="card steam scroll">
        <${H2} title="Steam library"><span class="aside">${steam?.games?.length ? `${steam.games.length} games · recently played first` : ''}</span><//>
        ${!steam ? html`<div class="empty">Loading…</div>`
          : !steam.configured ? html`<div class="empty" style="flex-direction:column;gap:8px">Add STEAM_API_KEY and STEAM_ID to the panel's settings to show your library here.</div>`
          : html`<div class="steam-grid">${steam.games.slice(0, 60).map((s) => html`<button type="button" class="poster-btn" key=${s.appid} onClick=${() => launch(s)} aria-label=${`Launch ${s.name}`}>
              <${Poster} src=${s.poster} title=${s.name} />
              <span class="t ellipsis">${s.name}</span><span class="y">${s.hours ? `${s.hours} h played` : 'Not played'}</span></button>`)}</div>`}
      </section>
      ${g?.pc && html`<${PcPanel} pc=${g.pc} />`}
    </div>
  </main>`;
}

const ICONS = { tv: 'tv', pad: 'pad', joystick: 'joystick', remote: 'remote', monitor: 'screen', server: 'server', steam: 'playc' };

function PcPanel({ pc }) {
  const power = useEntity(pc.power);
  const on = power && power.state === 'on';
  return html`<aside class="pc dark tx-suede">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
      <div><div class="eyebrow">${pc.power ? (on ? 'Running' : power ? power.state : 'Unknown') : 'Stats'}</div>
        <div style="font-family:var(--disp);font-weight:800;font-size:44px;line-height:1;text-transform:uppercase">${pc.name}</div></div>
      ${pc.power && html`<button type="button" class=${`power ${on ? 'on' : ''}`} style="width:76px;height:76px" aria-label=${on ? 'Turn PC off' : 'Turn PC on'}
        onClick=${() => act({ action: 'game_pc_power', on: !on })}><${Icon} name="power" size=${34} color=${on ? '#fff' : 'var(--acc)'} w=${2.4} /></button>`}
    </div>
    <div class="stats">${pc.sensors.map((s) => html`<${Stat} s=${s} />`)}</div>
    ${!pc.sensors.length && html`<div class="empty" style="color:var(--on-choc2)">Add the PC's sensors to games.json to show them here.</div>`}
  </aside>`;
}

function Stat({ s }) {
  const st = useEntity(s.entity);
  const n = Number(st?.state);
  const ok = st && Number.isFinite(n);
  const unit = st?.attributes?.unit_of_measurement || '';
  const value = !ok ? (st?.state || '—') : s.kind === 'percent' ? `${Math.round(n)}%` : s.kind === 'temp' ? `${Math.round(n)}°` : `${n >= 100 ? Math.round(n) : Math.round(n * 10) / 10}`;
  const hot = s.kind === 'temp' && ok && n >= 80;
  return html`<div class="stat">
    <div class="l">${s.label}</div>
    <div class=${`v ${hot ? 'hot' : ''}`}>${value}${s.kind === 'value' && ok && html`<small>${unit}</small>`}</div>
    ${s.kind === 'percent' && ok && html`<div class="bar"><i style=${`width:${Math.min(100, Math.max(0, n))}%`}></i></div>`}
  </div>`;
}

function Setup() {
  return html`<section class="card" style="max-width:1000px">
    <${H2} title="Set up games" />
    <p style="font-size:19px;line-height:1.55">Copy <b>config/games.example.json</b> to <b>config/games.json</b> next to the panel's docker-compose.yml and fill in:</p>
    <ul style="font-size:18px;line-height:1.7">
      <li>the HDMI switcher's Home Assistant select entity (e.g. from the OREI integration) and each console's option name</li>
      <li>which projector input the switcher and the gaming PC are on</li>
      <li>the PC's power entity, stats sensors and Steam launch script in Home Assistant</li>
    </ul>
    <p style="font-size:19px">For the Steam library, add <b>STEAM_API_KEY</b> and <b>STEAM_ID</b> to the panel's .env.</p>
  </section>`;
}

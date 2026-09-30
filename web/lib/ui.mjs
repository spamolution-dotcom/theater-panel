// Shared UI pieces: the htm binding, stroke icons, posters, segmented controls and sliders.

import { h } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import htm from 'htm';

export const html = htm.bind(h);

const PATHS = {
  home: 'M3 11l9-8 9 8v10h-6v-6H9v6H3z',
  film: 'M3 4h18v16H3zM7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4',
  plus: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v8M8 12h8',
  music: 'M9 18V5l11-2v13M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM17 13a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  bulb: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  power: 'M12 3v9M6.3 7.5a8 8 0 1 0 11.4 0',
  check: 'M5 12l5 5 9-10',
  back: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  fwd: 'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
  volm: 'M3 9h4l5-4v14l-5-4H3zM16 12h6',
  volp: 'M3 9h4l5-4v14l-5-4H3zM16 12h6M19 9v6',
  mute: 'M3 9h4l5-4v14l-5-4H3zM16 9l6 6M22 9l-6 6',
  cc: 'M3 5h18v14H3zM10.5 10a2 2 0 1 0 0 4M17 10a2 2 0 1 0 0 4',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  cup: 'M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 10h2a2 2 0 0 1 0 4h-2M8 3v2M12 3v2',
  shuffle: 'M3 6h4l10 12h4M3 18h4l3-3.6M14 9.6L17 6h4M18 3l3 3-3 3M18 15l3 3-3 3',
  repeat: 'M4 11V9a3 3 0 0 1 3-3h13M17 3l3 3-3 3M20 13v2a3 3 0 0 1-3 3H4M7 21l-3-3 3-3',
  dl: 'M12 3v12M7 10l5 5 5-5M4 20h16',
  spk: 'M6 3h12v18H6zM12 11a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 6.5v1',
  x: 'M6 6l12 12M18 6L6 18',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 21a8 8 0 0 1 16 0',
  therm: 'M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  screen: 'M2 4h20v13H2zM6 21h12',
  dice: 'M4 4h16v16H4zM9 9h.01M15 15h.01M15 9h.01M9 15h.01',
  chev: 'M9 6l6 6-6 6',
  down: 'M6 9l6 6 6-6',
  left: 'M15 6l-6 6 6 6',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  pad: 'M6 11h4M8 9v4M15 12h.01M18 10h.01M17.3 5H6.7a4 4 0 0 0-3.96 3.43l-.9 6.3A2.5 2.5 0 0 0 4.3 17.6h.2a2.5 2.5 0 0 0 2.12-1.18L7.6 15h8.8l.98 1.42A2.5 2.5 0 0 0 19.5 17.6h.2a2.5 2.5 0 0 0 2.46-2.87l-.9-6.3A4 4 0 0 0 17.3 5z',
  joystick: 'M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 9v7M4 16h16v5H4zM17 16v-2',
  remote: 'M9 2h6a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM12 5v3M10.5 6.5h3M12 12h.01M12 15h.01M11 19h2',
  tv: 'M3 5h18v12H3zM8 21h8M12 17v4',
  plug: 'M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5',
  receiver: 'M2.5 7h19v10h-19zM17 9.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM5.5 11h6M5.5 13.5h4',
  projector: 'M2.5 8h19v9h-19zM15.5 9.9a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2zM6 11h3M6 17v2M18 17v2',
  blindOpen: 'M3 3.5h18M5 3.5V20.5h14V3.5M5 6.5h14M12 6.5v2.5',
  blindMovie: 'M3 3.5h18M5 3.5V20.5h14V3.5M5 7h14M5 10h14M5 13h14M12 13v2.5',
  blindClose: 'M3 3.5h18M5 3.5V20.5h14V3.5M5 7h14M5 10h14M5 13h14M5 16h14M5 19h14',
  cast: 'M3 17a4 4 0 0 1 4 4M3 13a8 8 0 0 1 8 8M3 9.5V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4',
  screenplay: 'M3 6h18v12H3zM8 21h8M12 18v3M10 9.8v4.4l3.8-2.2z',
  diamondplay: 'M12 3l9 9-9 9-9-9zM10.5 9.5v5l4-2.5z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01M12 7h4M12 17h4',
  plex: 'M6 3h5l7 9-7 9H6l7-9z',
  youtube: 'M3 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM10 9v6l5-3z',
  app: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  playc: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM10 8.5v7l6-3.5z',
  // holiday glyphs (see server/accents.mjs)
  pumpkin: 'M12 6c-1.5-1.5-3.5-1.5-5 0-2.5 1-4 3.5-4 6.5C3 17 5.5 20 8 20c1.5 0 3-.6 4-1.6 1 1 2.5 1.6 4 1.6 2.5 0 5-3 5-7.5 0-3-1.5-5.5-4-6.5-1.5-1.5-3.5-1.5-5 0zM12 6c0-1.5.5-2.5 2-3M9 12l1.5 2M15 12l-1.5 2M9 16.5c1 1 5 1 6 0',
  leaf: 'M20 4c-8 0-14 4-15 12 4-6 8-8 12-9-3 2-7 5-9 12C17 19 20 12 20 4zM5 20l4-6',
  snowflake: 'M12 2v20M2 12h20M4.9 4.9l14.2 14.2M19.1 4.9L4.9 19.1M12 2l-2.5 2.5M12 2l2.5 2.5M12 22l-2.5-2.5M12 22l2.5-2.5M2 12l2.5-2.5M2 12l2.5 2.5M22 12l-2.5-2.5M22 12l-2.5 2.5',
  sparkle: 'M12 3c.6 4.5 3.5 7.4 9 9-5.5 1.6-8.4 4.5-9 9-.6-4.5-3.5-7.4-9-9 5.5-1.6 8.4-4.5 9-9zM5 3l.5 2M4 6l2-1M19 17l.5 2M18 20l2-1',
  heart: 'M12 20.5s-8-5.2-8-11A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5c0 5.8-8 11-8 11z',
  tree: 'M12 2l4 6h-2.5l3.5 5h-2.5l4 6H5.5l4-6H7l3.5-5H8zM12 19v3',
  // the "how was it?" card
  star: 'M12 3.2l2.7 5.9 6.3.8-4.7 4.4 1.2 6.2L12 17.4 6.5 20.5l1.2-6.2L3 9.9l6.3-.8z',
  cake: 'M4 20h16M5 20v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7M5 15c1.5 1.5 3 1.5 4.5 0s3 1.5 4.5 0 3 1.5 4.5 0M12 11V8M12 8c-1.5-1-1.5-3 0-4 1.5 1 1.5 3 0 4z',
};

// Built-in outline icons by name, or any "prefix:name" icon (mdi:, cbi:, fa7-brands: ...) served by
// the panel from Home Assistant's icon sets, drawn in the current text colour with a CSS mask.
export function Icon({ name, size = 24, color = 'currentColor', w = 2, fill = 'none' }) {
  if (name && name.includes(':')) {
    const [prefix, icon] = name.split(':');
    // Only an explicit colour is inline, so CSS can colour it like the built-in icons.
    return html`<span class="xicon" aria-hidden="true" style=${`width:${size}px;height:${size}px;${color !== 'currentColor' ? `color:${color};` : ''}--src:url('/api/icon/${prefix}/${icon}.svg')`}></span>`;
  }
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill=${fill} stroke=${color} stroke-width=${w} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${PATHS[name]} /></svg>`;
}
export const Play = ({ size = 24, color = 'currentColor' }) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill=${color} /></svg>`;
export const Pause = ({ size = 24, color = 'currentColor' }) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true"><rect x="5.5" y="4" width="4.5" height="16" rx="1" fill=${color} /><rect x="14" y="4" width="4.5" height="16" rx="1" fill=${color} /></svg>`;
export const Prev = ({ size = 24, color = 'currentColor' }) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true"><path d="M19 5v14L8 12z" fill=${color} /><rect x="5" y="5" width="2.5" height="14" rx="1" fill=${color} /></svg>`;
export const Next = ({ size = 24, color = 'currentColor' }) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14l11-7z" fill=${color} /><rect x="16.5" y="5" width="2.5" height="14" rx="1" fill=${color} /></svg>`;

// Poster with a title fallback while loading or when there is no art.
export function Poster({ src, title, children, style }) {
  const [ok, setOk] = useState(true);
  // A new src gets a fresh try; otherwise one broken thumbnail would stick to a reused slot.
  useEffect(() => setOk(true), [src]);
  return html`<div class="poster" style=${style}>
    ${src && ok ? html`<img src=${src} alt="" loading="lazy" decoding="async" onError=${() => setOk(false)} />` : html`<div class="fallback">${title}</div>`}
    ${children}
  </div>`;
}

export function Seg({ options, value, onChange, cls = '' }) {
  return html`<div class=${`seg ${cls}`}>
    ${options.map((o) => {
      const v = typeof o === 'string' ? o : o.value;
      const label = typeof o === 'string' ? o : o.label;
      return html`<button type="button" aria-pressed=${v === value ? 'true' : 'false'} disabled=${o.disabled} onClick=${() => onChange?.(v)}>${label}</button>`;
    })}
  </div>`;
}

// Slider that follows the finger locally and sends one update when released.
export function Range({ value, onCommit, label, fill, rest, cls = '' }) {
  const [v, setV] = useState(value);
  const dragging = useRef(false);
  // A cancelled drag (palm, scroll, focus loss) never fires change, so release on those too.
  const release = () => { dragging.current = false; };
  useEffect(() => { if (!dragging.current) setV(value); }, [value]);
  const style = `--pct:${v}%;${fill ? `--fill:${fill};` : ''}${rest ? `--rest:${rest};` : ''}`;
  return html`<input class=${`range ${cls}`} type="range" min="0" max="100" value=${v} aria-label=${label} style=${style}
    onPointerDown=${() => { dragging.current = true; }}
    onPointerUp=${release} onPointerCancel=${release} onLostPointerCapture=${release}
    onInput=${(e) => setV(Number(e.target.value))}
    onChange=${(e) => { dragging.current = false; onCommit?.(Number(e.target.value)); }} />`;
}

export function Header({ title, kicker, children }) {
  return html`<header class="top">
    <div><div class="kicker">${kicker}</div><h1>${title}</h1></div>
    <div class="right">${children}</div>
  </header>`;
}


export function H2({ title, children }) {
  return html`<div class="h2"><h2>${title}</h2>${children}</div>`;
}

// Debounce helper for search boxes.
export function useDebounced(value, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value]);
  return v;
}

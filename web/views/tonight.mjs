// Tonight: the evening around a film. Pick the film and a time (or now), and the panel runs
// the pre-show lights, the trailers on the projector, the feature, and a break in the middle
// of a long one. The plan is what the marquee outside the room shows. Also here: the guest
// remote's QR, and what the room usually does on this weekday.

import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Play, Poster } from '../lib/ui.mjs';
import { get, post, useLoad, useStore, toast, runtime } from '../lib/api.mjs';

const at = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
const hour12 = (h) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;

// Start times on offer: every half hour from the next one to midnight, "Now" first.
function slots() {
  const out = [];
  let d = new Date();   // reassigned below: a const here threw, and the sheet never opened
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  const end = new Date(); end.setHours(23, 59, 0, 0);
  while (d <= end && out.length < 12) { out.push(d.getTime()); d = new Date(d.getTime() + 30 * 60e3); }
  return out;
}

export function TonightSheet({ item: given = null, onClose }) {
  const plan = useStore((s) => s.tonight);
  const [deck] = useLoad(() => get('/api/plex/ondeck?size=6').catch(() => []), []);
  const [habits] = useLoad(() => get('/api/habits').catch(() => null), []);
  const [pick, setPick] = useState(given);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [when, setWhen] = useState(null);      // null = now
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!q.trim()) { setHits([]); return; } const t = setTimeout(() => get(`/api/plex/search?q=${encodeURIComponent(q)}`).then((r) => setHits((r.items || r || []).filter((x) => x.type === 'movie').slice(0, 6))).catch(() => {}), 250); return () => clearTimeout(t); }, [q]);

  const send = async (body) => {
    setBusy(true);
    try { await post('/api/tonight', body); toast(body.clear ? 'Tonight cleared' : body.start ? 'Starting the evening' : `Scheduled for ${at(body.at)}`); if (!body.skip) onClose(); }
    catch (e) { toast(e.message, true); }
    finally { setBusy(false); }
  };
  const today = habits?.today;
  const usual = today?.plays ? `${today.name}s here: ${today.startHour != null ? `from ${hour12(today.startHour)}` : 'quiet'}, ${today.movies >= today.shows ? 'mostly films' : 'mostly series'}${today.titles?.length ? ` · ${today.titles.slice(0, 2).map((x) => x.title).join(', ')}` : ''}` : '';

  return html`<div class="mystery-sheet tonight" role="dialog" aria-label="Tonight">
    <div class="h">
      <div><div class="eyebrow">${plan ? (plan.state === 'scheduled' ? `Tonight at ${at(plan.at)}` : plan.state === 'trailers' ? 'Coming attractions' : plan.state === 'feature' ? 'Now showing' : plan.state === 'done' ? 'That was tonight' : 'Ready when you are') : 'Plan the evening'}</div>
        <div class="t">${plan ? plan.item.title : 'Tonight'}</div></div>
      <button type="button" class="icon-btn" style="width:46px;height:46px;background:rgba(0,0,0,.25)" aria-label="Close" onClick=${onClose}><${Icon} name="x" color="#F4F0E8" /></button>
    </div>
    ${usual && html`<div class="usual"><${Icon} name="chart" size=${20} color="var(--gold)" />${usual}</div>`}
    ${plan ? html`<div class="plan">
        <div class="art"><${Poster} src=${plan.item.poster} title=${plan.item.title} /></div>
        <div class="info">
          <div class="mono meta">${[plan.item.year, plan.item.duration && runtime(plan.item.duration), plan.item.contentRating, plan.item.quality?.res].filter(Boolean).join(' · ')}</div>
          ${plan.times ? html`<div class="slots">
            ${plan.times.preshow < (plan.times.trailers ?? plan.times.feature) && html`<div><b>${at(plan.times.preshow)}</b><span>Lights</span></div>`}
            ${plan.trailers.length > 0 && html`<div class=${plan.state === 'trailers' ? 'now' : ''}><b>${at(plan.times.trailers)}</b><span>${plan.trailers.length} trailer${plan.trailers.length === 1 ? '' : 's'}</span></div>`}
            <div class=${plan.state === 'feature' ? 'now' : ''}><b>${at(plan.times.feature)}</b><span>Feature</span></div>
            ${plan.times.intermission && html`<div><b>${at(plan.times.intermission)}</b><span>Intermission</span></div>`}
            <div><b>${at(plan.times.ends)}</b><span>Ends</span></div>
          </div>` : html`<p>${plan.trailers.length ? `${plan.trailers.length} trailer${plan.trailers.length === 1 ? '' : 's'} first, then the film` : 'The film, straight in'}${plan.intermissionAt ? `, with a break at ${runtime(plan.intermissionAt)}` : ''}.</p>`}
          ${plan.trailers.length > 0 && html`<div class="trailers">${plan.trailers.map((tr, i) => html`<span class=${`filter ${plan.state === 'trailers' && plan.showing === i ? 'on' : ''}`} aria-pressed=${plan.state === 'trailers' && plan.showing === i ? 'true' : 'false'}>${tr.title}${tr.year ? ` (${tr.year})` : ''}</span>`)}</div>`}
          <div style="flex-grow:1"></div>
          <div class="acts">
            ${['scheduled', 'ready', 'preshow'].includes(plan.state) && html`<button type="button" class="btn primary big" style="flex-grow:1" disabled=${busy} onClick=${() => send({ start: true })}><${Play} size=${28} />Start now</button>`}
            ${plan.state === 'trailers' && html`<button type="button" class="btn primary big" style="flex-grow:1" disabled=${busy} onClick=${() => send({ skip: true })}><${Play} size=${28} />Skip to the feature</button>`}
            <button type="button" class="btn big ghost" disabled=${busy} onClick=${() => send({ clear: true })}>${plan.state === 'done' ? 'Clear' : 'Cancel tonight'}</button>
          </div>
        </div>
      </div>`
    : html`<div class="body">
        <div class="lbl">The film</div>
        <div class="chips">
          ${(pick ? [pick] : []).concat((deck || []).filter((d) => d.type === 'movie' && d.id !== pick?.id)).map((d) => html`<button type="button" class="filter" aria-pressed=${pick?.id === d.id ? 'true' : 'false'} onClick=${() => setPick(d)}>${d.title}${d.year ? ` (${d.year})` : ''}</button>`)}
        </div>
        <div class="search"><${Icon} name="search" size=${22} /><input type="text" placeholder="Or search the library" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
        ${hits.length > 0 && html`<div class="chips">${hits.map((d) => html`<button type="button" class="filter" aria-pressed=${pick?.id === d.id ? 'true' : 'false'} onClick=${() => { setPick(d); setQ(''); }}>${d.title}${d.year ? ` (${d.year})` : ''}</button>`)}</div>`}
        <div class="lbl">When</div>
        <div class="chips">
          <button type="button" class="filter" aria-pressed=${when === null ? 'true' : 'false'} onClick=${() => setWhen(null)}>Now</button>
          ${slots().map((ms) => html`<button type="button" class="filter" aria-pressed=${when === ms ? 'true' : 'false'} onClick=${() => setWhen(ms)}>${at(ms)}</button>`)}
        </div>
        <p class="hint">A scheduled evening brings the lights down first, plays the trailers on the projector, then the film. The marquee outside shows the times.</p>
        <div style="flex-grow:1"></div>
        <div class="acts">
          <button type="button" class="btn primary big" style="flex-grow:1" disabled=${busy || !pick} onClick=${() => send(when ? { ratingKey: pick.id, at: when } : { ratingKey: pick.id, start: true })}>
            <${Play} size=${28} />${!pick ? 'Pick a film' : when ? `Schedule for ${at(when)}` : 'Start the evening'}</button>
          ${pick && when && html`<button type="button" class="btn big ghost" disabled=${busy} onClick=${() => send({ ratingKey: pick.id, at: when, trailers: false })}>Without trailers</button>`}
        </div>
      </div>`}
  </div>`;
}

// The guest remote: a QR that opens a phone page with the basics for the evening.
export function GuestSheet({ onClose }) {
  const [g, setG] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { post('/api/guest/start', {}).then(setG).catch((e) => setErr(e.message)); }, []);
  const link = g?.token ? `${location.origin}/guest?t=${g.token}` : '';
  return html`<div class="sheet dark tx-suede" role="dialog" aria-label="Guest remote">
    <div class="h">
      <div><div class="eyebrow">For the evening</div><div class="t">Guest remote</div></div>
      <button type="button" class="icon-btn" style="width:46px;height:46px;background:rgba(0,0,0,.25)" aria-label="Close" onClick=${onClose}><${Icon} name="x" color="#F4F0E8" /></button>
    </div>
    <div class="scan-body">
      ${err ? html`<p class="empty">${err}</p>`
      : link ? html`<img class="qr" src=${`/api/vote/qr.svg?url=${encodeURIComponent(link)}`} alt="" />
          <div class="scan-text">
            <p>Point a phone at the code: pause, volume, the break and the lights, nothing else. The link works until ${at(g.expires)}, or until you end it here.</p>
            <button type="button" class="btn ghost" style="height:56px" onClick=${() => post('/api/guest/end', {}).then(onClose).catch((e) => toast(e.message, true))}>End the guest link now</button>
          </div>`
      : html`<p class="empty">Making the link…</p>`}
    </div>
  </div>`;
}

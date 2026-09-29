// Movie night: a shortlist from the Movies tab, then everyone votes from their phones. The panel
// shows a QR for /vote and the tallies come back over the event stream. Tap a poster to play it.

import { useState, useEffect } from 'preact/hooks';
import { html, Icon, Play, Poster, Header, H2 } from '../lib/ui.mjs';
import { get, post, useStore, toast, runtime, endsAt } from '../lib/api.mjs';
import { play } from './lobby.mjs';
import { route } from '../app.mjs';

const FILTERS = [
  { key: 'short', label: 'Under 2 hours' },
  { key: 'family', label: 'Family friendly' },
  { key: '4k', label: '4K' },
  { key: 'hdr', label: 'HDR' },
];

export function Pick() {
  const [filters, setFilters] = useState([]);
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState(null);      // the season shelf the shortlist came from
  const [season, setSeason] = useState(true);      // draw from the season while one is up
  const votes = useStore((s) => s.vote);
  const voteUrl = `${location.origin}/vote`;

  async function shuffle() {
    setBusy(true);
    try {
      const r = await get(`/api/pick?n=3&filters=${filters.join(',')}${season ? (route.params.season ? `&season=${encodeURIComponent(route.params.season)}` : '') : '&season=0'}`);
      setItems(r.items); setSource(r.source || null);
      if (votes) await post('/api/vote/start', { items: r.items.map(({ id, title, year, poster }) => ({ id, title, year, poster })) });
    } catch (e) { toast(e.message, true); }
    setBusy(false);
  }
  useEffect(() => { shuffle(); }, [filters.join(','), season]);

  const startVote = async () => {
    try { await post('/api/vote/start', { items: (items || []).map(({ id, title, year, poster }) => ({ id, title, year, poster })) }); }
    catch (e) { toast(e.message, true); }
  };
  const endVote = async () => {
    try {
      const { winner } = await post('/api/vote/end', {});
      if (!winner) return toast('No clear winner');
      const it = items.find((x) => String(x.id) === String(winner.id));
      if (it) play(it, true);
    } catch (e) { toast(e.message, true); }
  };
  const cancelVote = async () => {
    try { await post('/api/vote/end', {}); }
    catch (e) { toast(e.message, true); }
  };
  const toggle = (k) => setFilters(filters.includes(k) ? filters.filter((f) => f !== k) : [...filters, k]);
  const leader = votes?.voters ? Object.entries(votes.tally).sort((a, b) => b[1] - a[1])[0] : null;

  return html`<main class="view">
    <${Header} title="Movie night" kicker=${source ? `Three from ${source}` : 'Three from the unwatched pile'}>
      ${(source || !season) && html`<button type="button" class="chip" aria-pressed=${season ? 'true' : 'false'} onClick=${() => setSeason(!season)}>
        ${season && html`<${Icon} name="check" size=${18} />`}${source || 'The season'}</button>`}
      ${FILTERS.map((f) => html`<button type="button" class="chip" aria-pressed=${filters.includes(f.key) ? 'true' : 'false'} onClick=${() => toggle(f.key)}>
        ${filters.includes(f.key) && html`<${Icon} name="check" size=${18} />`}${f.label}</button>`)}
      <button type="button" class="chip" disabled=${busy} onClick=${shuffle}><${Icon} name="dice" size=${20} />${busy ? 'Picking…' : 'Shuffle'}</button>
    <//>
    <div class="pick-body">
      <div class="pick-cards">
        ${!items?.length && html`<div class="empty" style="grid-column:1/-1;align-self:center;font-size:22px">${busy || items === null ? 'Picking three films…' : 'Nothing unwatched matches. Try removing a filter.'}</div>`}
        ${(items || []).map((m) => {
          const count = votes?.tally?.[m.id] ?? 0;
          const winning = leader && String(leader[0]) === String(m.id) && leader[1] > 0;
          return html`<button type="button" class=${`pick-card ${winning ? 'lead' : ''}`} key=${m.id} onClick=${() => play(m, true)}>
            <${Poster} src=${m.poster} title=${m.title} />
            <div class="t ellipsis">${m.title}</div>
            <div class="m">${[m.year, runtime(m.duration), m.contentRating].filter(Boolean).join(' · ')}</div>
            <div class="e">Ends ${endsAt(m.duration || 0)}</div>
            ${votes && html`<div class="v"><b>${count}</b> vote${count === 1 ? '' : 's'}</div>`}
            <div class="go"><${Play} size=${22} color="#fff" />Play</div>
          </button>`;
        })}
        ${items && !items.length && html`<div class="empty">Nothing matched. Drop a filter.</div>`}
      </div>
      <aside class="card vote-card">
        <${H2} title=${votes ? 'Voting' : 'Let everyone vote'} />
        ${votes ? html`
          <img class="qr" src=${`/api/vote/qr.svg?url=${encodeURIComponent(voteUrl)}`} alt="" onError=${(e) => { e.target.style.display = 'none'; }} />
          <div class="url">${voteUrl.replace(/^https?:\/\//, '')}</div>
          <div class="tally">${votes.voters} vote${votes.voters === 1 ? '' : 's'} in</div>
          <div style="flex-grow:1"></div>
          <button type="button" class="btn primary big" onClick=${endVote}><${Icon} name="check" />Play the winner</button>
          <button type="button" class="btn sm" onClick=${cancelVote}>Cancel vote</button>
        ` : html`
          <p style="font-size:19px;line-height:1.5">Everyone scans the code and picks from their phone. The count shows up here, and the winner plays on the projector.</p>
          <div style="flex-grow:1"></div>
          <button type="button" class="btn primary big" disabled=${!items?.length} onClick=${startVote}><${Icon} name="user" />Start the vote</button>
        `}
      </aside>
    </div>
  </main>`;
}

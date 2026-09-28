// Year in review: what the house actually watched, from Stremio's watch history. Plays are exact;
// hours are an estimate (history says something was watched, not for how long), so the screen
// says "about". Reachable at #/year, from the For you tab, and from Home Assistant.

import { html, Icon, Poster, Header } from '../lib/ui.mjs';
import { get, useLoad } from '../lib/api.mjs';
import { route } from '../app.mjs';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const n = (x) => (x ?? 0).toLocaleString();

export function Year() {
  const now = new Date().getFullYear();
  const year = Math.min(Math.max(Number(route.params.year) || now, 2000), now);
  const [d, err] = useLoad(() => get(`/api/year?year=${year}`), [year]);

  if (err) return html`<main class="view"><${Header} title="Year in review" kicker="Stremio" /><div class="empty">${err.message}</div></main>`;
  if (!d) return html`<main class="view"><${Header} title="Year in review" kicker="Stremio" /><div class="empty">Counting…</div></main>`;

  const days = Math.round(d.hours / 24);
  const busiest = DAYS[d.days.indexOf(Math.max(...d.days))];
  const peak = d.hours24.indexOf(Math.max(...d.hours24));
  const hour12 = `${peak % 12 || 12}${peak < 12 ? 'am' : 'pm'}`;
  const maxMonth = Math.max(...d.months, 1);
  const maxPerson = Math.max(...d.people.map((p) => p.plays), 1);

  return html`<main class="view">
    <${Header} title=${`${d.year} at the theater`} kicker="Year in review · from Stremio's watch history">
      <div class="hscroll" style="display:flex;gap:10px">
        ${[now, now - 1, now - 2].map((y) => html`<a class="filter" href=${`#/year?year=${y}`} aria-pressed=${y === year ? 'true' : 'false'}>${y}</a>`)}
      </div>
    <//>

    <div class="year-top">
      <div class="big-stat wide">
        <span class="k">About</span><span class="v">${n(d.hours)}</span><span class="u">hours</span>
        <span class="note">${days} whole days in front of a screen</span>
      </div>
      <div class="big-stat"><span class="k">Plays</span><span class="v">${n(d.plays)}</span><span class="note">${n(d.movies)} films · ${n(d.episodes)} episodes</span></div>
      <div class="big-stat"><span class="k">Titles</span><span class="v">${n(d.distinct)}</span><span class="note">different films and series</span></div>
      <div class="big-stat"><span class="k">Busiest</span><span class="v small">${busiest}</span><span class="note">and most often around ${hour12}</span></div>
    </div>

    <div class="year-body">
      <section class="card year-top10">
        <div class="h2"><h2>The ten it kept coming back to</h2></div>
        <div class="strip">
          ${d.top.map((t, i) => html`<div class="topten" key=${t.key}>
            <span class="rank">${i + 1}</span>
            <${Poster} src=${t.poster} title=${t.title} />
            <span class="t ellipsis">${t.title}</span>
            <span class="y">${t.type === 'movie' ? `${t.plays} play${t.plays === 1 ? '' : 's'}` : `${t.plays} episodes`} · ${Math.round(t.ms / 3600e3)}h</span>
          </div>`)}
        </div>
      </section>

      <div class="year-side">
        <section class="card">
          <div class="h2"><h2>Who watched</h2></div>
          ${d.people.map((p) => html`<div class="person" key=${p.name}>
            <span class="who ellipsis">${p.name}</span>
            <span class="bar"><i style=${`width:${(p.plays / maxPerson) * 100}%`}></i></span>
            <span class="num mono">${n(p.plays)}</span>
          </div>`)}
        </section>

        <section class="card">
          <div class="h2"><h2>Through the year</h2></div>
          <div class="months">
            ${d.months.map((m, i) => html`<span class="m" key=${i}><i style=${`height:${Math.max(3, (m / maxMonth) * 100)}%`}></i><span>${MONTHS[i][0]}</span></span>`)}
          </div>
        </section>

        ${d.binge && html`<section class="card binge">
          ${d.binge.poster && html`<img src=${d.binge.poster} alt="" />`}
          <div>
            <div class="eyebrow"><${Icon} name="cup" size=${18} color="var(--gold)" />Longest sitting</div>
            <div class="t">${d.binge.plays} episodes of ${d.binge.title}</div>
            <div class="muted">in one day · ${d.binge.date.replace(/^\w+ /, '')}</div>
          </div>
        </section>`}
      </div>
    </div>
  </main>`;
}

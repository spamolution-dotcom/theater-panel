// The birthday show's teaser: a "Now showing" poster whose button asks HA to start the show.
// ?test=1 runs the silent rehearsal instead (no sound, blind left alone).
const $ = (id) => document.getElementById(id);
const test = new URLSearchParams(location.search).has('test');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The teaser's words arrive in the URL (?d=<base64url JSON>, set by the HA automation that opens
// this page) so they stay in HA; a teaser.json beside the poster is the fallback.
const fromUrl = () => {
  const d = new URLSearchParams(location.search).get('d');
  if (!d) return null;
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(d.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))); } catch { return null; }
};
const t = fromUrl() || await fetch('/api/birthday/teaser.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
$('title').textContent = $('ptitle').textContent = t.name || 'Tonight';
$('credit').textContent = t.credit || '';
$('tagline').textContent = t.tagline || '';
$('meta').innerHTML = (t.meta || []).map(([k, v]) => `<span><b>${esc(k)}</b>${esc(v)}</span>`).join('');
if (t.after) $('after').textContent = t.after;
$('poster').src = '/api/birthday/poster.jpg';
if (t.posterPos) $('poster').style.objectPosition = t.posterPos;
$('poster').onerror = () => $('poster').remove();
if (test) $('hint').textContent = 'Silent test · no sound, blind stays put';
document.querySelector('.wrap').hidden = false;

$('go').addEventListener('click', async () => {
  $('go').disabled = true;
  try {
    const r = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'birthday', cmd: 'start', test }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    $('curtain').hidden = false;
  } catch {
    $('go').disabled = false;
    $('hint').textContent = 'That did not start. Try again?';
  }
});

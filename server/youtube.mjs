// YouTube videos playing in SmartTube on the Shield: the Shield's media session gives only the
// title and channel, so the panel looks the video up once with the YouTube Data API (a key in the
// app's options) for its official thumbnail and its length (so the progress bar works too).
// One search (100 units) and one details call (1 unit) per new video: the free 10,000 units a day
// cover about 95 videos. Without a key, or with the day's quota used, it answers nothing and the
// screens keep the TV screenshot.

import { config } from './config.mjs';
import { extImage } from './images.mjs';

const API = 'https://www.googleapis.com/youtube/v3';
const found = new Map();            // "title|channel" -> { id, thumb, duration } | false (no match) | null (asking)
let pausedUntil = 0;                // quota used up or the key refused: stop asking until then
const norm = (t) => String(t || '').toLowerCase().replace(/&amp;/g, '&').replace(/&#39;|&quot;/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();

// ISO 8601 duration (PT1H2M3S) to ms.
function isoMs(d) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
  return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000 : 0;
}

async function get(path, params) {
  const url = `${API}/${path}?${new URLSearchParams({ ...params, key: config.youtube.apiKey })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (res.status === 403 || res.status === 400) {
    // Quota used up (resets at midnight Pacific) or the key refused: try again in an hour.
    pausedUntil = Date.now() + 3600e3;
    const why = (await res.json().catch(() => null))?.error?.errors?.[0]?.reason || res.status;
    throw new Error(`YouTube API refused (${why}); trying again in an hour`);
  }
  if (!res.ok) throw new Error(`YouTube API ${res.status}`);
  return res.json();
}

async function search(key, title, channel) {
  const s = await get('search', { part: 'snippet', type: 'video', maxResults: '5', q: [title, channel].filter(Boolean).join(' ') });
  const items = (s.items || []).filter((it) => it.id?.videoId);
  // The same title from the same channel first, then the same channel, then the top result.
  const pick = items.find((it) => norm(it.snippet?.title) === norm(title) && (!channel || norm(it.snippet?.channelTitle) === norm(channel)))
    || (channel && items.find((it) => norm(it.snippet?.channelTitle) === norm(channel)))
    || items[0];
  if (!pick) { found.set(key, false); return; }
  const id = pick.id.videoId;
  const th = pick.snippet?.thumbnails || {};
  const thumb = (th.maxres || th.standard || th.high || th.medium || th.default || {}).url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  let duration = 0;
  try { duration = isoMs((await get('videos', { part: 'contentDetails', id })).items?.[0]?.contentDetails?.duration); } catch { /* no length: no bar */ }
  found.set(key, { id, thumb: extImage(thumb), duration });
}

// What is known about this video: { id, thumb, duration }, or null (no key, not found yet, none).
export function lookup(title, channel) {
  if (!config.youtube.apiKey || !title) return null;
  const key = `${norm(title)}|${norm(channel)}`;
  if (found.has(key)) return found.get(key) || null;
  if (Date.now() < pausedUntil) return null;
  found.set(key, null);
  if (found.size > 300) found.delete(found.keys().next().value);
  search(key, title, channel).catch((err) => { found.delete(key); console.warn('[youtube]', err.message); });
  return null;
}

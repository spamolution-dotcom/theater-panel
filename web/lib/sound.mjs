// What the Denon is decoding, from its sound_mode_raw, for the badge on Showtime and the phone
// remote: Dolby Atmos, Dolby, DTS, or PCM (Neural:X / Multi Ch In are its upmixers for PCM, which is
// what a Chromecast sends when it has not seen the Denon's Atmos support). Null when unknown.
export function soundFormat(raw) {
  const r = String(raw || '').toUpperCase();
  if (!r) return null;
  if (r.includes('ATMOS')) return { label: 'Dolby Atmos', kind: 'atmos' };
  if (r.includes('DTS:X') || r.includes('DTS-X')) return { label: 'DTS:X', kind: 'atmos' };
  if (r.includes('NEURAL') || r.includes('MULTI CH') || r.includes('PCM') || r.includes('STEREO')) return { label: 'PCM · no Atmos', kind: 'pcm' };
  if (r.includes('DOLBY') || r.includes('TRUEHD') || r.includes('DD+') || r.includes('DSUR')) return { label: 'Dolby', kind: 'dolby' };
  if (r.includes('DTS')) return { label: 'DTS', kind: 'dolby' };
  return null;
}

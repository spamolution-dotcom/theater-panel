// What the Denon is decoding, from its sound_mode_raw, for the badge on Showtime and the phone
// remote. Multi Ch In is multichannel PCM: menus and non-Atmos sound on a working Atmos setup (the
// Streamer and the Xbox both send it between Atmos titles), so it is not a warning. Neural:X or
// Stereo is a stereo signal being upmixed, which is what a source sends when it has not seen the
// Denon's Atmos support: that one is flagged. Null when unknown.
export function soundFormat(raw) {
  const r = String(raw || '').toUpperCase();
  if (!r) return null;
  if (r.includes('ATMOS')) return { label: 'Dolby Atmos', kind: 'atmos' };
  if (r.includes('DTS:X') || r.includes('DTS-X')) return { label: 'DTS:X', kind: 'atmos' };
  if (r.includes('MULTI CH')) return { label: 'Multichannel', kind: 'dolby' };
  if (r.includes('NEURAL') || r.includes('PCM') || r.includes('STEREO')) return { label: 'Stereo · no Atmos', kind: 'pcm' };
  if (r.includes('DOLBY') || r.includes('TRUEHD') || r.includes('DD+') || r.includes('DSUR')) return { label: 'Dolby', kind: 'dolby' };
  if (r.includes('DTS')) return { label: 'DTS', kind: 'dolby' };
  return null;
}

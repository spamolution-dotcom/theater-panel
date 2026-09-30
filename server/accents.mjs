// Holiday accents: a second axis on the panel's look, independent of the theme. A theme is the
// room (classic chocolate, or the couch's slate); an accent is what is on the mantelpiece this
// week. Each one only moves three things - the highlight colour, the rail's idle glow, and a
// small glyph by the clock - so any accent sits on any theme.
//
// ACCENT is 'auto' (by the calendar), 'none', or one of the ids below. BIRTHDAYS is a list of
// "Name=MM-DD"; on the day, the birthday accent wins over whatever holiday is running.

// gold: the highlight colour; glow: the rail's idle effect; weather: what falls over the lobby
// (web/lib/particles.mjs) - snow and leaves settle on the cards, hearts and fireflies drift.
export const ACCENTS = [
  { id: 'halloween', name: 'Halloween', gold: '#E8731C', glow: 'Halloween Eyes', weather: 'bats' },
  { id: 'thanksgiving', name: 'Thanksgiving', gold: '#C8912E', glow: 'Ember Ring', weather: 'leaves' },
  { id: 'christmas', name: 'Christmas', gold: '#E3A865', glow: 'Fairytwinkle', weather: 'xmas' },
  { id: 'newyear', name: 'New Year', gold: '#F2D69B', glow: 'Fireworks Burst', weather: 'confetti' },
  { id: 'valentines', name: "Valentine's", gold: '#D9536F', glow: 'Heartbeat Pulse', weather: 'hearts' },
  { id: 'birthday', name: 'Birthday', gold: '#E3A865', glow: 'Confetti', weather: 'confetti' },
  // the seasons fill in between the holidays when the accent is on auto
  { id: 'winter', name: 'Winter', gold: '#CFE0EC', glow: 'Rolling Fog', weather: 'snow' },
  { id: 'spring', name: 'Spring', gold: '#E39AB0', glow: 'Aurora (Pastel Dream)', weather: 'petals' },
  { id: 'summer', name: 'Summer', gold: '#F2C94C', glow: 'Firefly Jar', weather: 'fireflies' },
  { id: 'fall', name: 'Autumn', gold: '#C75E12', glow: 'Ember Ring', weather: 'leaves' },
];
export const IDS = ACCENTS.map((a) => a.id);

// "Name=MM-DD, Other=MM-DD" -> [{ name, month, day }]
export function parseBirthdays(text) {
  return String(text || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
    const [name, date] = s.includes('=') ? s.split('=') : ['', s];
    const m = /^(\d{1,2})-(\d{1,2})$/.exec(date.trim());
    return m ? { name: name.trim(), month: Number(m[1]), day: Number(m[2]) } : null;
  }).filter(Boolean);
}

// US Thanksgiving: the fourth Thursday of November.
export function thanksgiving(year) {
  const first = new Date(year, 10, 1).getDay();           // 0 = Sunday
  return 1 + ((4 - first + 7) % 7) + 21;                  // day of month
}

// Which accent the calendar says, for Australia. Halloween is all of October; Christmas runs from
// 1 December to the day before New Year's Eve; New Year is the Eve; Valentine's is Feb 10-14.
// Thanksgiving is not on the calendar (it can still be picked by hand). Between the holidays, the
// southern-hemisphere season, starting on the 1st as Australia counts them: summer Dec-Feb,
// autumn Mar-May, winter Jun-Aug, spring Sep-Nov. (The id stays 'fall'; its name is Autumn.)
export function byCalendar(now = new Date(), birthdays = []) {
  const m = now.getMonth() + 1, d = now.getDate();
  const bday = birthdays.find((b) => b.month === m && b.day === d);
  if (bday) return { id: 'birthday', who: bday.name };
  if (m === 10) return { id: 'halloween' };
  if (m === 12 && d <= 30) return { id: 'christmas' };
  if (m === 12 && d === 31) return { id: 'newyear' };
  if (m === 2 && d >= 10 && d <= 14) return { id: 'valentines' };
  if (m <= 2) return { id: 'summer' };
  if (m <= 5) return { id: 'fall' };
  if (m <= 8) return { id: 'winter' };
  return { id: 'spring' };
}

// The accent in effect for a setting: a fixed id, 'auto' by the calendar, or nothing.
export function resolve(setting, birthdays = [], now = new Date()) {
  const pick = setting === 'auto' ? byCalendar(now, birthdays) : { id: IDS.includes(setting) ? setting : 'none' };
  const def = ACCENTS.find((a) => a.id === pick.id);
  return def ? { id: def.id, name: def.name, gold: def.gold, glow: def.glow, weather: def.weather, who: pick.who || '' } : { id: 'none' };
}

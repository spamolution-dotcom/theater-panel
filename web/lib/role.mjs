// Where this screen hangs. "?role=hallway" (in the address or the #route) is a screen outside the
// cinema, like the wall tablet in the hallway: it picks what to play and shows what is on, but never
// goes dark, never takes over as an in-room remote and never asks "how was it?".
const where = `${location.search}&${location.hash}`;
export const hallway = /[?&]role=hallway\b/.test(where);

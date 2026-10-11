// Xbox mode: the Denon is on and on the console's input while the movie scene is off (Xbox Scene in
// HA starts the room that way). The panel then treats the room as on, so it offers All off rather
// than "Start the cinema", whose power icon reads like an off switch.
export const XBOX_INPUT = 'Xbox One';
export function gamingOn(states, entities) {
  if (!entities) return false;
  if (states[entities.roomOn]?.state === 'on') return false;
  const avr = states[entities.avr];
  return avr?.state === 'on' && avr.attributes?.source === XBOX_INPUT;
}

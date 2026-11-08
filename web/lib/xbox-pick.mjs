// With several Xbox accounts, follow the one that is in a game (the first listed wins a tie).
const dead = (s) => !s || ['unknown', 'unavailable', ''].includes(s.state);
export function pickXbox(states, e) {
  const list = (e && e.xboxAccounts) || (e && e.xboxAccount ? [e.xboxAccount] : []);
  for (const a of list) if (!dead(states && states[`sensor.${a}_now_playing`])) return a;
  return list[0] || '';
}
// The wide art image of an account: the first uses the configured one, the others sit beside their own entities.
export const xboxArtOf = (e, acct) => (!acct || acct === e.xboxAccount ? e.xboxArt : `image.${acct}_superhero_art`);

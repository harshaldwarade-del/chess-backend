/* Shared rules for online play: time controls, speeds and usernames. */

/** Speed of a time control by expected game length (initial + 40 moves of increment), as lichess does. */
export function speedOf({ initial, increment }) {
  const total = initial + 40 * increment;
  if (total < 180) return 'bullet';
  if (total < 480) return 'blitz';
  if (total < 1500) return 'rapid';
  return 'classical';
}
export const SPEEDS = ['bullet', 'blitz', 'rapid', 'classical'];

/** Allowed custom range: 15 seconds to 3 hours, plus 0–180 seconds a move. */
export function validClock({ initial, increment }) {
  return Number.isInteger(initial) && Number.isInteger(increment) && initial >= 15 && initial <= 10800 && increment >= 0 && increment <= 180;
}

export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/;
const RESERVED = new Set([
  'admin',
  'administrator',
  'root',
  'support',
  'help',
  'system',
  'moderator',
  'mod',
  'staff',
  'stockfish',
  'rankandfile',
  'rank-and-file',
  'anonymous',
  'guest',
  'null',
  'undefined',
  'me',
  'api',
]);

/** Returns an error message, or null when the name is fine. */
export function usernameProblem(name) {
  if (!USERNAME_RE.test(name)) return 'Use 3–20 letters, numbers, _ or -, starting with a letter or number.';
  if (RESERVED.has(name.toLowerCase())) return 'That username is reserved. Try another.';
  return null;
}

/** A free-looking suggestion built from the player's name or email (the app checks availability). */
export function suggestUsername(user) {
  const base = (user.name || user.email.split('@')[0] || 'player')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '')
    .replace(/^[_-]+/, '')
    .slice(0, 16);
  return base.length >= 3 ? base : `player${base}`;
}

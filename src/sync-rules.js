// A copy of shared/sync-rules.js (the app uses that one), kept here so the server folder deploys on
// its own. Change both together: `npm run check:shared` in the project root says if they differ.

/*
 * Which pieces of saved progress belong to the account, and how two copies of one combine.
 *
 * The browser and the server both import this file, so a merge gives the same answer on either
 * side. Every saved value travels as { value, changedAt } where changedAt is the time (ms) of the
 * last real change on the device that made it. A merge never throws away progress:
 *
 *   lines     opening-course progress, per line: the copy reviewed most recently wins
 *   most:F    a stats object (puzzle rating, memory stats): the copy with the higher F wins, since
 *             ratings depend on the order of results and can't be added up
 *   union     lists of ids (puzzles already seen): both lists
 *   max       personal bests: the higher number
 *   record    wins/draws/losses per Stockfish level: the higher count per field
 *   latest    preferences and everything else: the most recent change wins
 */

/** Keys that stay on one device: UI state that would be odd to carry across devices. */
const LOCAL_ONLY = [/^tab$/, /^learn:view$/, /^learn:filter$/, /^sync:/];

const KEY_RE = /^[A-Za-z0-9:_~.-]{1,120}$/;

export const isSyncedKey = (key) => typeof key === 'string' && KEY_RE.test(key) && !LOCAL_ONLY.some((re) => re.test(key));

export function ruleFor(key) {
  if (key === 'learn:progress') return { kind: 'lines' };
  if (key === 'puzzles:rated' || key === 'puzzles:blind') return { kind: 'most', field: 'games' };
  if (key === 'memory:stats') return { kind: 'most', field: 'rounds' };
  if (key === 'puzzles:seen' || key === 'puzzles:blind-seen') return { kind: 'union', cap: 5000 };
  if (key === 'rush:best' || key.startsWith('best:')) return { kind: 'max' };
  if (key === 'play:record') return { kind: 'record' };
  return { kind: 'latest' };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Combines two copies of one key. Either may be missing (undefined).
 * Returns { value, changedAt }.
 */
export function mergeValue(key, a, b) {
  if (!a || a.value === undefined) return b && b.value !== undefined ? { value: b.value, changedAt: num(b.changedAt) } : a;
  if (!b || b.value === undefined) return { value: a.value, changedAt: num(a.changedAt) };
  const changedAt = Math.max(num(a.changedAt), num(b.changedAt));
  const newer = num(b.changedAt) > num(a.changedAt) ? b : a;
  const rule = ruleFor(key);

  switch (rule.kind) {
    case 'lines': {
      if (!isObj(a.value) || !isObj(b.value)) return { value: newer.value, changedAt };
      return { value: mergeLines(a.value, b.value), changedAt };
    }
    case 'most': {
      if (!isObj(a.value) || !isObj(b.value)) return { value: newer.value, changedAt };
      const fa = num(a.value[rule.field]);
      const fb = num(b.value[rule.field]);
      return { value: fa === fb ? newer.value : fa > fb ? a.value : b.value, changedAt };
    }
    case 'union': {
      if (!Array.isArray(a.value) || !Array.isArray(b.value)) return { value: newer.value, changedAt };
      const seen = new Set(a.value);
      const out = [...a.value];
      for (const x of b.value) {
        if (seen.has(x)) continue;
        seen.add(x);
        out.push(x);
      }
      return { value: out.slice(-rule.cap), changedAt };
    }
    case 'max':
      return { value: Math.max(num(a.value), num(b.value)), changedAt };
    case 'record': {
      if (!isObj(a.value) || !isObj(b.value)) return { value: newer.value, changedAt };
      const out = {};
      for (const lvl of new Set([...Object.keys(a.value), ...Object.keys(b.value)])) {
        const x = isObj(a.value[lvl]) ? a.value[lvl] : {};
        const y = isObj(b.value[lvl]) ? b.value[lvl] : {};
        out[lvl] = { w: Math.max(num(x.w), num(y.w)), d: Math.max(num(x.d), num(y.d)), l: Math.max(num(x.l), num(y.l)) };
      }
      return { value: out, changedAt };
    }
    default:
      return { value: newer.value, changedAt };
  }
}

/** Opening progress: { [lineKey]: { stage, due, lapses, runs, last } }; per line, the later `last` wins. */
export function mergeLines(a, b) {
  const out = { ...a };
  for (const [id, entry] of Object.entries(b)) {
    if (!isObj(entry)) continue;
    const mine = out[id];
    if (!isObj(mine) || num(entry.last) > num(mine.last)) out[id] = entry;
  }
  return out;
}

/** True when two JSON-able values are the same. */
export const sameValue = (x, y) => JSON.stringify(x) === JSON.stringify(y);

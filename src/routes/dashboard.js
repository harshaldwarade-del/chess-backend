import { Router } from 'express';
import { DrillSession, Game, LineProgress, Match, PuzzleAttempt, UserState } from '../models/index.js';
import { requireUser } from '../middleware/auth.js';
import { route } from '../middleware/http.js';

/*
 * GET /api/dashboard: the signed-in player's own history in a compact form. The app turns it into
 * charts and insights (in the browser, so dates and times of day follow the player's time zone).
 *
 *   puzzles.rows: [time, mode, solved, puzzleRating, ratingAfter, themeIndexes]
 *   drills:       [time, mode, variant, score, details]
 *   lines:        [lineKey, stage, due, lapses, runs, lastReview]
 */
const router = Router();
router.use(requireUser);

const MODES = ['rated', 'blind', 'rush'];
const SAVED = ['puzzles:rated', 'puzzles:blind', 'rush:best', 'memory:stats', 'play:record'];
const ms = (d) => (d ? new Date(d).getTime() : null);

/** The newest `limit` documents, returned oldest first. */
const newest = (model, filter, projection, timeField, limit) =>
  model
    .find(filter, projection)
    .sort({ [timeField]: -1 })
    .limit(limit)
    .lean()
    .then((docs) => docs.reverse());

/** One finished online game, from `userId`'s side of the board. */
export function matchSummary(m, userId) {
  const color = String(m.white.user) === String(userId) ? 'w' : 'b';
  const me = color === 'w' ? m.white : m.black;
  const them = color === 'w' ? m.black : m.white;
  const winner = m.result?.winner ?? null;
  return {
    id: String(m._id),
    color,
    opponent: { username: them.username, rating: them.rating, provisional: them.provisional },
    rating: me.rating,
    diff: me.diff ?? null,
    outcome: m.status === 'aborted' ? 'aborted' : winner == null ? 'draw' : winner === color ? 'win' : 'loss',
    reason: m.result?.reason ?? null,
    speed: m.speed,
    clock: m.clock,
    rated: m.rated,
    plies: m.moves?.length ?? 0,
    moves: m.moves,
    opening: m.opening ?? null,
    endedAt: ms(m.endedAt ?? m.updatedAt),
  };
}

/** Everything the dashboard shows about one player. Used for your own page and by the admin panel. */
export async function dashboardFor(user) {
  const userId = user._id;
  const [attempts, games, sessions, lines, saved, matches] = await Promise.all([
    newest(PuzzleAttempt, { userId }, { _id: 0, at: 1, mode: 1, solved: 1, puzzleRating: 1, ratingAfter: 1, themes: 1 }, 'at', 20000),
    newest(Game, { userId }, { _id: 0, userId: 0, __v: 0 }, 'playedAt', 2000),
    newest(DrillSession, { userId }, { _id: 0, mode: 1, variant: 1, score: 1, details: 1, at: 1 }, 'at', 20000),
    LineProgress.find({ userId }, { _id: 0, lineKey: 1, stage: 1, due: 1, lapses: 1, runs: 1, last: 1 }).lean(),
    UserState.find({ userId, key: { $in: SAVED } }, { _id: 0, key: 1, json: 1 }).lean(),
    Match.find({ $or: [{ 'white.user': userId }, { 'black.user': userId }], status: 'finished' })
      .sort({ endedAt: -1 })
      .limit(1000)
      .lean()
      .then((d) => d.reverse()),
  ]);

  const themeIndex = new Map();
  const themeOf = (t) => {
    if (!themeIndex.has(t)) themeIndex.set(t, themeIndex.size);
    return themeIndex.get(t);
  };
  const rows = attempts.map((a) => [
    ms(a.at),
    MODES.indexOf(a.mode),
    a.solved ? 1 : 0,
    a.puzzleRating ?? null,
    a.ratingAfter ?? null,
    (a.themes ?? []).map(themeOf),
  ]);

  return {
    generatedAt: Date.now(),
    user: { ...user.toPublic(), lastSyncAt: user.lastSyncAt, lastSeenAt: user.lastSeenAt ?? null },
    puzzles: { modes: MODES, themes: [...themeIndex.keys()], rows },
    games: games.map((g) => ({
      id: g.clientId,
      playedAt: ms(g.playedAt),
      startFen: g.startFen,
      moves: g.moves,
      color: g.color,
      level: g.level,
      timeControl: g.timeControl ?? null,
      result: g.result,
      opening: g.opening ?? null,
      takebacks: g.takebacks ?? 0,
      hints: g.hints ?? 0,
      review: g.review ?? null,
    })),
    drills: sessions.map((s) => [ms(s.at), s.mode, s.variant ?? '', s.score, s.details ?? {}]),
    lines: lines.map((l) => [l.lineKey, l.stage, ms(l.due), l.lapses, l.runs, ms(l.last)]),
    saved: Object.fromEntries(saved.map((s) => [s.key, JSON.parse(s.json)])),
    online: { matches: matches.map((m) => matchSummary(m, userId)) },
  };
}

router.get(
  '/',
  route(async (req, res) => res.json(await dashboardFor(req.user))),
);

export default router;

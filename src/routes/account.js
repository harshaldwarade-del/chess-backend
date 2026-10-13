import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { DrillSession, Game, LineProgress, PuzzleAttempt, User, UserState } from '../models/index.js';
import { clearSession, requireUser } from '../middleware/auth.js';
import { HttpError, route, validate } from '../middleware/http.js';
import { passwordLimiter } from './auth.js';

const router = Router();
router.use(requireUser);

function byMode(groups) {
  const out = {};
  for (const { _id, n } of groups) {
    const m = (out[_id.mode] ??= { attempts: 0, solved: 0 });
    m.attempts += n;
    if (_id.solved) m.solved += n;
  }
  return out;
}

const HISTORY = { puzzleAttempts: PuzzleAttempt, games: Game, drillSessions: DrillSession };

/** A quick overview, the starting point for a progress dashboard. */
router.get(
  '/summary',
  route(async (req, res) => {
    const userId = req.user._id;
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    const [linesStarted, linesDue, puzzles, puzzles30, games] = await Promise.all([
      LineProgress.countDocuments({ userId, stage: { $gt: 0 } }),
      LineProgress.countDocuments({ userId, stage: { $gt: 0 }, due: { $lte: now } }),
      PuzzleAttempt.aggregate([{ $match: { userId } }, { $group: { _id: { mode: '$mode', solved: '$solved' }, n: { $sum: 1 } } }]),
      PuzzleAttempt.countDocuments({ userId, at: { $gte: monthAgo } }),
      Game.find({ userId }, { color: 1, 'result.winner': 1 }).lean(),
    ]);
    const record = { played: games.length, won: 0, drawn: 0, lost: 0 };
    for (const g of games) {
      if (g.result?.winner == null) record.drawn++;
      else if (g.result.winner === g.color) record.won++;
      else record.lost++;
    }
    res.json({
      lines: { started: linesStarted, due: linesDue },
      puzzles: { byMode: byMode(puzzles), last30Days: puzzles30 },
      games: record,
      memberSince: req.user.createdAt,
      lastSyncAt: req.user.lastSyncAt,
    });
  }),
);

/** Everything stored for this account, as one JSON download. */
router.get(
  '/export',
  route(async (req, res) => {
    const userId = req.user._id;
    const strip = ({ _id, __v, userId: _u, ...rest }) => rest; // eslint-disable-line no-unused-vars
    const [state, lines, ...history] = await Promise.all([
      UserState.find({ userId }).lean(),
      LineProgress.find({ userId }).lean(),
      ...Object.values(HISTORY).map((m) => m.find({ userId }).lean()),
    ]);
    res.setHeader('Content-Disposition', 'attachment; filename="rank-and-file-export.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      account: req.user.toPublic(),
      saved: Object.fromEntries(state.map((d) => [d.key, JSON.parse(d.json)])),
      openingProgress: lines.map(strip),
      ...Object.fromEntries(Object.keys(HISTORY).map((k, i) => [k, history[i].map(strip)])),
    });
  }),
);

/** Deletes the account and everything stored for it. Needs the password. */
router.delete(
  '/',
  passwordLimiter,
  validate(z.object({ password: z.string().max(200) })),
  route(async (req, res) => {
    if (!(await bcrypt.compare(req.body.password, req.user.passwordHash))) throw new HttpError(401, 'bad_credentials', 'That password is incorrect.');
    const userId = req.user._id;
    await Promise.all([UserState, LineProgress, ...Object.values(HISTORY)].map((m) => m.deleteMany({ userId })));
    await User.deleteOne({ _id: userId });
    clearSession(res);
    res.json({ ok: true });
  }),
);

export default router;

import { Router } from 'express';
import { z } from 'zod';
import { Challenge, DrillSession, Follow, Game, LineProgress, Match, PuzzleAttempt, User } from '../models/index.js';
import { requireAdmin, requireUser } from '../middleware/auth.js';
import { HttpError, route, validate } from '../middleware/http.js';
import { disconnectUser, isOnline, live, onlineCount } from '../live/socket.js';
import { dashboardFor } from './dashboard.js';

/*
 * The admin panel's API: every account and everything it has recorded, site totals, games in
 * progress, and two moderation tools (suspend an account, abort a stuck game).
 * Admins are made by ADMIN_EMAIL on the server (see admin-bootstrap.js), never through the API.
 */
const router = Router();
router.use(requireUser, requireAdmin);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const findUser = async (id) => {
  const u = /^[a-f0-9]{24}$/.test(id) ? await User.findById(id) : null;
  if (!u) throw new HttpError(404, 'not_found', 'No such user.');
  return u;
};
const row = (u, extra = {}) => ({
  id: String(u._id),
  email: u.email,
  name: u.name,
  username: u.username ?? null,
  role: u.role ?? 'user',
  suspended: !!u.suspended,
  suspendedReason: u.suspendedReason ?? '',
  profilePublic: u.profilePublic !== false,
  createdAt: u.createdAt,
  lastSeenAt: u.lastSeenAt ?? null,
  lastSyncAt: u.lastSyncAt ?? null,
  online: isOnline(String(u._id)),
  ratings: Object.fromEntries(Object.entries(u.ratings ?? {}).map(([k, v]) => [k, { rating: Math.round(v?.r ?? 1500), games: v?.games ?? 0 }])),
  ...extra,
});

router.get(
  '/stats',
  route(async (req, res) => {
    const day = new Date(Date.now() - 864e5);
    const week = new Date(Date.now() - 7 * 864e5);
    const [users, newWeek, activeDay, activeWeek, suspended, puzzles, puzzlesDay, games, matches, matchesDay, lines, drills, follows] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: week } }),
      User.countDocuments({ $or: [{ lastSeenAt: { $gte: day } }, { lastSyncAt: { $gte: day } }] }),
      User.countDocuments({ $or: [{ lastSeenAt: { $gte: week } }, { lastSyncAt: { $gte: week } }] }),
      User.countDocuments({ suspended: true }),
      PuzzleAttempt.countDocuments(),
      PuzzleAttempt.countDocuments({ at: { $gte: day } }),
      Game.countDocuments(),
      Match.countDocuments({ status: 'finished' }),
      Match.countDocuments({ status: 'finished', endedAt: { $gte: day } }),
      LineProgress.countDocuments(),
      DrillSession.countDocuments(),
      Follow.countDocuments(),
    ]);
    // sign-ups per day for the last 30 days
    const since = new Date(Date.now() - 30 * 864e5);
    const recent = await User.find({ createdAt: { $gte: since } }, { createdAt: 1 }).lean();
    const signups = {};
    for (const u of recent) {
      const k = new Date(u.createdAt).toISOString().slice(0, 10);
      signups[k] = (signups[k] ?? 0) + 1;
    }
    res.json({
      users: { total: users, newThisWeek: newWeek, activeToday: activeDay, activeThisWeek: activeWeek, suspended, onlineNow: onlineCount() },
      activity: {
        puzzles,
        puzzlesToday: puzzlesDay,
        stockfishGames: games,
        onlineGames: matches,
        onlineGamesToday: matchesDay,
        linesStudied: lines,
        drills,
        follows,
      },
      live: { gamesInProgress: live.allActive().length },
      signups,
    });
  }),
);

router.get(
  '/users',
  route(async (req, res) => {
    const q = String(req.query.q ?? '')
      .trim()
      .slice(0, 100);
    const page = Math.max(0, Number(req.query.page) || 0);
    const sort = { recent: { lastSeenAt: -1, lastSyncAt: -1 }, newest: { createdAt: -1 }, name: { usernameKey: 1, email: 1 } }[req.query.sort] ?? {
      createdAt: -1,
    };
    const filter = q
      ? {
          $or: [
            { email: { $regex: escapeRe(q), $options: 'i' } },
            { usernameKey: { $regex: escapeRe(q.toLowerCase()) } },
            { name: { $regex: escapeRe(q), $options: 'i' } },
          ],
        }
      : {};
    if (req.query.filter === 'suspended') filter.suspended = true;
    if (req.query.filter === 'admins') filter.role = 'admin';
    const PAGE = 50;
    const [total, users] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .sort(sort)
        .skip(page * PAGE)
        .limit(PAGE),
    ]);
    const ids = users.map((u) => u._id);
    const [puzzleCounts, matchCounts] = await Promise.all([
      PuzzleAttempt.aggregate([{ $match: { userId: { $in: ids } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]),
      Promise.all(ids.map((id) => Match.countDocuments({ $or: [{ 'white.user': id }, { 'black.user': id }], status: 'finished' }))),
    ]);
    const pz = new Map(puzzleCounts.map((p) => [String(p._id), p.n]));
    res.json({
      total,
      page,
      pageSize: PAGE,
      users: users.map((u, i) => row(u, { puzzles: pz.get(String(u._id)) ?? 0, onlineGames: matchCounts[i] })),
    });
  }),
);

/** One account: its details plus the same data its own dashboard is built from. */
router.get(
  '/users/:id',
  route(async (req, res) => {
    const u = await findUser(req.params.id);
    const [dashboard, followers, following] = await Promise.all([
      dashboardFor(u),
      Follow.countDocuments({ followee: u._id }),
      Follow.countDocuments({ follower: u._id }),
    ]);
    res.json({ user: row(u, { followers, following, active: live.activeFor(u._id) }), dashboard });
  }),
);

router.post(
  '/users/:id/suspend',
  validate(z.object({ reason: z.string().trim().max(300).default('') })),
  route(async (req, res) => {
    const u = await findUser(req.params.id);
    if (u.role === 'admin') throw new HttpError(400, 'invalid', 'Admins can’t be suspended here.');
    u.suspended = true;
    u.suspendedReason = req.body.reason;
    u.tokenVersion += 1; // signs them out everywhere
    await u.save();
    await Challenge.updateMany({ from: u._id, status: 'open' }, { $set: { status: 'canceled' } });
    // Their games in progress end as losses on time would: the opponent shouldn't be left waiting.
    for (const id of live.activeFor(u._id)) await live.resign(id, String(u._id));
    disconnectUser(String(u._id));
    res.json({ user: row(u) });
  }),
);

router.post(
  '/users/:id/unsuspend',
  route(async (req, res) => {
    const u = await findUser(req.params.id);
    u.suspended = false;
    u.suspendedReason = '';
    await u.save();
    res.json({ user: row(u) });
  }),
);

router.get(
  '/matches',
  route(async (req, res) => {
    const recent = await Match.find({ status: { $ne: 'started' } })
      .sort({ endedAt: -1 })
      .limit(50)
      .lean();
    res.json({
      live: live.allActive(),
      recent: recent.map((m) => ({
        id: String(m._id),
        white: { username: m.white.username, rating: m.white.rating, diff: m.white.diff },
        black: { username: m.black.username, rating: m.black.rating, diff: m.black.diff },
        speed: m.speed,
        clock: m.clock,
        rated: m.rated,
        status: m.status,
        result: m.result,
        plies: m.moves?.length ?? 0,
        endedAt: m.endedAt,
      })),
    });
  }),
);

router.post(
  '/matches/:id/abort',
  route(async (req, res) => {
    const r = await live.adminAbort(req.params.id);
    if (r?.error) throw new HttpError(400, 'invalid', r.error);
    res.json({ ok: true });
  }),
);

export default router;

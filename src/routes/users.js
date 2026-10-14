import { Router } from 'express';
import { Follow, Match, PuzzleAttempt, LineProgress, User, UserState, publicRatings } from '../models/index.js';
import { requireUser, requireUsername } from '../middleware/auth.js';
import { HttpError, route } from '../middleware/http.js';
import { Chess } from 'chess.js';
import { isOnline, live } from '../live/socket.js';
import { matchSummary } from './dashboard.js';

/*
 * Players: search, public profiles and follows. Emails are never shown to other players.
 * A player who hides their profile still appears in search and can be followed and challenged,
 * but their stats and games stay private.
 */
const router = Router();
router.use(requireUser);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The short card used in lists: search results, followers, the lobby. */
export function playerCard(u) {
  return {
    id: String(u._id),
    username: u.username,
    ratings: publicRatings(u.ratings),
    online: isOnline(String(u._id)),
    lastSeenAt: u.lastSeenAt ?? null,
    // the game they're playing right now, if their profile is public (so others can watch)
    playing: u.profilePublic === false ? null : (live?.activeFor(u._id).at(-1) ?? null),
  };
}

/** The final position of a game, for the little board in game lists. */
function finalFen(moves) {
  const c = new Chess();
  for (const uci of moves ?? []) {
    try {
      c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      break;
    }
  }
  return c.fen();
}

const SPEEDS = ['bullet', 'blitz', 'rapid', 'classical'];
const PAGE = 20;

const findByUsername = async (name) => {
  const u = await User.findOne({ usernameKey: String(name).toLowerCase() });
  if (!u || u.suspended) throw new HttpError(404, 'not_found', 'There’s no player with that username.');
  return u;
};

router.get(
  '/search',
  route(async (req, res) => {
    const q = String(req.query.q ?? '')
      .trim()
      .toLowerCase()
      .slice(0, 20);
    const filter = { usernameKey: q ? { $regex: `^${escapeRe(q)}` } : { $type: 'string' }, suspended: { $ne: true } };
    const users = await User.find(filter, { username: 1, ratings: 1, lastSeenAt: 1, profilePublic: 1 })
      .sort(q ? { usernameKey: 1 } : { lastSeenAt: -1 })
      .limit(30)
      .lean();
    res.json({ players: users.map(playerCard) });
  }),
);

/** People you follow and people who follow you. */
router.get(
  '/me/follows',
  route(async (req, res) => {
    const [following, followers] = await Promise.all([
      Follow.find({ follower: req.user._id }).populate('followee', 'username ratings lastSeenAt suspended profilePublic').lean(),
      Follow.find({ followee: req.user._id }).populate('follower', 'username ratings lastSeenAt suspended profilePublic').lean(),
    ]);
    const cards = (list, field) =>
      list
        .map((f) => f[field])
        .filter((u) => u && !u.suspended && u.username)
        .map(playerCard);
    res.json({ following: cards(following, 'followee'), followers: cards(followers, 'follower') });
  }),
);

router.get(
  '/:username',
  route(async (req, res) => {
    const u = await findByUsername(req.params.username);
    const self = String(u._id) === String(req.user._id);
    const visible = self || u.profilePublic !== false || req.user.role === 'admin';
    const [followers, following, iFollow, followsMe] = await Promise.all([
      Follow.countDocuments({ followee: u._id }),
      Follow.countDocuments({ follower: u._id }),
      Follow.exists({ follower: req.user._id, followee: u._id }),
      Follow.exists({ follower: u._id, followee: req.user._id }),
    ]);
    const profile = {
      ...playerCard(u),
      memberSince: u.createdAt,
      self,
      visible,
      followers,
      following,
      iFollow: !!iFollow,
      followsMe: !!followsMe,
    };
    if (visible) {
      const [matches, puzzleState, solved, attempts, mastered, liveCount] = await Promise.all([
        Match.find({ $or: [{ 'white.user': u._id }, { 'black.user': u._id }], status: 'finished' })
          .sort({ endedAt: -1 })
          .limit(20)
          .lean(),
        UserState.findOne({ userId: u._id, key: 'puzzles:rated' }, { json: 1 }).lean(),
        PuzzleAttempt.countDocuments({ userId: u._id, solved: true }),
        PuzzleAttempt.countDocuments({ userId: u._id }),
        LineProgress.countDocuments({ userId: u._id, stage: { $gte: 5 } }),
        Match.find({ $or: [{ 'white.user': u._id }, { 'black.user': u._id }], status: 'finished' }, { 'white.user': 1, result: 1 }).lean(),
      ]);
      let puzzleRating = null;
      try {
        puzzleRating = puzzleState ? Math.round(JSON.parse(puzzleState.json)?.rating ?? 0) || null : null;
      } catch {
        /* unreadable saved state */
      }
      const record = { win: 0, draw: 0, loss: 0 };
      for (const m of liveCount) {
        const color = String(m.white.user) === String(u._id) ? 'w' : 'b';
        const w = m.result?.winner ?? null;
        record[w == null ? 'draw' : w === color ? 'win' : 'loss'] += 1;
      }
      Object.assign(profile, {
        playingNow: live
          ? live
              .activeFor(u._id)
              .map((id) => live.summary(id))
              .filter(Boolean)
          : [],
        puzzleRating,
        puzzles: { solved, attempts },
        linesMastered: mastered,
        record,
        recent: matches.map((m) => {
          const s = matchSummary(m, u._id);
          delete s.moves;
          return s;
        }),
      });
    }
    res.json({ profile });
  }),
);

/**
 * A player's finished games, newest first, 20 a page: ?page=1&speed=blitz&result=win|loss|draw&rated=true|false
 * Only for public profiles (and your own).
 */
router.get(
  '/:username/games',
  route(async (req, res) => {
    const u = await findByUsername(req.params.username);
    const self = String(u._id) === String(req.user._id);
    if (!self && u.profilePublic === false && req.user.role !== 'admin') throw new HttpError(403, 'private', `${u.username} keeps their games private.`);
    const page = Math.max(1, Math.min(500, Number.parseInt(req.query.page, 10) || 1));
    const me = { $or: [{ 'white.user': u._id }, { 'black.user': u._id }] };
    const and = [me, { status: 'finished' }];
    if (SPEEDS.includes(req.query.speed)) and.push({ speed: req.query.speed });
    if (req.query.rated === 'true' || req.query.rated === 'false') and.push({ rated: req.query.rated === 'true' });
    const result = req.query.result;
    if (result === 'draw') and.push({ 'result.winner': null });
    else if (result === 'win')
      and.push({
        $or: [
          { 'white.user': u._id, 'result.winner': 'w' },
          { 'black.user': u._id, 'result.winner': 'b' },
        ],
      });
    else if (result === 'loss')
      and.push({
        $or: [
          { 'white.user': u._id, 'result.winner': 'b' },
          { 'black.user': u._id, 'result.winner': 'w' },
        ],
      });
    const filter = { $and: and };
    const [total, docs] = await Promise.all([
      Match.countDocuments(filter),
      Match.find(filter)
        .sort({ endedAt: -1, _id: -1 })
        .skip((page - 1) * PAGE)
        .limit(PAGE)
        .lean(),
    ]);
    const games = docs.map((m) => {
      const s = matchSummary(m, u._id);
      s.fen = finalFen(m.moves);
      s.white = { username: m.white.username, rating: m.white.rating };
      s.black = { username: m.black.username, rating: m.black.rating };
      delete s.moves;
      return s;
    });
    res.json({ games, total, page, pages: Math.max(1, Math.ceil(total / PAGE)) });
  }),
);

router.post(
  '/:username/follow',
  requireUsername,
  route(async (req, res) => {
    const u = await findByUsername(req.params.username);
    if (String(u._id) === String(req.user._id)) throw new HttpError(400, 'invalid', 'You can’t follow yourself.');
    await Follow.updateOne({ follower: req.user._id, followee: u._id }, { $setOnInsert: { follower: req.user._id, followee: u._id } }, { upsert: true });
    res.json({ ok: true, following: true });
  }),
);

router.delete(
  '/:username/follow',
  route(async (req, res) => {
    const u = await findByUsername(req.params.username);
    await Follow.deleteOne({ follower: req.user._id, followee: u._id });
    res.json({ ok: true, following: false });
  }),
);

export default router;

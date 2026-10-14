import { Router } from 'express';
import { optionalUser, requireUser } from '../middleware/auth.js';
import { HttpError, route } from '../middleware/http.js';
import { live } from '../live/socket.js';
import { Follow, User } from '../models/index.js';

/*
 * Games between players: games being played right now (to watch), the live state of one game, and
 * the games you're in right now. Games of players who keep their profile private aren't listed, but
 * anyone with a game's link can still open it.
 */
const router = Router();

router.get(
  '/active',
  requireUser,
  route(async (req, res) => res.json({ active: live.activeFor(req.user._id) })),
);

router.get(
  '/live',
  optionalUser,
  route(async (req, res) => {
    const games = live.liveSummaries().filter(Boolean);
    const ids = [...new Set(games.flatMap((g) => [g.white.id, g.black.id]))];
    const [hidden, follows] = await Promise.all([
      User.find({ _id: { $in: ids }, $or: [{ profilePublic: false }, { suspended: true }] }, { _id: 1 }).lean(),
      req.user ? Follow.find({ follower: req.user._id, followee: { $in: ids } }, { followee: 1 }).lean() : [],
    ]);
    const secret = new Set(hidden.map((u) => String(u._id)));
    const followed = new Set(follows.map((f) => String(f.followee)));
    const me = req.user ? String(req.user._id) : null;
    const list = games
      .filter((g) => !secret.has(g.white.id) && !secret.has(g.black.id))
      .map((g) => ({
        ...g,
        followed: followed.has(g.white.id) || followed.has(g.black.id),
        mine: g.white.id === me || g.black.id === me,
      }))
      .sort((a, b) => b.followed - a.followed || Math.max(b.white.rating, b.black.rating) - Math.max(a.white.rating, a.black.rating))
      .slice(0, 60);
    res.json({ games: list, total: list.length });
  }),
);

router.get(
  '/:id',
  optionalUser,
  route(async (req, res) => {
    if (!/^[a-f0-9]{24}$/.test(req.params.id)) throw new HttpError(404, 'not_found', 'No such game.');
    const state = await live.state(req.params.id);
    if (!state) throw new HttpError(404, 'not_found', 'No such game.');
    res.json({ match: state });
  }),
);

export default router;

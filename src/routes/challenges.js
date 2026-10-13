import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Challenge, User, publicRatings } from '../models/index.js';
import { optionalUser, requireUser, requireUsername } from '../middleware/auth.js';
import { HttpError, route, validate } from '../middleware/http.js';
import { live, notifyUser, isOnline } from '../live/socket.js';
import { speedOf, validClock } from '../lib/play.js';

/*
 * Challenges. Three kinds, one shape:
 *   to a player   – they get a notification and can accept or decline (expires in 30 minutes)
 *   open link     – anyone with the link can accept (expires in 24 hours)
 *   lobby seek    – an open challenge also listed in the lobby (15 minutes, or until you leave)
 */
const router = Router();
const LIFETIME = { direct: 30 * 60_000, link: 24 * 3600_000, lobby: 15 * 60_000 };
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => [...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]).join('');

const createLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'That’s a lot of challenges. Wait a few minutes.' },
});

const brief = (u, speed) => (u ? { id: String(u._id), username: u.username, rating: publicRatings(u.ratings)[speed], online: isOnline(String(u._id)) } : null);

function view(c, me) {
  const expired = c.status === 'open' && c.expiresAt < new Date();
  return {
    code: c.code,
    from: brief(c.from, c.speed),
    to: brief(c.to, c.speed),
    color: c.color,
    clock: c.clock,
    speed: c.speed,
    rated: c.rated,
    lobby: c.lobby,
    status: expired ? 'expired' : c.status,
    matchId: c.matchId ? String(c.matchId) : null,
    expiresAt: c.expiresAt,
    createdAt: c.createdAt,
    mine: me ? String(c.from?._id ?? c.from) === String(me._id) : false,
  };
}
const populated = (q) => q.populate('from', 'username ratings').populate('to', 'username ratings');

router.post(
  '/',
  requireUser,
  requireUsername,
  createLimiter,
  validate(
    z.object({
      to: z.string().trim().max(20).optional(),
      clock: z.object({ initial: z.number().int(), increment: z.number().int() }),
      color: z.enum(['w', 'b', 'random']).default('random'),
      rated: z.boolean().default(false),
      lobby: z.boolean().default(false),
    }),
  ),
  route(async (req, res) => {
    const { to, clock, color, rated, lobby } = req.body;
    if (!validClock(clock)) throw new HttpError(400, 'invalid', 'Pick a time control between 15 seconds and 3 hours, with 0–180 seconds a move.');
    let opponent = null;
    if (to) {
      opponent = await User.findOne({ usernameKey: to.toLowerCase() });
      if (!opponent || opponent.suspended) throw new HttpError(404, 'not_found', 'There’s no player with that username.');
      if (String(opponent._id) === String(req.user._id)) throw new HttpError(400, 'invalid', 'You can’t challenge yourself.');
    }
    // One lobby seek at a time: a new one replaces the old.
    if (lobby && !opponent) await Challenge.updateMany({ from: req.user._id, lobby: true, status: 'open' }, { $set: { status: 'canceled' } });
    const kind = opponent ? 'direct' : lobby ? 'lobby' : 'link';
    const c = await Challenge.create({
      code: newCode(),
      from: req.user._id,
      to: opponent?._id ?? null,
      color,
      clock,
      speed: speedOf(clock),
      rated,
      lobby: !opponent && lobby,
      expiresAt: new Date(Date.now() + LIFETIME[kind]),
    });
    const full = await populated(Challenge.findById(c._id));
    if (opponent) notifyUser(String(opponent._id), 'challenge:new', view(full, opponent));
    res.status(201).json({ challenge: view(full, req.user) });
  }),
);

/** Your incoming and outgoing challenges that are still open. */
router.get(
  '/',
  requireUser,
  route(async (req, res) => {
    const now = new Date();
    const [incoming, outgoing] = await Promise.all([
      populated(
        Challenge.find({ to: req.user._id, status: 'open', expiresAt: { $gt: now } })
          .sort({ createdAt: -1 })
          .limit(30),
      ),
      populated(
        Challenge.find({ from: req.user._id, status: 'open', expiresAt: { $gt: now } })
          .sort({ createdAt: -1 })
          .limit(30),
      ),
    ]);
    res.json({ incoming: incoming.map((c) => view(c, req.user)), outgoing: outgoing.map((c) => view(c, req.user)) });
  }),
);

/** Open lobby seeks from other players, best match for your rating first. */
router.get(
  '/lobby',
  requireUser,
  route(async (req, res) => {
    const seeks = await populated(
      Challenge.find({ lobby: true, status: 'open', expiresAt: { $gt: new Date() }, from: { $ne: req.user._id } })
        .sort({ createdAt: -1 })
        .limit(50),
    );
    res.json({ seeks: seeks.filter((c) => c.from && isOnline(String(c.from._id))).map((c) => view(c, req.user)) });
  }),
);

/** Anyone may look at a challenge link, signed in or not, to see what they're being invited to. */
router.get(
  '/:code',
  optionalUser,
  route(async (req, res) => {
    const c = await populated(Challenge.findOne({ code: String(req.params.code) }));
    if (!c) throw new HttpError(404, 'not_found', 'This challenge doesn’t exist.');
    res.json({ challenge: view(c, req.user) });
  }),
);

router.post(
  '/:code/accept',
  requireUser,
  requireUsername,
  route(async (req, res) => {
    const code = String(req.params.code);
    const c = await Challenge.findOne({ code });
    if (!c) throw new HttpError(404, 'not_found', 'This challenge doesn’t exist.');
    if (String(c.from) === String(req.user._id)) throw new HttpError(400, 'invalid', 'That’s your own challenge. Send the link to a friend.');
    if (c.to && String(c.to) !== String(req.user._id)) throw new HttpError(403, 'forbidden', 'This challenge was sent to someone else.');
    if (c.status === 'accepted' && c.matchId) throw new HttpError(409, 'taken', 'Someone already accepted this challenge.');
    if (c.status !== 'open' || c.expiresAt < new Date()) throw new HttpError(410, 'gone', 'This challenge is no longer open.');
    const challenger = await User.findById(c.from);
    if (!challenger || challenger.suspended) throw new HttpError(410, 'gone', 'This challenge is no longer open.');

    // Claim it atomically, so two people can't accept the same link.
    const claimed = await Challenge.findOneAndUpdate({ _id: c._id, status: 'open' }, { $set: { status: 'accepted' } }, { new: true });
    if (!claimed) throw new HttpError(409, 'taken', 'Someone already accepted this challenge.');

    const challengerWhite = c.color === 'w' || (c.color === 'random' && Math.random() < 0.5);
    const [white, black] = challengerWhite ? [challenger, req.user] : [req.user, challenger];
    const game = await live.create({ white, black, clock: c.clock, speed: c.speed, rated: c.rated, challenge: c._id });
    await Challenge.updateOne({ _id: c._id }, { $set: { matchId: game.id } });
    // Both players' other lobby seeks are done with.
    await Challenge.updateMany({ from: { $in: [challenger._id, req.user._id] }, lobby: true, status: 'open' }, { $set: { status: 'canceled' } });
    for (const u of [challenger, req.user]) notifyUser(String(u._id), 'match:start', { matchId: game.id, code });
    res.json({ matchId: game.id });
  }),
);

router.post(
  '/:code/decline',
  requireUser,
  route(async (req, res) => {
    const c = await Challenge.findOneAndUpdate({ code: String(req.params.code), to: req.user._id, status: 'open' }, { $set: { status: 'declined' } });
    if (c) notifyUser(String(c.from), 'challenge:update', { code: c.code, status: 'declined', by: req.user.username });
    res.json({ ok: true });
  }),
);

router.post(
  '/:code/cancel',
  requireUser,
  route(async (req, res) => {
    const c = await Challenge.findOneAndUpdate({ code: String(req.params.code), from: req.user._id, status: 'open' }, { $set: { status: 'canceled' } });
    if (c?.to) notifyUser(String(c.to), 'challenge:update', { code: c.code, status: 'canceled' });
    res.json({ ok: true });
  }),
);

export default router;

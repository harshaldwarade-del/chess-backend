import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User } from '../models/index.js';
import { clearSession, optionalUser, requireUser, setSession, suspendedError } from '../middleware/auth.js';
import { suggestUsername, usernameProblem } from '../lib/play.js';
import { HttpError, route, validate } from '../middleware/http.js';

const router = Router();
const ROUNDS = 12;
// Compared against when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', ROUNDS);

// 20 tries per 15 minutes per IP for anything that checks a password.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' },
});

const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
const password = z.string().min(8, 'Use at least 8 characters.').max(200, 'That password is too long.');

router.post(
  '/register',
  passwordLimiter,
  validate(z.object({ email, password, name: z.string().trim().max(60).optional().default(''), username: z.string().trim().max(20).optional() })),
  route(async (req, res) => {
    const { email: mail, password: pw, name, username } = req.body;
    if (username) {
      const problem = usernameProblem(username);
      if (problem) throw new HttpError(400, 'invalid', problem);
      if (await usernameTaken(username)) throw new HttpError(409, 'username_taken', 'That username is taken.');
    }
    if (await User.exists({ email: mail })) throw new HttpError(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
    let user;
    try {
      user = await User.create({
        email: mail,
        name,
        passwordHash: await bcrypt.hash(pw, ROUNDS),
        ...(username ? { username, usernameKey: usernameKey(username) } : {}),
      });
    } catch (e) {
      if (e?.code === 11000 && e.keyPattern?.usernameKey) throw new HttpError(409, 'username_taken', 'That username is taken.');
      if (e?.code === 11000) throw new HttpError(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
      throw e;
    }
    const token = setSession(res, user);
    res.status(201).json({ user: user.toPublic(), token });
  }),
);

router.post(
  '/login',
  passwordLimiter,
  validate(z.object({ email, password: z.string().max(200) })),
  route(async (req, res) => {
    const user = await User.findOne({ email: req.body.email });
    const ok = await bcrypt.compare(req.body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) throw new HttpError(401, 'bad_credentials', 'Email or password is incorrect.');
    if (user.suspended) throw suspendedError(user);
    const token = setSession(res, user);
    res.json({ user: user.toPublic(), token });
  }),
);

router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

/** Ends every session of this account, on all devices. */
router.post(
  '/logout-all',
  requireUser,
  route(async (req, res) => {
    req.user.tokenVersion += 1;
    await req.user.save();
    clearSession(res);
    res.json({ ok: true });
  }),
);

// Guests get { user: null } rather than a 401, so a signed-out visit doesn't log an error.
router.get('/me', optionalUser, (req, res) =>
  res.json({ user: req.user ? req.user.toPublic() : null, ...(req.user && !req.user.username ? { suggestedUsername: suggestUsername(req.user) } : {}) }),
);

const usernameKey = (name) => name.toLowerCase();
async function usernameTaken(name, exceptId) {
  const other = await User.findOne({ usernameKey: usernameKey(name) }, { _id: 1 }).lean();
  return !!other && String(other._id) !== String(exceptId);
}

/** Lets the app check a username as it's typed. */
router.get(
  '/username-available',
  requireUser,
  route(async (req, res) => {
    const name = String(req.query.name ?? '').trim();
    const problem = usernameProblem(name);
    if (problem) return res.json({ available: false, message: problem });
    const taken = await usernameTaken(name, req.user._id);
    res.json({ available: !taken, message: taken ? 'That username is taken.' : '' });
  }),
);

router.patch(
  '/me',
  requireUser,
  validate(z.object({ name: z.string().trim().max(60).optional(), username: z.string().trim().max(20).optional(), profilePublic: z.boolean().optional() })),
  route(async (req, res) => {
    const { name, username, profilePublic } = req.body;
    if (name !== undefined) req.user.name = name;
    if (profilePublic !== undefined) req.user.profilePublic = profilePublic;
    if (username !== undefined && username !== req.user.username) {
      // Picked once: profile links, follows and game records all point at it.
      if (req.user.username) throw new HttpError(409, 'username_locked', 'Your username is already set and can’t be changed.');
      const problem = usernameProblem(username);
      if (problem) throw new HttpError(400, 'invalid', problem);
      if (await usernameTaken(username, req.user._id)) throw new HttpError(409, 'username_taken', 'That username is taken.');
      req.user.username = username;
      req.user.usernameKey = usernameKey(username);
    }
    try {
      await req.user.save();
    } catch (e) {
      if (e?.code === 11000) throw new HttpError(409, 'username_taken', 'That username is taken.');
      throw e;
    }
    res.json({ user: req.user.toPublic() });
  }),
);

/** Changes the password; other devices are signed out, this one stays signed in. */
router.post(
  '/password',
  passwordLimiter,
  requireUser,
  validate(z.object({ current: z.string().max(200), next: password })),
  route(async (req, res) => {
    if (!(await bcrypt.compare(req.body.current, req.user.passwordHash))) throw new HttpError(401, 'bad_credentials', 'Your current password is incorrect.');
    req.user.passwordHash = await bcrypt.hash(req.body.next, ROUNDS);
    req.user.tokenVersion += 1;
    await req.user.save();
    const token = setSession(res, req.user);
    res.json({ ok: true, token });
  }),
);

export { passwordLimiter };
export default router;

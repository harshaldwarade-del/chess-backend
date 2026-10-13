import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { User } from '../models/index.js';
import { clearSession, optionalUser, requireUser, setSession } from '../middleware/auth.js';
import { HttpError, route, validate } from '../middleware/http.js';

const router = Router();
const ROUNDS = 12;
// Compared against when the email is unknown, so a wrong email takes as long as a wrong password.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', ROUNDS);

// 20 tries per 15 minutes per IP for anything that checks a password.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' },
});

const email = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);
const password = z.string().min(8, 'Use at least 8 characters.').max(200, 'That password is too long.');

router.post(
  '/register',
  passwordLimiter,
  validate(z.object({ email, password, name: z.string().trim().max(60).optional().default('') })),
  route(async (req, res) => {
    const { email: mail, password: pw, name } = req.body;
    if (await User.exists({ email: mail })) throw new HttpError(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
    let user;
    try {
      user = await User.create({ email: mail, name, passwordHash: await bcrypt.hash(pw, ROUNDS) });
    } catch (e) {
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
router.get('/me', optionalUser, (req, res) => res.json({ user: req.user ? req.user.toPublic() : null }));

router.patch(
  '/me',
  requireUser,
  validate(z.object({ name: z.string().trim().max(60) })),
  route(async (req, res) => {
    req.user.name = req.body.name;
    await req.user.save();
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

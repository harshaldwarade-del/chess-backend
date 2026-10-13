import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models/index.js';
import { HttpError } from './http.js';

export const COOKIE = 'rf_session';

function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.production || config.crossSite,
    sameSite: config.crossSite ? 'none' : 'lax',
    path: '/',
    maxAge: config.sessionDays * 24 * 3600 * 1000,
  };
}

/**
 * Signs the user in on this browser: a JWT in an httpOnly cookie (scripts can't read it).
 * The token is also returned, for browsers that refuse the cookie because the app and the API are
 * on different sites (Safari, or any browser blocking third-party cookies); the app then keeps it
 * and sends it as `Authorization: Bearer …`, but only after checking the cookie didn't work.
 */
export function setSession(res, user) {
  const token = jwt.sign({ sub: String(user._id), tv: user.tokenVersion }, config.jwtSecret, { expiresIn: `${config.sessionDays}d` });
  res.cookie(COOKIE, token, cookieOptions());
  return token;
}

export function clearSession(res) {
  const { maxAge, ...opts } = cookieOptions(); // eslint-disable-line no-unused-vars
  res.clearCookie(COOKIE, opts);
}

/** The account a session token belongs to, or null (bad, expired or revoked token). */
export async function userFromTokens(candidates) {
  for (const token of candidates.filter(Boolean)) {
    let payload;
    try {
      payload = jwt.verify(token, config.jwtSecret);
    } catch {
      continue;
    }
    const user = await User.findById(payload.sub);
    if (user && user.tokenVersion === payload.tv) return user;
  }
  return null;
}

async function userFromRequest(req) {
  const header = req.get('authorization');
  return userFromTokens([req.cookies?.[COOKIE], header?.startsWith('Bearer ') ? header.slice(7) : null]);
}

const suspendedError = (user) =>
  new HttpError(
    403,
    'suspended',
    `This account has been suspended${user.suspendedReason ? `: ${user.suspendedReason}` : '.'} Contact the site owner if you think this is a mistake.`,
  );

/** Attaches req.user when the request carries a valid session; never rejects. */
export async function optionalUser(req, res, next) {
  try {
    const user = await userFromRequest(req);
    req.user = user && !user.suspended ? user : null;
    next();
  } catch (e) {
    next(e);
  }
}

/** Rejects the request with 401 unless it carries a valid session. */
export async function requireUser(req, res, next) {
  try {
    const user = await userFromRequest(req);
    if (!user) throw new HttpError(401, 'signed_out', 'Please sign in again.');
    if (user.suspended) throw suspendedError(user);
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

/** Signed in and has picked a username: needed for anything other players can see. */
export function requireUsername(req, res, next) {
  if (!req.user?.username) return next(new HttpError(409, 'username_required', 'Pick a username first.'));
  next();
}

/** Admin pages and actions. Runs after requireUser. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return next(new HttpError(403, 'forbidden', 'Admins only.'));
  next();
}

export { suspendedError };

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

async function userFromRequest(req) {
  const header = req.get('authorization');
  const candidates = [req.cookies?.[COOKIE], header?.startsWith('Bearer ') ? header.slice(7) : null].filter(Boolean);
  for (const token of candidates) {
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

/** Attaches req.user when the request carries a valid session; never rejects. */
export async function optionalUser(req, res, next) {
  try {
    req.user = await userFromRequest(req);
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
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// A .env file next to package.json is read when present (local development). On a host such as
// Render, set the variables in its dashboard instead.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}
const env = process.env;
const production = env.NODE_ENV === 'production';

let jwtSecret = env.JWT_SECRET;
if (!jwtSecret || jwtSecret.length < 32) {
  if (production) throw new Error('Set JWT_SECRET to a random string of at least 32 characters (see .env.example).');
  jwtSecret = 'dev-only-secret-dev-only-secret-dev-only-secret';
  if (env.NODE_ENV !== 'test') console.warn('[config] JWT_SECRET not set: using a development secret. Never do this in production.');
}

export const config = {
  production,
  port: Number(env.PORT ?? 4000),
  mongoUri: env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/rankfile',
  jwtSecret,
  sessionDays: Number(env.SESSION_DAYS ?? 30),
  // Only needed when the React app is served from a different origin than this API.
  clientOrigins: (env.CLIENT_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
  // Behind a proxy (Render, Railway, Heroku, nginx) the client IP comes from X-Forwarded-For.
  trustProxy: env.TRUST_PROXY ?? (production ? '1' : 'loopback'),
  // The built React app; served by this server when the folder exists. STATIC_DIR=none: API only
  // (the app is hosted elsewhere, e.g. Hostinger).
  staticDir: env.STATIC_DIR === 'none' ? null : resolve(here, '..', env.STATIC_DIR ?? '../dist'),
};

/** Cookies must be SameSite=None (and Secure) when the app and the API are on different sites. */
config.crossSite = config.clientOrigins.length > 0;

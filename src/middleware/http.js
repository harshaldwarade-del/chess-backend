import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Parses req.body with a zod schema; a bad body becomes a 400 with a readable message. */
export const validate = (schema) => (req, res, next) => {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    return next(new HttpError(400, 'invalid', first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request.'));
  }
  req.body = r.data;
  next();
};

/**
 * State-changing requests must be JSON. Browsers can't send a cross-site JSON request without a
 * CORS preflight, which this server refuses for unknown origins: together with SameSite cookies,
 * that closes the door on cross-site request forgery.
 */
export function jsonOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.is('application/json')) return next();
  next(new HttpError(415, 'json_required', 'Send JSON (Content-Type: application/json).'));
}

/** Wraps an async route so rejected promises reach the error handler. */
export const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) err = new HttpError(400, 'invalid', err.issues[0]?.message ?? 'Invalid request.');
  if (err?.type === 'entity.too.large') err = new HttpError(413, 'too_large', 'That request is too large.');
  if (err?.type === 'entity.parse.failed') err = new HttpError(400, 'bad_json', 'That request is not valid JSON.');
  const status = err.status ?? 500;
  if (status >= 500) console.error('[server]', err);
  res.status(status).json({ error: err.code ?? 'server_error', message: status >= 500 ? 'Something went wrong on the server.' : err.message });
}

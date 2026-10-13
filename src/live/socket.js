import { Server } from 'socket.io';
import { config } from '../config.js';
import { COOKIE, userFromTokens } from '../middleware/auth.js';
import { Challenge, User } from '../models/index.js';
import { LiveGames } from './games.js';

/*
 * The real-time channel (Socket.IO). Each signed-in tab joins a personal room, `user:<id>`, for
 * challenges and game starts; anyone viewing a game joins `match:<id>` and gets its state after every
 * change. Guests may connect too, to watch games.
 */
export let live = null; // the LiveGames instance, once attached
let io = null;
const sockets = new Map(); // userId -> number of open connections

const cookieValue = (header, name) => {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

export const isOnline = (userId) => (sockets.get(String(userId)) ?? 0) > 0;
export const onlineCount = () => sockets.size;

/** Sends a personal event to every open tab of a player. */
export function notifyUser(userId, event, payload) {
  io?.to(`user:${userId}`).emit(event, payload);
}

/** Ends a player's open connections (used when an account is suspended). */
export function disconnectUser(userId) {
  io?.in(`user:${userId}`).disconnectSockets(true);
}

export async function attachSockets(httpServer) {
  io = new Server(httpServer, {
    path: '/socket.io',
    cors: config.clientOrigins.length ? { origin: config.clientOrigins, credentials: true } : undefined,
    serveClient: false,
    pingInterval: 20000,
    pingTimeout: 20000,
  });
  live = new LiveGames({
    broadcast: (id, state) => io.to(`match:${id}`).emit('match:state', state),
    notifyUser,
    isOnline,
  });
  const restored = await live.restore();
  if (restored) console.log(`[live] picked up ${restored} game(s) in progress`);

  io.use(async (socket, next) => {
    try {
      const user = await userFromTokens([cookieValue(socket.handshake.headers.cookie, COOKIE), socket.handshake.auth?.token]);
      socket.data.user = user && !user.suspended ? user : null;
      next();
    } catch (e) {
      next(e);
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    const uid = user ? String(user._id) : null;
    // A crude per-connection flood guard: 40 events in 10 seconds.
    let budget = 40;
    const refill = setInterval(() => (budget = 40), 10_000);
    const allowed = () => budget-- > 0;

    if (uid) {
      socket.join(`user:${uid}`);
      const before = sockets.get(uid) ?? 0;
      sockets.set(uid, before + 1);
      if (!before) live.presence(uid);
      User.updateOne({ _id: uid }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
      socket.emit('hello', { userId: uid, active: live.activeFor(uid) });
    } else socket.emit('hello', { userId: null, active: [] });

    const reply = (ack, result) => typeof ack === 'function' && ack(result);
    const act =
      (fn) =>
      async (payload = {}, ack) => {
        if (!allowed()) return reply(ack, { error: 'Slow down a little.' });
        if (!uid) return reply(ack, { error: 'Sign in to play.' });
        try {
          reply(ack, await fn(payload));
        } catch (e) {
          console.error('[live]', e);
          reply(ack, { error: 'Something went wrong.' });
        }
      };

    socket.on('match:watch', async ({ id } = {}, ack) => {
      if (!allowed() || typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) return reply(ack, { error: 'No such game.' });
      for (const room of socket.rooms) if (room.startsWith('match:')) socket.leave(room);
      const state = await live.state(id);
      if (!state) return reply(ack, { error: 'No such game.' });
      socket.join(`match:${id}`);
      reply(ack, { ok: true, state });
    });
    socket.on('match:unwatch', ({ id } = {}) => socket.leave(`match:${id}`));
    socket.on(
      'match:move',
      act(({ id, uci, ply }) => (typeof uci === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci) ? live.move(id, uid, uci, ply) : { error: 'Bad move.' })),
    );
    socket.on(
      'match:resign',
      act(({ id }) => live.resign(id, uid)),
    );
    socket.on(
      'match:abort',
      act(({ id }) => live.abort(id, uid)),
    );
    socket.on(
      'match:draw',
      act(({ id, action }) => live.draw(id, uid, action)),
    );
    socket.on(
      'match:takeback',
      act(({ id, action }) => live.takeback(id, uid, action)),
    );
    socket.on(
      'match:claim',
      act(({ id }) => live.claim(id, uid)),
    );
    socket.on(
      'match:rematch',
      act(({ id, action }) => live.rematch(id, uid, action)),
    );

    socket.on('disconnect', () => {
      clearInterval(refill);
      if (!uid) return;
      const left = (sockets.get(uid) ?? 1) - 1;
      if (left > 0) return sockets.set(uid, left);
      sockets.delete(uid);
      live.presence(uid);
      User.updateOne({ _id: uid }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
      // Lobby seeks only make sense while their creator is around to play.
      setTimeout(() => {
        if (!isOnline(uid)) Challenge.updateMany({ from: uid, lobby: true, status: 'open' }, { $set: { status: 'canceled' } }).catch(() => {});
      }, 15_000).unref?.();
    });
  });
  return io;
}

export function closeSockets() {
  live?.stop();
  io?.close();
}

// Players, challenges, live games over Socket.IO, ratings and the admin panel.
// Needs a MongoDB (MONGODB_URI, default mongodb://127.0.0.1:27017); each run uses a throwaway database.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import mongoose from 'mongoose';
import request from 'supertest';
import { io as connect } from 'socket.io-client';

process.env.NODE_ENV = 'test';
const { createApp } = await import('../src/app.js');
const liveSocket = await import('../src/live/socket.js');
const { attachSockets, closeSockets } = liveSocket;
const { ensureAdmin } = await import('../src/admin-bootstrap.js');
const { User } = await import('../src/models/index.js');
const { rate } = await import('../src/lib/glicko2.js');

const url = new URL(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017');
url.pathname = `/rankfile_play_${Date.now()}`;
let app;
let server;
let base;
const sockets = [];

before(async () => {
  await mongoose.connect(url.toString());
  await mongoose.connection.syncIndexes();
  app = createApp({ staticDir: null });
  server = createServer(app);
  await attachSockets(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  sockets.forEach((s) => s.close());
  closeSockets();
  server.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

/** Registers a player and returns { agent, token, user }. */
async function player(username, email = `${username}@example.com`) {
  const agent = request.agent(app);
  const r = await agent.post('/api/auth/register').send({ email, password: 'correct horse', ...(username ? { username } : {}) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { agent, token: r.body.token, user: r.body.user };
}

/** A Socket.IO connection that signs in with the bearer token, as the app does when cookies are blocked. */
function socketFor(p) {
  const s = connect(base, { auth: { token: p.token }, transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return new Promise((resolve) => s.once('hello', () => resolve(s)));
}
const emit = (s, event, payload) => new Promise((resolve) => s.emit(event, payload, resolve));
const nextState = (s, pred = () => true) =>
  new Promise((resolve) => {
    const on = (st) => pred(st) && (s.off('match:state', on), resolve(st));
    s.on('match:state', on);
  });

async function startGame(a, b, { rated = false, clock = { initial: 180, increment: 2 }, color = 'w' } = {}) {
  const c = await a.agent.post('/api/challenges').send({ clock, rated, color });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const acc = await b.agent.post(`/api/challenges/${c.body.challenge.code}/accept`).send({});
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  return acc.body.matchId;
}
async function play(sockets, id, moves) {
  for (let i = 0; i < moves.length; i += 1) {
    const r = await emit(sockets[i % 2], 'match:move', { id, uci: moves[i], ply: i });
    assert.equal(r.ok, true, `${moves[i]}: ${JSON.stringify(r)}`);
  }
}

describe('usernames and profiles', () => {
  test('pick once, case-insensitive uniqueness, reserved names', async () => {
    const p = await player(null, 'nameless@example.com');
    const me = await p.agent.get('/api/auth/me');
    assert.equal(me.body.user.username, null);
    assert.ok(me.body.suggestedUsername);
    assert.equal((await p.agent.post('/api/challenges').send({ clock: { initial: 60, increment: 0 } })).status, 409, 'no username, no challenges');

    await player('Magnus');
    assert.equal((await p.agent.get('/api/auth/username-available?name=magnus')).body.available, false);
    assert.equal((await p.agent.patch('/api/auth/me').send({ username: 'MAGNUS' })).status, 409);
    assert.equal((await p.agent.patch('/api/auth/me').send({ username: 'admin' })).status, 400);
    assert.equal((await p.agent.patch('/api/auth/me').send({ username: 'a b' })).status, 400);
    const ok = await p.agent.patch('/api/auth/me').send({ username: 'Nameless_1' });
    assert.equal(ok.body.user.username, 'Nameless_1');
    assert.equal((await p.agent.patch('/api/auth/me').send({ username: 'Other' })).status, 409, 'locked once set');
  });

  test('search, follow, and hidden profiles', async () => {
    const a = await player('alice');
    const b = await player('bob');
    const found = await a.agent.get('/api/users/search?q=bo');
    assert.ok(found.body.players.some((x) => x.username === 'bob'));
    assert.equal(found.body.players[0].email, undefined, 'never leaks emails');

    assert.equal((await a.agent.post('/api/users/bob/follow').send({})).status, 200);
    assert.equal((await a.agent.post('/api/users/BOB/follow').send({})).status, 200, 'idempotent');
    const prof = await a.agent.get('/api/users/bob');
    assert.equal(prof.body.profile.followers, 1);
    assert.equal(prof.body.profile.iFollow, true);
    assert.equal(prof.body.profile.visible, true);
    assert.ok('record' in prof.body.profile);
    assert.deepEqual((await a.agent.get('/api/users/me/follows')).body.following.map((x) => x.username), ['bob']);

    await b.agent.patch('/api/auth/me').send({ profilePublic: false });
    const hidden = await a.agent.get('/api/users/bob');
    assert.equal(hidden.body.profile.visible, false);
    assert.equal(hidden.body.profile.recent, undefined);
    assert.equal((await b.agent.get('/api/users/bob')).body.profile.visible, true, 'you always see your own');

    await a.agent.delete('/api/users/bob/follow').send({});
    assert.equal((await a.agent.get('/api/users/bob')).body.profile.followers, 0);
    assert.equal((await a.agent.get('/api/users/nobody-here')).status, 404);
  });
});

describe('challenges and live games', () => {
  test('glicko-2 matches the paper example direction and size', () => {
    const r = rate({ r: 1500, rd: 200, vol: 0.06 }, { r: 1400, rd: 30, vol: 0.06 }, 1);
    assert.ok(r.r > 1500 && r.r < 1600 && r.rd < 200);
    const l = rate({ r: 1500, rd: 200, vol: 0.06 }, { r: 1700, rd: 300, vol: 0.06 }, 0);
    assert.ok(l.r < 1500 && l.r > 1400);
  });

  test('a direct challenge notifies the opponent, who can decline', async () => {
    const a = await player('carol');
    const b = await player('dave');
    const sb = await socketFor(b);
    const got = new Promise((r) => sb.once('challenge:new', r));
    const c = await a.agent.post('/api/challenges').send({ to: 'Dave', clock: { initial: 300, increment: 3 }, rated: true });
    assert.equal(c.body.challenge.speed, 'blitz');
    const note = await got;
    assert.equal(note.from.username, 'carol');
    assert.equal((await b.agent.get('/api/challenges')).body.incoming.length, 1);
    const sa = await socketFor(a);
    const upd = new Promise((r) => sa.once('challenge:update', r));
    await b.agent.post(`/api/challenges/${c.body.challenge.code}/decline`).send({});
    assert.equal((await upd).status, 'declined');
    assert.equal((await b.agent.post(`/api/challenges/${c.body.challenge.code}/accept`).send({})).status, 410);
  });

  test('open link: one taker only, rated game ends in mate and moves ratings', async () => {
    const a = await player('erin');
    const b = await player('frank');
    const c = await player('gina');
    const link = await a.agent.post('/api/challenges').send({ clock: { initial: 60, increment: 0 }, rated: true, color: 'b' });
    const code = link.body.challenge.code;
    const peek = await request(app).get(`/api/challenges/${code}`);
    assert.equal(peek.body.challenge.from.username, 'erin', 'anyone can look at a link');
    assert.equal(peek.body.challenge.speed, 'bullet');
    assert.equal((await a.agent.post(`/api/challenges/${code}/accept`).send({})).status, 400, 'not your own');

    const [sa, sb] = await Promise.all([socketFor(a), socketFor(b)]);
    const started = new Promise((r) => sa.once('match:start', r));
    const acc = await b.agent.post(`/api/challenges/${code}/accept`).send({});
    assert.equal(acc.status, 200);
    assert.equal((await started).matchId, acc.body.matchId);
    assert.equal((await c.agent.post(`/api/challenges/${code}/accept`).send({})).status, 409, 'already taken');

    const id = acc.body.matchId;
    const w = await emit(sb, 'match:watch', { id });
    assert.equal(w.state.white.username, 'frank', 'challenger asked for black');
    await emit(sa, 'match:watch', { id });

    assert.match((await emit(sa, 'match:move', { id, uci: 'e7e5', ply: 0 })).error, /not your turn/);
    assert.match((await emit(sb, 'match:move', { id, uci: 'e2e5', ply: 0 })).error, /legal/);
    const end = nextState(sa, (s) => s.status === 'finished');
    await play([sb, sa], id, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
    const final = await end;
    assert.deepEqual(final.result, { winner: 'b', reason: 'checkmate' });
    assert.ok(final.black.diff > 0 && final.white.diff < 0);
    const erin = await User.findOne({ username: 'erin' });
    assert.ok(erin.ratings.bullet.r > 1500);
    assert.equal(erin.ratings.bullet.games, 1);
    const dash = await a.agent.get('/api/dashboard');
    assert.equal(dash.body.online.matches[0].outcome, 'win');
    const prof = await b.agent.get('/api/users/erin');
    assert.deepEqual(prof.body.profile.record, { win: 1, draw: 0, loss: 0 });
  });

  test('abort before both have moved, draw by agreement, resign, takeback and rematch', async () => {
    const a = await player('hank');
    const b = await player('iris');
    const [sa, sb] = await Promise.all([socketFor(a), socketFor(b)]);

    let id = await startGame(a, b);
    await Promise.all([emit(sa, 'match:watch', { id }), emit(sb, 'match:watch', { id })]);
    await emit(sa, 'match:move', { id, uci: 'e2e4', ply: 0 });
    assert.equal((await emit(sb, 'match:abort', { id })).ok, true);
    assert.equal((await liveSocket.live.state(id)).status, 'aborted');

    id = await startGame(a, b);
    await Promise.all([emit(sa, 'match:watch', { id }), emit(sb, 'match:watch', { id })]);
    await play([sa, sb], id, ['e2e4', 'e7e5']);
    assert.match((await emit(sa, 'match:abort', { id })).error, /Too late/);
    await emit(sa, 'match:draw', { id, action: 'offer' });
    assert.equal((await liveSocket.live.state(id)).offers.draw, 'w');
    await emit(sb, 'match:draw', { id, action: 'accept' });
    const drawn = await liveSocket.live.state(id);
    assert.deepEqual(drawn.result, { winner: null, reason: 'agreement' });

    // rematch: colours swap
    await emit(sa, 'match:rematch', { id });
    const r = await emit(sb, 'match:rematch', { id });
    assert.ok(r.matchId);
    const re = await liveSocket.live.state(r.matchId);
    assert.equal(re.white.username, 'iris');

    // casual takeback: white asks to undo its move, black accepts
    id = r.matchId;
    await Promise.all([emit(sa, 'match:watch', { id }), emit(sb, 'match:watch', { id })]);
    await play([sb, sa], id, ['d2d4', 'd7d5', 'c2c4']);
    await emit(sb, 'match:takeback', { id, action: 'request' });
    await emit(sa, 'match:takeback', { id, action: 'accept' });
    const tb = await liveSocket.live.state(id);
    assert.deepEqual(tb.moves, ['d2d4', 'd7d5']);
    assert.equal(tb.turn, 'w');
    assert.equal((await emit(sa, 'match:resign', { id })).ok, true);
    assert.deepEqual((await liveSocket.live.state(id)).result, { winner: 'w', reason: 'resign' });
  });

  test('flag: running out of time loses', async () => {
    const a = await player('jack');
    const b = await player('kate');
    const [sa, sb] = await Promise.all([socketFor(a), socketFor(b)]);
    const id = await startGame(a, b, { clock: { initial: 15, increment: 0 } });
    await Promise.all([emit(sa, 'match:watch', { id }), emit(sb, 'match:watch', { id })]);
    await play([sa, sb], id, ['e2e4', 'e7e5']);
    // White's clock is running now; pretend it's nearly empty, then move too late.
    const g = liveSocket.live.games.get(id);
    g.timeLeft.w = 100;
    g.turnStartedAt = Date.now();
    await new Promise((r) => setTimeout(r, 250));
    const late = await emit(sa, 'match:move', { id, uci: 'g1f3', ply: 2 });
    assert.match(late.error, /time ran out/);
    assert.deepEqual((await liveSocket.live.state(id)).result, { winner: 'b', reason: 'timeout' });
    assert.equal((await liveSocket.live.state(id)).clocks.w, 0);
  });

  test('watching as a guest; actions need an account', async () => {
    const a = await player('liam');
    const b = await player('mona');
    const id = await startGame(a, b);
    const guest = connect(base, { transports: ['websocket'], forceNew: true });
    sockets.push(guest);
    await new Promise((r) => guest.once('hello', r));
    assert.equal((await emit(guest, 'match:watch', { id })).ok, true);
    assert.match((await emit(guest, 'match:resign', { id })).error, /Sign in/);
    const st = await request(app).get(`/api/matches/${id}`);
    assert.equal(st.body.match.status, 'started');
  });
});

describe('admin', () => {
  test('bootstrap from the environment, admin-only API, suspend and unsuspend', async () => {
    await ensureAdmin({ ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'test-admin-pass-123' });
    await ensureAdmin({ ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'test-admin-pass-123' }); // second start: no change, no error
    const admin = request.agent(app);
    const login = await admin.post('/api/auth/login').send({ email: 'boss@example.com', password: 'test-admin-pass-123' });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, 'admin');

    const someone = await player('nina');
    assert.equal((await someone.agent.get('/api/admin/stats')).status, 403, 'players are kept out');

    const stats = await admin.get('/api/admin/stats');
    assert.ok(stats.body.users.total >= 2);
    const list = await admin.get('/api/admin/users?q=nina');
    assert.equal(list.body.users.length, 1);
    assert.equal(list.body.users[0].email, 'nina@example.com');
    const detail = await admin.get(`/api/admin/users/${list.body.users[0].id}`);
    assert.ok(detail.body.dashboard.puzzles);
    assert.equal(detail.body.user.username, 'nina');

    const sus = await admin.post(`/api/admin/users/${list.body.users[0].id}/suspend`).send({ reason: 'testing' });
    assert.equal(sus.body.user.suspended, true);
    assert.equal((await someone.agent.get('/api/dashboard')).status, 401, 'old session ended');
    const relog = await request(app).post('/api/auth/login').send({ email: 'nina@example.com', password: 'correct horse' });
    assert.equal(relog.status, 403);
    assert.match(relog.body.message, /testing/);
    assert.equal((await someone.agent.get('/api/users/search?q=nina')).status, 401);

    await admin.post(`/api/admin/users/${list.body.users[0].id}/unsuspend`).send({});
    assert.equal((await request(app).post('/api/auth/login').send({ email: 'nina@example.com', password: 'correct horse' })).status, 200);

    // an existing account is promoted without touching its password
    await player('owner', 'owner@example.com');
    await ensureAdmin({ ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'something-else' });
    const o = await request(app).post('/api/auth/login').send({ email: 'owner@example.com', password: 'correct horse' });
    assert.equal(o.body.user.role, 'admin');
    const matches = await admin.get('/api/admin/matches');
    assert.ok(Array.isArray(matches.body.live) && Array.isArray(matches.body.recent));
  });
});

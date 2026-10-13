// API tests. Needs a MongoDB to talk to: MONGODB_URI (default mongodb://127.0.0.1:27017).
// Each run uses a fresh, throwaway database.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';

process.env.NODE_ENV = 'test';
const { createApp } = await import('../src/app.js');
const { DrillSession, Game, LineProgress, PuzzleAttempt } = await import('../src/models/index.js');

const url = new URL(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017');
url.pathname = `/rankfile_test_${Date.now()}`;
let app;

before(async () => {
  await mongoose.connect(url.toString());
  await mongoose.connection.syncIndexes();
  app = createApp({ staticDir: null });
});
after(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

/** A signed-in "device": an agent that keeps the session cookie. */
async function device(email, password = 'correct horse', register = false) {
  const agent = request.agent(app);
  const r = await agent.post(`/api/auth/${register ? 'register' : 'login'}`).send({ email, password, ...(register ? { name: 'Tester' } : {}) });
  assert.equal(r.status, register ? 201 : 200, JSON.stringify(r.body));
  return agent;
}
const sync = (agent, body) => agent.post('/api/sync').send(body);
const itemOf = (res, key) => res.body.items.find((i) => i.key === key);

describe('accounts', () => {
  test('register, me, duplicate email, bad and good login', async () => {
    const a = await device('Ana@Example.com', 'correct horse', true);
    const me = await a.get('/api/auth/me');
    assert.equal(me.body.user.email, 'ana@example.com');
    assert.equal(me.body.user.passwordHash, undefined);

    const dup = await request(app).post('/api/auth/register').send({ email: 'ana@example.com', password: 'whatever123' });
    assert.equal(dup.status, 409);

    const bad = await request(app).post('/api/auth/login').send({ email: 'ana@example.com', password: 'wrong password' });
    assert.equal(bad.status, 401);
    const unknown = await request(app).post('/api/auth/login').send({ email: 'nobody@example.com', password: 'wrong password' });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.message, bad.body.message, 'same message for unknown email and wrong password');

    await device('ana@example.com');
  });

  test('validation, auth and content-type guards', async () => {
    const short = await request(app).post('/api/auth/register').send({ email: 'b@example.com', password: 'short' });
    assert.equal(short.status, 400);
    assert.match(short.body.message, /8 characters/);
    assert.equal((await request(app).post('/api/sync').send({})).status, 401);
    const form = await request(app).post('/api/auth/login').type('form').send('email=a&password=b');
    assert.equal(form.status, 415);
    const session = (await request(app).post('/api/auth/register').send({ email: 'cookie@example.com', password: 'correct horse' })).headers['set-cookie'][0];
    assert.match(session, /HttpOnly/);
    assert.match(session, /SameSite=Lax/);
  });

  test('sign out everywhere ends other sessions', async () => {
    const one = await device('multi@example.com', 'correct horse', true);
    const two = await device('multi@example.com');
    assert.equal((await one.post('/api/auth/logout-all').send({})).status, 200);
    assert.equal((await two.get('/api/auth/me')).body.user, null);
  });
});

describe('sync', () => {
  test('first upload, then a second device downloads everything', async () => {
    const phone = await device('sync@example.com', 'correct horse', true);
    const r = await sync(phone, {
      since: 0,
      items: [
        { key: 'settings', value: { board: 'walnut', pieceSet: 'merida' }, changedAt: 1000 },
        { key: 'puzzles:rated', value: { rating: 1350, games: 20 }, changedAt: 1000 },
        { key: 'learn:progress', value: { L1: { stage: 2, due: 5000, lapses: 0, runs: 2, last: 1000 } }, changedAt: 1000 },
        { key: 'tab', value: 'learn', changedAt: 1000 }, // device-only: ignored
        { key: 'bad key!', value: 1, changedAt: 1000 }, // invalid: ignored
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.serverTime, 'number');
    assert.equal(itemOf(r, 'tab'), undefined);

    const laptop = await device('sync@example.com');
    const pull = await sync(laptop, { since: 0 });
    assert.deepEqual(itemOf(pull, 'settings').value, { board: 'walnut', pieceSet: 'merida' });
    assert.equal(itemOf(pull, 'puzzles:rated').value.rating, 1350);
    assert.equal(itemOf(pull, 'learn:progress').value.L1.stage, 2);
    assert.equal(itemOf(pull, 'tab'), undefined);
    assert.equal(itemOf(pull, 'bad key!'), undefined);
  });

  test('merges never lose progress', async () => {
    const a = await device('merge@example.com', 'correct horse', true);
    const b = await device('merge@example.com');
    await sync(a, {
      items: [
        { key: 'settings', value: { board: 'marine' }, changedAt: 2000 },
        { key: 'puzzles:rated', value: { rating: 1400, games: 30 }, changedAt: 2000 },
        { key: 'puzzles:seen', value: ['p1', 'p2'], changedAt: 2000 },
        { key: 'rush:best', value: 21, changedAt: 2000 },
        { key: 'play:record', value: { 4: { w: 3, d: 1, l: 2 } }, changedAt: 2000 },
        {
          key: 'learn:progress',
          value: { A: { stage: 3, due: 9, lapses: 0, runs: 3, last: 3000 }, B: { stage: 1, due: 9, lapses: 1, runs: 1, last: 1000 } },
          changedAt: 3000,
        },
      ],
    });
    // device B: an older preference, fewer puzzle games, other seen puzzles, a lower best, other levels, newer line B
    const r = await sync(b, {
      items: [
        { key: 'settings', value: { board: 'coral' }, changedAt: 1500 },
        { key: 'puzzles:rated', value: { rating: 1600, games: 5 }, changedAt: 9000 },
        { key: 'puzzles:seen', value: ['p2', 'p3'], changedAt: 9000 },
        { key: 'rush:best', value: 17, changedAt: 9000 },
        { key: 'play:record', value: { 4: { w: 1, d: 2, l: 0 }, 6: { w: 0, d: 0, l: 1 } }, changedAt: 9000 },
        {
          key: 'learn:progress',
          value: { A: { stage: 1, due: 9, lapses: 0, runs: 1, last: 2000 }, B: { stage: 2, due: 9, lapses: 1, runs: 2, last: 4000 } },
          changedAt: 4000,
        },
      ],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(itemOf(r, 'settings').value, { board: 'marine' }, 'newer preference wins');
    assert.deepEqual(itemOf(r, 'puzzles:rated').value, { rating: 1400, games: 30 }, 'the copy with more games wins');
    assert.deepEqual(itemOf(r, 'puzzles:seen').value, ['p1', 'p2', 'p3']);
    assert.equal(itemOf(r, 'rush:best').value, 21);
    assert.deepEqual(itemOf(r, 'play:record').value, { 4: { w: 3, d: 2, l: 2 }, 6: { w: 0, d: 0, l: 1 } });
    const lines = itemOf(r, 'learn:progress').value;
    assert.equal(lines.A.stage, 3, 'line A: device A reviewed it later');
    assert.equal(lines.B.stage, 2, 'line B: device B reviewed it later');
    assert.equal(await LineProgress.countDocuments({ lineKey: { $in: ['A', 'B'] } }), 2);
  });

  test('incremental pulls return only recent changes', async () => {
    const a = await device('inc@example.com', 'correct horse', true);
    const first = await sync(a, { items: [{ key: 'memory:cfg', value: { pieces: 6 }, changedAt: 1 }] });
    const quiet = await sync(a, { since: first.body.serverTime + 10 * 60 * 1000 });
    assert.equal(quiet.body.items.length, 0, 'nothing changed after `since`');
    const again = await sync(a, { since: first.body.serverTime });
    assert.ok(itemOf(again, 'memory:cfg'), 'recent writes are re-sent inside the overlap window');
  });

  test('history events are stored once, invalid ones rejected', async () => {
    const a = await device('events@example.com', 'correct horse', true);
    const events = [
      {
        id: 'evt-puzzle-0001',
        type: 'puzzle',
        at: 1700000000000,
        data: { mode: 'rated', puzzleId: '00sHx', puzzleRating: 1500, themes: ['fork'], solved: true, ratingBefore: 1200, ratingAfter: 1216 },
      },
      {
        id: 'evt-game-00001',
        type: 'game',
        at: 1700000000000,
        data: {
          startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
          moves: ['e2e4', 'e7e5'],
          color: 'w',
          level: 4,
          timeControl: '5+0',
          result: { winner: 'b', reason: 'resignation' },
        },
      },
      { id: 'evt-sess-00001', type: 'session', at: 1700000000000, data: { mode: 'coords', variant: 'find:w:30', score: 24, details: { mistakes: 2 } } },
      { id: 'evt-bad-000001', type: 'game', at: 1, data: { moves: ['zz'] } },
      { id: 'evt-unknown-01', type: 'nope', at: 1, data: {} },
    ];
    const r1 = await sync(a, { events });
    assert.deepEqual(r1.body.events.rejected.sort(), ['evt-bad-000001', 'evt-unknown-01']);
    assert.equal(r1.body.events.accepted.length, 3);
    const r2 = await sync(a, { events: events.slice(0, 3) }); // retried after a dropped connection
    assert.equal(r2.status, 200);
    assert.equal(r2.body.events.accepted.length, 3);
    assert.equal(await PuzzleAttempt.countDocuments({ clientId: 'evt-puzzle-0001' }), 1);
    assert.equal(await Game.countDocuments({ clientId: 'evt-game-00001' }), 1);
    assert.equal(await DrillSession.countDocuments({ clientId: 'evt-sess-00001' }), 1);

    const sum = await a.get('/api/account/summary');
    assert.equal(sum.body.puzzles.byMode.rated.attempts, 1);
    assert.equal(sum.body.games.lost, 1);
  });
});

describe('account data', () => {
  test('export, then delete with password', async () => {
    const a = await device('bye@example.com', 'correct horse', true);
    await sync(a, {
      items: [
        { key: 'settings', value: { board: 'slate' }, changedAt: 5 },
        { key: 'learn:progress', value: { Z: { stage: 1, due: 1, lapses: 0, runs: 1, last: 5 } }, changedAt: 5 },
      ],
    });
    const ex = await a.get('/api/account/export');
    assert.deepEqual(ex.body.saved.settings, { board: 'slate' });
    assert.equal(ex.body.openingProgress.length, 1);

    assert.equal((await a.delete('/api/account').send({ password: 'nope nope' })).status, 401);
    assert.equal((await a.delete('/api/account').send({ password: 'correct horse' })).status, 200);
    assert.equal((await a.get('/api/auth/me')).body.user, null);
    assert.equal((await request(app).post('/api/auth/login').send({ email: 'bye@example.com', password: 'correct horse' })).status, 401);
  });
});

describe('dashboard', () => {
  test('history comes back compact, reviews attach to their game', async () => {
    const a = await device('dash@example.com', 'correct horse', true);
    const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    await sync(a, {
      items: [{ key: 'learn:progress', value: { 'vienna-abc': { stage: 5, due: 9, lapses: 2, runs: 7, last: 1700000000000 } }, changedAt: 1 }],
      events: [
        // the review is listed first on purpose: the server must store the game before attaching it
        {
          id: 'dash-review-01',
          type: 'review',
          at: 1700000005000,
          data: { gameId: 'dash-game-0001', accuracy: 81.5, opponentAccuracy: 90, counts: { brilliant: 1, blunder: 2 }, depth: 12 },
        },
        {
          id: 'dash-game-0001',
          type: 'game',
          at: 1700000000000,
          data: {
            startFen: fen,
            moves: ['e2e4', 'c7c5'],
            color: 'w',
            level: 3,
            timeControl: '10+0',
            result: { winner: 'w', reason: 'checkmate' },
            opening: 'B20 Sicilian Defense',
          },
        },
        {
          id: 'dash-puz-00001',
          type: 'puzzle',
          at: 1700000001000,
          data: { mode: 'rated', puzzleId: 'aaaaa', puzzleRating: 1400, themes: ['fork', 'short'], solved: true, ratingAfter: 1210 },
        },
        {
          id: 'dash-puz-00002',
          type: 'puzzle',
          at: 1700000002000,
          data: { mode: 'rush', puzzleId: 'bbbbb', puzzleRating: 900, themes: ['fork'], solved: false },
        },
        { id: 'dash-sess-0001', type: 'session', at: 1700000003000, data: { mode: 'coords', variant: 'find:w:30', score: 20, details: { misses: 1 } } },
      ],
    });
    const d = (await a.get('/api/dashboard')).body;
    assert.deepEqual(d.puzzles.themes, ['fork', 'short']);
    assert.deepEqual(d.puzzles.rows[0], [1700000001000, 0, 1, 1400, 1210, [0, 1]]);
    assert.deepEqual(d.puzzles.rows[1].slice(1, 3), [2, 0]);
    assert.equal(d.games.length, 1);
    assert.equal(d.games[0].review.accuracy, 81.5);
    assert.equal(d.games[0].review.counts.brilliant, 1);
    assert.deepEqual(d.drills[0].slice(1, 4), ['coords', 'find:w:30', 20]);
    assert.deepEqual(d.lines[0].slice(0, 2), ['vienna-abc', 5]);
  });
});

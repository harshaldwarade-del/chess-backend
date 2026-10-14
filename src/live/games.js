import { Chess } from 'chess.js';
import { Match, User, publicRatings } from '../models/index.js';
import { rate } from '../lib/glicko2.js';

/*
 * Live games between two players. The server is the referee: it checks every move with chess.js,
 * runs both clocks, and decides how the game ends. Clients only send intentions ("play e2e4",
 * "resign", "offer a draw") and draw whatever state comes back.
 *
 * Active games live in memory (one server instance) and are written to MongoDB after every change,
 * so a restart picks them up again: time spent while the server was down is given back.
 *
 * Clocks start after each side's first move, as on lichess. Until then, each player has
 * FIRST_MOVE_MS to make that first move, or the game is aborted (no rating change).
 */
export const FIRST_MOVE_MS = 30_000;
export const CLAIM_AFTER_MS = 60_000; // opponent gone this long: you may claim the win
const KEEP_FINISHED_MS = 15 * 60_000; // finished games stay in memory this long, for rematch offers

const other = (c) => (c === 'w' ? 'b' : 'w');
const uciOf = (m) => m.from + m.to + (m.promotion ?? '');

/** Can `color` still mate with what's left? (Used when the other side runs out of time.) */
function canMate(chess, color) {
  const pieces = chess
    .board()
    .flat()
    .filter((p) => p && p.color === color && p.type !== 'k');
  if (!pieces.length) return false;
  if (pieces.length === 1 && (pieces[0].type === 'n' || pieces[0].type === 'b')) return false;
  return true;
}

function drawReason(chess) {
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isInsufficientMaterial()) return 'insufficient';
  if (chess.isThreefoldRepetition()) return 'repetition';
  return 'fiftyMoves';
}

export class LiveGames {
  /**
   * @param {object} hooks
   *   broadcast(matchId, state): send the new state to everyone watching the game
   *   notifyUser(userId, event, payload): send a personal event (e.g. a rematch started)
   *   isOnline(userId): whether the player has the app open
   *   viewers(matchId): user ids (null for guests) of everyone with the game open, players included
   */
  constructor({ broadcast = () => {}, notifyUser = () => {}, isOnline = () => false, viewers = () => [] } = {}) {
    this.broadcast = broadcast;
    this.notifyUser = notifyUser;
    this.isOnline = isOnline;
    this.viewers = viewers;
    this.games = new Map();
  }

  /* ---------- setup ---------- */

  /** Picks up games that were running when the server last stopped. */
  async restore() {
    const docs = await Match.find({ status: 'started' }).lean();
    for (const doc of docs) {
      const g = this.#load(doc);
      // Time while the server was down doesn't count against anyone.
      if (g.turnStartedAt) g.turnStartedAt = Date.now();
      if (g.firstMoveDeadline) g.firstMoveDeadline = Date.now() + FIRST_MOVE_MS;
      this.#schedule(g);
    }
    return docs.length;
  }

  #load(doc) {
    const chess = new Chess();
    for (const uci of doc.moves ?? []) chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    const started = (doc.moves?.length ?? 0) >= 2;
    const g = {
      id: String(doc._id),
      doc,
      chess,
      timeLeft: { w: doc.timeLeft?.w ?? doc.clock.initial * 1000, b: doc.timeLeft?.b ?? doc.clock.initial * 1000 },
      turnStartedAt: started && doc.status === 'started' ? (doc.turnStartedAt ? new Date(doc.turnStartedAt).getTime() : Date.now()) : null,
      firstMoveDeadline: !started && doc.status === 'started' ? Date.now() + FIRST_MOVE_MS : null,
      offers: { draw: null, takeback: null, rematch: null },
      rematchId: null,
      gone: { w: null, b: null },
      timer: null,
      queue: Promise.resolve(),
    };
    this.games.set(g.id, g);
    return g;
  }

  /**
   * Starts a new game. white/black are User documents (or plain objects with _id, username, ratings).
   */
  async create({ white, black, clock, speed, rated, challenge = null, rematchOf = null }) {
    const player = (u) => {
      const r = u.ratings?.[speed] ?? {};
      return { user: u._id, username: u.username, rating: Math.round(r.r ?? 1500), provisional: (r.rd ?? 350) > 110, diff: null };
    };
    const doc = await Match.create({
      white: player(white),
      black: player(black),
      clock,
      speed,
      rated,
      challenge,
      rematchOf,
      timeLeft: { w: clock.initial * 1000, b: clock.initial * 1000 },
    });
    const g = this.#load(doc.toObject());
    this.#schedule(g);
    this.#push(g);
    return g;
  }

  /* ---------- reading ---------- */

  /** What clients see. For a finished game no longer in memory, built from the stored document. */
  async state(id) {
    const g = this.games.get(String(id));
    if (g) return this.#snapshot(g);
    const doc = await Match.findById(id)
      .lean()
      .catch(() => null);
    if (!doc) return null;
    return this.#snapshot(this.#load(doc), true);
  }

  #snapshot(g, transient = false) {
    const now = Date.now();
    const turn = g.chess.turn();
    const running = g.doc.status === 'started' && g.turnStartedAt ? turn : null;
    const clocks = { ...g.timeLeft };
    if (running) clocks[running] = Math.max(0, clocks[running] - (now - g.turnStartedAt));
    const side = (c) => {
      const p = c === 'w' ? g.doc.white : g.doc.black;
      return {
        id: String(p.user),
        username: p.username,
        rating: p.rating,
        provisional: !!p.provisional,
        diff: p.diff ?? null,
        online: this.isOnline(String(p.user)),
        goneSince: g.gone[c],
      };
    };
    const s = {
      id: g.id,
      white: side('w'),
      black: side('b'),
      clock: g.doc.clock,
      speed: g.doc.speed,
      rated: g.doc.rated,
      status: g.doc.status,
      moves: [...(g.doc.moves ?? [])],
      moveClocks: [...(g.doc.clocks ?? [])],
      clocks,
      running,
      turn,
      serverNow: now,
      firstMoveDeadline: g.firstMoveDeadline,
      result: g.doc.result ?? { winner: null, reason: null },
      offers: { ...g.offers },
      rematchId: g.rematchId,
      claimAfter: CLAIM_AFTER_MS,
      createdAt: g.doc.createdAt,
      endedAt: g.doc.endedAt ?? null,
      watchers: this.watcherCount(g.id, g.doc),
    };
    if (transient) this.games.delete(g.id);
    return s;
  }

  /** How many people other than the two players are watching (each signed-in person once; guests each). */
  watcherCount(id, doc = this.games.get(String(id))?.doc) {
    if (!doc) return 0;
    const players = new Set([String(doc.white.user), String(doc.black.user)]);
    const seen = new Set();
    let guests = 0;
    for (const uid of this.viewers(String(id))) {
      if (uid == null) guests += 1;
      else if (!players.has(uid)) seen.add(uid);
    }
    return seen.size + guests;
  }

  /** A short card for lists of games being played now: players, clock, position and watchers. */
  summary(id) {
    const g = this.games.get(String(id));
    if (!g || g.doc.status !== 'started') return null;
    const s = this.#snapshot(g);
    return {
      id: s.id,
      white: { id: s.white.id, username: s.white.username, rating: s.white.rating, provisional: s.white.provisional },
      black: { id: s.black.id, username: s.black.username, rating: s.black.rating, provisional: s.black.provisional },
      clock: s.clock,
      speed: s.speed,
      rated: s.rated,
      plies: s.moves.length,
      lastMove: s.moves.at(-1) ?? null,
      fen: g.chess.fen(),
      turn: s.turn,
      clocks: s.clocks,
      running: s.running,
      serverNow: s.serverNow,
      createdAt: s.createdAt,
      watchers: s.watchers,
    };
  }

  /** Games `userId` is playing right now. */
  activeFor(userId) {
    const id = String(userId);
    return [...this.games.values()]
      .filter((g) => g.doc.status === 'started' && (String(g.doc.white.user) === id || String(g.doc.black.user) === id))
      .map((g) => g.id);
  }

  allActive() {
    return [...this.games.values()].filter((g) => g.doc.status === 'started').map((g) => this.#snapshot(g));
  }

  /** Cards for every game being played right now. */
  liveSummaries() {
    return [...this.games.values()].filter((g) => g.doc.status === 'started').map((g) => this.summary(g.id));
  }

  /* ---------- actions (each runs in order, one at a time per game) ---------- */

  #run(id, userId, fn) {
    const g = this.games.get(String(id));
    if (!g) return Promise.resolve({ error: 'This game is over or doesn’t exist.' });
    const color = String(g.doc.white.user) === String(userId) ? 'w' : String(g.doc.black.user) === String(userId) ? 'b' : null;
    const job = g.queue.then(async () => {
      if (!color && userId !== '__admin__') return { error: 'You’re not playing in this game.' };
      return fn(g, color);
    });
    g.queue = job.catch(() => {});
    return job;
  }

  move(id, userId, uci, ply) {
    return this.#run(id, userId, async (g, color) => {
      if (g.doc.status !== 'started') return { error: 'The game is over.' };
      if (g.chess.turn() !== color) return { error: 'It’s not your turn.' };
      if (ply !== undefined && ply !== g.doc.moves.length) return { error: 'stale', stale: true };
      const now = Date.now();
      const clocksRunning = !!g.turnStartedAt;
      if (clocksRunning) {
        const left = g.timeLeft[color] - (now - g.turnStartedAt);
        if (left <= 0) {
          await this.#flag(g);
          return { error: 'Your time ran out.' };
        }
        g.timeLeft[color] = left + g.doc.clock.increment * 1000;
      }
      let m;
      try {
        m = g.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      } catch {
        return { error: 'That move isn’t legal.' };
      }
      g.doc.moves.push(uciOf(m));
      g.doc.clocks.push(Math.round(g.timeLeft[color]));
      const plies = g.doc.moves.length;
      if (plies >= 2) {
        g.turnStartedAt = now; // from Black's first reply on, the clocks run
        g.firstMoveDeadline = null;
      } else {
        g.firstMoveDeadline = now + FIRST_MOVE_MS; // Black's turn to make a first move
      }
      g.offers.takeback = null;
      if (g.offers.draw && g.offers.draw !== color) g.offers.draw = null; // moving declines a pending offer

      if (g.chess.isCheckmate()) return this.#finish(g, color, 'checkmate');
      if (g.chess.isGameOver()) return this.#finish(g, null, drawReason(g.chess));
      await Match.updateOne(
        { _id: g.id },
        {
          $push: { moves: g.doc.moves.at(-1), clocks: g.doc.clocks.at(-1) },
          $set: { timeLeft: g.timeLeft, turnStartedAt: g.turnStartedAt ? new Date(g.turnStartedAt) : null },
        },
      );
      this.#schedule(g);
      this.#push(g);
      return { ok: true };
    });
  }

  resign(id, userId) {
    return this.#run(id, userId, async (g, color) => {
      if (g.doc.status !== 'started') return { error: 'The game is over.' };
      if (g.doc.moves.length < 2) return this.#abort(g, 'aborted');
      return this.#finish(g, other(color), 'resign');
    });
  }

  abort(id, userId) {
    return this.#run(id, userId, async (g) => {
      if (g.doc.status !== 'started') return { error: 'The game is over.' };
      if (g.doc.moves.length >= 2) return { error: 'Too late to abort: both sides have moved. You can resign instead.' };
      return this.#abort(g, 'aborted');
    });
  }

  /** Admin: end a stuck game with no result and no rating change. */
  adminAbort(id) {
    return this.#run(id, '__admin__', async (g) => {
      if (g.doc.status !== 'started') return { error: 'The game is over.' };
      return this.#abort(g, 'adminAbort');
    });
  }

  /** offer | accept | decline. Offering when the opponent already offered means accepting. */
  draw(id, userId, action = 'offer') {
    return this.#run(id, userId, async (g, color) => {
      if (g.doc.status !== 'started') return { error: 'The game is over.' };
      if (g.doc.moves.length < 2) return { error: 'Play a move first.' };
      const theirs = g.offers.draw === other(color);
      if (action === 'decline') {
        if (theirs) g.offers.draw = null;
      } else if (theirs || action === 'accept') {
        if (!theirs) return { error: 'There’s no draw offer to accept.' };
        return this.#finish(g, null, 'agreement');
      } else g.offers.draw = color;
      this.#push(g);
      return { ok: true };
    });
  }

  /** Takebacks are for casual games only. request | accept | decline. */
  takeback(id, userId, action = 'request') {
    return this.#run(id, userId, async (g, color) => {
      if (g.doc.status !== 'started') return { error: 'The game is over.' };
      if (g.doc.rated) return { error: 'Takebacks are only allowed in casual games.' };
      const theirs = g.offers.takeback === other(color);
      if (action === 'decline') {
        if (theirs) g.offers.takeback = null;
        this.#push(g);
        return { ok: true };
      }
      if (action === 'accept' || theirs) {
        if (!theirs) return { error: 'There’s no takeback request.' };
        const requester = other(color);
        // Undo the requester's last move (and the reply to it, if there was one).
        const lastMover = g.doc.moves.length % 2 === 1 ? 'w' : 'b';
        const undo = lastMover === requester ? 1 : 2;
        if (g.doc.moves.length < undo) return { error: 'Nothing to take back.' };
        g.doc.moves.splice(-undo);
        g.doc.clocks.splice(-undo);
        g.chess = new Chess();
        for (const u of g.doc.moves) g.chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        g.offers.takeback = null;
        g.offers.draw = null;
        if (g.doc.moves.length < 2) {
          g.turnStartedAt = null;
          g.firstMoveDeadline = Date.now() + FIRST_MOVE_MS;
        } else g.turnStartedAt = Date.now();
        await Match.updateOne(
          { _id: g.id },
          { $set: { moves: g.doc.moves, clocks: g.doc.clocks, timeLeft: g.timeLeft, turnStartedAt: g.turnStartedAt ? new Date(g.turnStartedAt) : null } },
        );
        this.#schedule(g);
        this.#push(g);
        return { ok: true };
      }
      const mine = g.doc.moves.length >= 2 || (g.doc.moves.length === 1 && color === 'w');
      if (!mine) return { error: 'You haven’t made a move yet.' };
      g.offers.takeback = color;
      this.#push(g);
      return { ok: true };
    });
  }

  /** The opponent has been gone for a while: end the game in your favour. */
  claim(id, userId) {
    return this.#run(id, userId, async (g, color) => {
      if (g.doc.status !== 'started') return { error: 'The game is over.' };
      const them = other(color);
      if (this.isOnline(String(them === 'w' ? g.doc.white.user : g.doc.black.user))) return { error: 'Your opponent is back.' };
      if (!g.gone[them] || Date.now() - g.gone[them] < CLAIM_AFTER_MS) return { error: 'Give your opponent a little longer to come back.' };
      if (g.doc.moves.length < 2) return this.#abort(g, 'aborted');
      return this.#finish(g, color, 'abandoned');
    });
  }

  /** After the game: offer a rematch (colours swap). When both have offered, it starts. */
  rematch(id, userId, action = 'offer') {
    return this.#run(id, userId, async (g, color) => {
      if (g.doc.status === 'started') return { error: 'Finish this game first.' };
      if (g.rematchId) return { ok: true, matchId: g.rematchId };
      if (action === 'decline') {
        if (g.offers.rematch === other(color)) g.offers.rematch = null;
        this.#push(g);
        return { ok: true };
      }
      if (g.offers.rematch === other(color)) {
        const [w, b] = await Promise.all([User.findById(g.doc.black.user), User.findById(g.doc.white.user)]);
        if (!w || !b || w.suspended || b.suspended) return { error: 'A rematch isn’t possible.' };
        const next = await this.create({ white: w, black: b, clock: g.doc.clock, speed: g.doc.speed, rated: g.doc.rated, rematchOf: g.id });
        g.rematchId = next.id;
        g.offers.rematch = null;
        this.#push(g);
        for (const u of [w, b]) this.notifyUser(String(u._id), 'match:start', { matchId: next.id });
        return { ok: true, matchId: next.id };
      }
      g.offers.rematch = color;
      this.#push(g);
      return { ok: true };
    });
  }

  /* ---------- presence ---------- */

  /** Called when a player's last tab closes (online=false) or one opens again (online=true). */
  presence(userId) {
    const id = String(userId);
    const online = this.isOnline(id);
    for (const g of this.games.values()) {
      const color = String(g.doc.white.user) === id ? 'w' : String(g.doc.black.user) === id ? 'b' : null;
      if (!color) continue;
      if (g.doc.status === 'started') g.gone[color] = online ? null : Date.now();
      else if (!online && g.offers.rematch === color) g.offers.rematch = null;
      this.#push(g);
    }
  }

  /* ---------- internals ---------- */

  #push(g) {
    this.broadcast(g.id, this.#snapshot(g));
  }

  /** One timer per game: the flag of the side to move, or the first-move deadline. */
  #schedule(g) {
    clearTimeout(g.timer);
    g.timer = null;
    if (g.doc.status !== 'started') return;
    let due;
    let fire;
    if (g.firstMoveDeadline) {
      due = g.firstMoveDeadline - Date.now();
      fire = () =>
        this.#run(g.id, '__admin__', async (gg) =>
          gg.doc.status === 'started' && gg.firstMoveDeadline && Date.now() >= gg.firstMoveDeadline - 5 ? this.#abort(gg, 'noStart') : this.#schedule(gg),
        );
    } else if (g.turnStartedAt) {
      due = g.timeLeft[g.chess.turn()] - (Date.now() - g.turnStartedAt);
      fire = () => this.#run(g.id, '__admin__', async (gg) => this.#flag(gg));
    } else return;
    g.timer = setTimeout(fire, Math.max(0, due) + 20);
    g.timer.unref?.();
  }

  async #flag(g) {
    if (g.doc.status !== 'started' || !g.turnStartedAt) return;
    const turn = g.chess.turn();
    const left = g.timeLeft[turn] - (Date.now() - g.turnStartedAt);
    if (left > 0) return this.#schedule(g);
    g.timeLeft[turn] = 0;
    if (!canMate(g.chess, other(turn))) return this.#finish(g, null, 'timeoutVsInsufficient');
    return this.#finish(g, other(turn), 'timeout');
  }

  async #abort(g, reason) {
    clearTimeout(g.timer);
    g.doc.status = 'aborted';
    g.doc.result = { winner: null, reason };
    g.doc.endedAt = new Date();
    g.turnStartedAt = null;
    g.firstMoveDeadline = null;
    g.offers = { draw: null, takeback: null, rematch: null };
    await Match.updateOne({ _id: g.id }, { $set: { status: 'aborted', result: g.doc.result, endedAt: g.doc.endedAt, turnStartedAt: null } });
    this.#push(g);
    this.#forgetLater(g);
    return { ok: true };
  }

  async #finish(g, winner, reason) {
    clearTimeout(g.timer);
    const now = Date.now();
    if (g.turnStartedAt) {
      const t = g.chess.turn();
      g.timeLeft[t] = Math.max(0, g.timeLeft[t] - (now - g.turnStartedAt));
    }
    g.turnStartedAt = null;
    g.firstMoveDeadline = null;
    g.offers = { draw: null, takeback: null, rematch: null };
    g.doc.status = 'finished';
    g.doc.result = { winner, reason };
    g.doc.endedAt = new Date(now);

    if (g.doc.rated) await this.#rateGame(g, winner);

    await Match.updateOne(
      { _id: g.id },
      {
        $set: {
          status: 'finished',
          result: g.doc.result,
          endedAt: g.doc.endedAt,
          moves: g.doc.moves,
          clocks: g.doc.clocks,
          timeLeft: g.timeLeft,
          turnStartedAt: null,
          'white.diff': g.doc.white.diff ?? null,
          'black.diff': g.doc.black.diff ?? null,
        },
      },
    );
    this.#push(g);
    this.#forgetLater(g);
    return { ok: true };
  }

  async #rateGame(g, winner) {
    const speed = g.doc.speed;
    const [w, b] = await Promise.all([User.findById(g.doc.white.user), User.findById(g.doc.black.user)]);
    if (!w || !b) return;
    const rw = { r: 1500, rd: 350, vol: 0.06, games: 0, ...(w.ratings?.[speed]?.toObject?.() ?? w.ratings?.[speed] ?? {}) };
    const rb = { r: 1500, rd: 350, vol: 0.06, games: 0, ...(b.ratings?.[speed]?.toObject?.() ?? b.ratings?.[speed] ?? {}) };
    const score = winner === 'w' ? 1 : winner === 'b' ? 0 : 0.5;
    const nw = rate(rw, rb, score);
    const nb = rate(rb, rw, 1 - score);
    g.doc.white.diff = Math.round(nw.r) - Math.round(rw.r);
    g.doc.black.diff = Math.round(nb.r) - Math.round(rb.r);
    await Promise.all([
      User.updateOne({ _id: w._id }, { $set: { [`ratings.${speed}`]: { ...nw, games: (rw.games ?? 0) + 1 } } }),
      User.updateOne({ _id: b._id }, { $set: { [`ratings.${speed}`]: { ...nb, games: (rb.games ?? 0) + 1 } } }),
    ]);
    const after = await User.find({ _id: { $in: [w._id, b._id] } });
    for (const u of after) this.notifyUser(String(u._id), 'me:ratings', { ratings: publicRatings(u.ratings) });
  }

  #forgetLater(g) {
    const t = setTimeout(() => {
      if (this.games.get(g.id) === g && g.doc.status !== 'started') this.games.delete(g.id);
    }, KEEP_FINISHED_MS);
    t.unref?.();
  }

  /** For tests and shutdown. */
  stop() {
    for (const g of this.games.values()) clearTimeout(g.timer);
  }
}

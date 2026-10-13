import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { isSyncedKey, mergeValue } from '../../../shared/sync-rules.js';
import { DrillSession, Game, LineProgress, PuzzleAttempt, UserState } from '../models/index.js';
import { requireUser } from '../middleware/auth.js';
import { HttpError, route, validate } from '../middleware/http.js';

/*
 * POST /api/sync: one round trip that both uploads and downloads.
 *   in:  { since, items: [{ key, value, changedAt }], events: [{ id, type, at, data }] }
 *   out: { serverTime, items: [...merged values to apply], events: { accepted, rejected } }
 *
 * `items` are the device's changed saved values; the server merges each with its own copy
 * (shared/sync-rules.js) and returns the result, plus whatever other devices changed since `since`.
 * `events` are history records (puzzle attempts, games, drill sessions), stored once each.
 */

const router = Router();
const MAX_VALUE_BYTES = 300 * 1024;
const OVERLAP_MS = 2 * 60 * 1000; // re-send recent changes so writes racing a pull are never missed

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Syncing too often; slow down.' },
});

const ms = z.number().finite().nonnegative().max(1e14);
const Body = z.object({
  since: ms.optional().default(0),
  items: z
    .array(z.object({ key: z.string().max(120), value: z.unknown(), changedAt: ms }))
    .max(300)
    .optional()
    .default([]),
  events: z
    .array(z.object({ id: z.string().min(8).max(64), type: z.string().max(20), at: ms, data: z.record(z.unknown()) }))
    .max(500)
    .optional()
    .default([]),
});

// ---------- history events ----------
const num = z.number().finite();
const EVENT = {
  puzzle: {
    model: PuzzleAttempt,
    schema: z.object({
      mode: z.enum(['rated', 'blind', 'rush']),
      puzzleId: z.string().min(1).max(40),
      puzzleRating: num.optional(),
      themes: z.array(z.string().max(40)).max(20).optional(),
      solved: z.boolean(),
      ms: num.nonnegative().max(1e8).optional(),
      hints: z.number().int().min(0).max(10).optional(),
      ratingBefore: num.optional(),
      ratingAfter: num.optional(),
    }),
  },
  game: {
    model: Game,
    schema: z.object({
      startFen: z.string().min(10).max(100),
      moves: z.array(z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/)).max(1000),
      color: z.enum(['w', 'b']),
      level: z.number().int().min(1).max(8),
      timeControl: z.string().max(20).optional(),
      result: z.object({ winner: z.enum(['w', 'b']).nullable(), reason: z.string().max(60) }),
      opening: z.string().max(200).nullable().optional(),
      takebacks: z.number().int().min(0).max(1000).optional(),
      hints: z.number().int().min(0).max(1000).optional(),
    }),
    time: 'playedAt',
  },
  // The result of a game review, attached to the game it belongs to (sent after that game).
  review: {
    schema: z.object({
      gameId: z.string().min(8).max(64),
      accuracy: num.min(0).max(100).nullable(),
      opponentAccuracy: num.min(0).max(100).nullable().optional(),
      counts: z.record(z.number().int().min(0).max(1000)).refine((d) => Object.keys(d).length <= 12, 'too many kinds'),
      depth: z.number().int().min(1).max(40).optional(),
    }),
    apply: async (userId, docs) => {
      for (const { gameId, clientId: _c, userId: _u, ...review } of docs) {
        // eslint-disable-line no-unused-vars
        await Game.updateOne({ userId, clientId: gameId }, { $set: { review } });
      }
    },
  },
  session: {
    model: DrillSession,
    schema: z.object({
      mode: z.enum(['coords', 'memory', 'rush', 'explorer']),
      variant: z.string().max(80).optional(),
      score: num,
      details: z
        .record(z.union([z.string().max(200), num, z.boolean(), z.null()]))
        .refine((d) => Object.keys(d).length <= 20, 'too many details')
        .optional(),
    }),
  },
};

async function storeEvents(userId, events) {
  const accepted = [];
  const rejected = [];
  const groups = new Map();
  for (const e of events) {
    const kind = EVENT[e.type];
    const parsed = kind?.schema.safeParse(e.data);
    if (!parsed?.success) {
      rejected.push(e.id);
      continue;
    }
    const doc = { ...parsed.data, userId, clientId: e.id, [kind.time ?? 'at']: new Date(e.at) };
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(doc);
    accepted.push(e.id);
  }
  // records first, then updates that refer to them (a review after its game)
  for (const [kind, docs] of [...groups].sort(([a], [b]) => Number(!!a.apply) - Number(!!b.apply))) {
    if (kind.apply) {
      await kind.apply(userId, docs);
      continue;
    }
    try {
      await kind.model.insertMany(docs, { ordered: false });
    } catch (err) {
      // Already stored by an earlier, interrupted sync: that's the point of clientId.
      const errors = err?.writeErrors ?? (err?.code === 11000 ? [err] : null);
      if (!errors || !errors.every((w) => (w.code ?? w.err?.code) === 11000)) throw err;
    }
  }
  return { accepted, rejected };
}

// ---------- saved values ----------
/** Merges one value into the stored copy (optimistic concurrency: retried if another sync wrote first). */
async function mergeKey(userId, key, incoming, now) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await UserState.findOne({ userId, key }).lean();
    const existing = doc ? { value: JSON.parse(doc.json), changedAt: doc.changedAt } : undefined;
    const merged = mergeValue(key, existing, incoming);
    const json = JSON.stringify(merged.value);
    if (doc && doc.json === json && doc.changedAt === merged.changedAt) return merged;
    if (doc) {
      const r = await UserState.updateOne(
        { _id: doc._id, json: doc.json, changedAt: doc.changedAt },
        { $set: { json, changedAt: merged.changedAt, syncedAt: now } },
      );
      if (r.matchedCount) return merged;
    } else {
      try {
        await UserState.create({ userId, key, json, changedAt: merged.changedAt, syncedAt: now });
        return merged;
      } catch (e) {
        if (e?.code !== 11000) throw e;
      }
    }
  }
  throw new HttpError(409, 'busy', 'Another device is syncing; try again.');
}

const LineEntry = z.object({
  stage: z.number().int().min(0).max(50),
  due: ms,
  lapses: z.number().int().min(0).max(1e6).optional().default(0),
  runs: z.number().int().min(0).max(1e6).optional().default(0),
  last: ms,
});
const lineToClient = (d) => ({ stage: d.stage, due: d.due ? d.due.getTime() : 0, lapses: d.lapses, runs: d.runs, last: d.last.getTime() });
const linesItem = (docs) => ({
  key: 'learn:progress',
  value: Object.fromEntries(docs.map((d) => [d.lineKey, lineToClient(d)])),
  changedAt: docs.reduce((m, d) => Math.max(m, d.last.getTime()), 0),
});

/** Opening progress is stored per line; for each line, the more recent review wins. */
async function mergeLinesIn(userId, map, now) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  const entries = [];
  for (const [lineKey, raw] of Object.entries(map).slice(0, 5000)) {
    const p = LineEntry.safeParse(raw);
    if (p.success && lineKey.length <= 80) entries.push([lineKey, p.data]);
  }
  if (!entries.length) return;
  const current = await LineProgress.find({ userId, lineKey: { $in: entries.map(([k]) => k) } }, { lineKey: 1, last: 1 }).lean();
  const lastOf = new Map(current.map((d) => [d.lineKey, d.last.getTime()]));
  const ops = [];
  for (const [lineKey, e] of entries) {
    const had = lastOf.get(lineKey);
    if (had !== undefined && e.last <= had) continue;
    const $set = { stage: e.stage, due: new Date(e.due), lapses: e.lapses, runs: e.runs, last: new Date(e.last), syncedAt: now };
    ops.push(
      had === undefined
        ? { updateOne: { filter: { userId, lineKey }, update: { $set }, upsert: true } }
        : // only if still older than ours, in case another device wrote in between
          { updateOne: { filter: { userId, lineKey, last: { $lt: new Date(e.last) } }, update: { $set } } },
    );
  }
  if (!ops.length) return;
  try {
    await LineProgress.bulkWrite(ops, { ordered: false });
  } catch (err) {
    const errors = err?.writeErrors ?? [];
    if (!errors.length || !errors.every((w) => (w.code ?? w.err?.code) === 11000)) throw err;
  }
}

router.post(
  '/',
  limiter,
  requireUser,
  validate(Body),
  route(async (req, res) => {
    const userId = req.user._id;
    const now = new Date();
    const out = new Map(); // key -> item to send back

    // 1. merge what the device changed
    let pushedLines = false;
    for (const it of req.body.items) {
      if (!isSyncedKey(it.key) || it.value === undefined) continue;
      if (Buffer.byteLength(JSON.stringify(it.value)) > MAX_VALUE_BYTES) continue;
      if (it.key === 'learn:progress') {
        await mergeLinesIn(userId, it.value, now);
        pushedLines = true;
      } else {
        const merged = await mergeKey(userId, it.key, { value: it.value, changedAt: it.changedAt }, now);
        out.set(it.key, { key: it.key, ...merged });
      }
    }

    // 2. history records
    const events = await storeEvents(userId, req.body.events);

    // 3. everything that changed since the device last synced (with a little overlap)
    const since = req.body.since > 0 ? new Date(req.body.since - OVERLAP_MS) : null;
    const changed = await UserState.find(since ? { userId, syncedAt: { $gt: since } } : { userId }).lean();
    for (const d of changed) if (!out.has(d.key)) out.set(d.key, { key: d.key, value: JSON.parse(d.json), changedAt: d.changedAt });
    // all lines after an upload (so the device sees where the server's copy won), otherwise the changed ones
    const lines = await LineProgress.find(pushedLines || !since ? { userId } : { userId, syncedAt: { $gt: since } }).lean();
    if (lines.length) out.set('learn:progress', linesItem(lines));

    await req.user.updateOne({ lastSyncAt: now });
    res.json({ serverTime: now.getTime(), items: [...out.values()], events });
  }),
);

export default router;

import mongoose from 'mongoose';

const { Schema, model } = mongoose;
const userRef = { type: Schema.Types.ObjectId, ref: 'User', required: true };

/* ---------- accounts ---------- */
// Glicko-2 rating for one speed of online play (bullet, blitz, rapid, classical).
const RatingSchema = new Schema(
  { r: { type: Number, default: 1500 }, rd: { type: Number, default: 350 }, vol: { type: Number, default: 0.06 }, games: { type: Number, default: 0 } },
  { _id: false },
);
const ratingField = { type: RatingSchema, default: () => ({}) };

const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    name: { type: String, trim: true, maxlength: 60, default: '' },
    // Public handle for profiles, follows and challenges. Picked once by the player.
    username: { type: String, trim: true, maxlength: 20, default: undefined },
    usernameKey: { type: String, lowercase: true, default: undefined }, // for case-insensitive uniqueness
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    suspended: { type: Boolean, default: false },
    suspendedReason: { type: String, maxlength: 300, default: '' },
    profilePublic: { type: Boolean, default: true },
    ratings: {
      bullet: ratingField,
      blitz: ratingField,
      rapid: ratingField,
      classical: ratingField,
    },
    // Bumped on "sign out everywhere" and password changes; older sessions stop working.
    tokenVersion: { type: Number, default: 0 },
    lastSyncAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true },
);
UserSchema.index({ usernameKey: 1 }, { unique: true, sparse: true }); // accounts without a username don't take part
UserSchema.methods.toPublic = function toPublic() {
  return {
    id: String(this._id),
    email: this.email,
    name: this.name,
    username: this.username ?? null,
    role: this.role ?? 'user',
    profilePublic: this.profilePublic !== false,
    ratings: publicRatings(this.ratings),
    createdAt: this.createdAt,
  };
};
/** Ratings as the app shows them: rounded, with "?" (provisional) while the deviation is still high. */
export function publicRatings(ratings = {}) {
  const out = {};
  for (const speed of ['bullet', 'blitz', 'rapid', 'classical']) {
    const x = ratings?.[speed] ?? {};
    out[speed] = { rating: Math.round(x.r ?? 1500), rd: Math.round(x.rd ?? 350), games: x.games ?? 0, provisional: (x.rd ?? 350) > 110 };
  }
  return out;
}
export const User = model('User', UserSchema);

/* ---------- synced app state (one document per saved key) ----------
 * Settings, puzzle rating, records, personal bests, preferences. The value is kept as a JSON string,
 * so any shape the app saves round-trips exactly. */
const UserStateSchema = new Schema({
  userId: userRef,
  key: { type: String, required: true, maxlength: 120 },
  json: { type: String, required: true },
  changedAt: { type: Number, default: 0 }, // device time of the last real change (ms)
  syncedAt: { type: Date, required: true }, // server time of the last write, for "what changed since"
});
UserStateSchema.index({ userId: 1, key: 1 }, { unique: true });
UserStateSchema.index({ userId: 1, syncedAt: 1 });
export const UserState = model('UserState', UserStateSchema);

/* ---------- opening progress, one document per line and side ----------
 * Kept apart from the rest so the server can answer "which lines are due" with one indexed query. */
const LineProgressSchema = new Schema({
  userId: userRef,
  lineKey: { type: String, required: true, maxlength: 80 }, // line id, plus "~w"/"~b" when trained from the other side
  stage: { type: Number, default: 0 },
  due: { type: Date, default: null },
  lapses: { type: Number, default: 0 },
  runs: { type: Number, default: 0 },
  last: { type: Date, required: true },
  syncedAt: { type: Date, required: true },
});
LineProgressSchema.index({ userId: 1, lineKey: 1 }, { unique: true });
LineProgressSchema.index({ userId: 1, due: 1 });
LineProgressSchema.index({ userId: 1, syncedAt: 1 });
export const LineProgress = model('LineProgress', LineProgressSchema);

/* ---------- history: append-only records, each sent once (clientId makes retries harmless) ---------- */
const PuzzleAttemptSchema = new Schema({
  userId: userRef,
  clientId: { type: String, required: true },
  mode: { type: String, enum: ['rated', 'blind', 'rush'], required: true },
  puzzleId: { type: String, required: true },
  puzzleRating: Number,
  themes: [String],
  solved: { type: Boolean, required: true },
  ms: Number,
  hints: Number,
  ratingBefore: Number,
  ratingAfter: Number,
  at: { type: Date, required: true },
});
PuzzleAttemptSchema.index({ userId: 1, clientId: 1 }, { unique: true });
PuzzleAttemptSchema.index({ userId: 1, at: -1 });
PuzzleAttemptSchema.index({ userId: 1, themes: 1 });
export const PuzzleAttempt = model('PuzzleAttempt', PuzzleAttemptSchema);

const GameSchema = new Schema({
  userId: userRef,
  clientId: { type: String, required: true },
  source: { type: String, enum: ['stockfish'], default: 'stockfish' },
  startFen: { type: String, required: true },
  moves: [String], // UCI, e.g. "e2e4"
  color: { type: String, enum: ['w', 'b'], required: true },
  level: Number,
  timeControl: String,
  result: { winner: { type: String, enum: ['w', 'b', null], default: null }, reason: String },
  opening: String,
  takebacks: Number,
  hints: Number,
  playedAt: { type: Date, required: true },
  // Filled in by a later step: the stored game review (evals, labels, accuracy).
  review: { type: Schema.Types.Mixed, default: null },
});
GameSchema.index({ userId: 1, clientId: 1 }, { unique: true });
GameSchema.index({ userId: 1, playedAt: -1 });
export const Game = model('Game', GameSchema);

const DrillSessionSchema = new Schema({
  userId: userRef,
  clientId: { type: String, required: true },
  mode: { type: String, enum: ['coords', 'memory', 'rush', 'explorer'], required: true },
  variant: { type: String, maxlength: 80 },
  score: Number,
  details: { type: Schema.Types.Mixed, default: {} },
  at: { type: Date, required: true },
});
DrillSessionSchema.index({ userId: 1, clientId: 1 }, { unique: true });
DrillSessionSchema.index({ userId: 1, mode: 1, at: -1 });
export const DrillSession = model('DrillSession', DrillSessionSchema);

/* ---------- people: follows ---------- */
const FollowSchema = new Schema({ follower: userRef, followee: userRef }, { timestamps: { createdAt: true, updatedAt: false } });
FollowSchema.index({ follower: 1, followee: 1 }, { unique: true });
FollowSchema.index({ followee: 1 });
export const Follow = model('Follow', FollowSchema);

/* ---------- online play ---------- */
const ClockSchema = new Schema({ initial: { type: Number, required: true }, increment: { type: Number, required: true } }, { _id: false }); // seconds

/**
 * A challenge: sent to one player, or open to anyone who has the link. Open challenges can also be
 * listed in the lobby for quick pairing.
 */
const ChallengeSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    from: userRef,
    to: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    color: { type: String, enum: ['w', 'b', 'random'], default: 'random' },
    clock: { type: ClockSchema, required: true },
    speed: { type: String, required: true },
    rated: { type: Boolean, default: false },
    lobby: { type: Boolean, default: false },
    status: { type: String, enum: ['open', 'accepted', 'declined', 'canceled', 'expired'], default: 'open' },
    matchId: { type: Schema.Types.ObjectId, ref: 'Match', default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
ChallengeSchema.index({ to: 1, status: 1 });
ChallengeSchema.index({ from: 1, status: 1 });
ChallengeSchema.index({ lobby: 1, status: 1, expiresAt: 1 });
export const Challenge = model('Challenge', ChallengeSchema);

const PlayerSchema = new Schema(
  {
    user: userRef,
    username: String, // as it was when the game was played
    rating: Number, // before the game
    provisional: Boolean,
    diff: { type: Number, default: null }, // rating change, rated games only
  },
  { _id: false },
);

/** A game between two players, live or finished. Moves are UCI; clocks are in milliseconds. */
const MatchSchema = new Schema(
  {
    white: { type: PlayerSchema, required: true },
    black: { type: PlayerSchema, required: true },
    clock: { type: ClockSchema, required: true },
    speed: { type: String, required: true },
    rated: { type: Boolean, default: false },
    status: { type: String, enum: ['started', 'finished', 'aborted'], default: 'started' },
    moves: { type: [String], default: [] },
    clocks: { type: [Number], default: [] }, // time left for the mover after each move (ms)
    // live clock state, so a restarted server can pick the game up again
    timeLeft: { w: Number, b: Number },
    turnStartedAt: { type: Date, default: null },
    result: { winner: { type: String, enum: ['w', 'b', null], default: null }, reason: { type: String, default: null } },
    opening: { type: String, default: null },
    challenge: { type: Schema.Types.ObjectId, ref: 'Challenge', default: null },
    rematchOf: { type: Schema.Types.ObjectId, ref: 'Match', default: null },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
MatchSchema.index({ 'white.user': 1, createdAt: -1 });
MatchSchema.index({ 'black.user': 1, createdAt: -1 });
MatchSchema.index({ status: 1 });
export const Match = model('Match', MatchSchema);

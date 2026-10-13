import mongoose from 'mongoose';

const { Schema, model } = mongoose;
const userRef = { type: Schema.Types.ObjectId, ref: 'User', required: true };

/* ---------- accounts ---------- */
const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    name: { type: String, trim: true, maxlength: 60, default: '' },
    passwordHash: { type: String, required: true },
    // Bumped on "sign out everywhere" and password changes; older sessions stop working.
    tokenVersion: { type: Number, default: 0 },
    lastSyncAt: { type: Date, default: null },
  },
  { timestamps: true },
);
UserSchema.methods.toPublic = function toPublic() {
  return { id: String(this._id), email: this.email, name: this.name, createdAt: this.createdAt };
};
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

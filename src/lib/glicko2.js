/*
 * Glicko-2 (Mark Glickman, http://www.glicko.net/glicko/glicko2.pdf), applied one game at a time,
 * the way lichess does. A rating is { r, rd, vol }: r ≈ strength, rd = how sure we are (350 for a
 * new player, falling as games are played), vol = how erratic results have been.
 */
const SCALE = 173.7178;
const TAU = 0.75; // how fast volatility may change
const MIN_RD = 45;
const MAX_RD = 350;

const g = (phi) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu, muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * New rating for `player` after one game against `opponent`.
 * score: 1 win, 0.5 draw, 0 loss. Both ratings are the values from before the game.
 */
export function rate(player, opponent, score) {
  const mu = (player.r - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;
  const muJ = (opponent.r - 1500) / SCALE;
  const phiJ = opponent.rd / SCALE;

  const gJ = g(phiJ);
  const e = E(mu, muJ, phiJ);
  const v = 1 / (gJ * gJ * e * (1 - e));
  const delta = v * gJ * (score - e);

  // new volatility (Illinois algorithm, step 5 of the paper)
  const a = Math.log(sigma * sigma);
  const f = (x) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * TAU) < 0) k += 1;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i += 1) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const newSigma = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = mu + newPhi * newPhi * gJ * (score - e);

  return {
    r: Math.max(400, Math.min(3500, newMu * SCALE + 1500)),
    rd: Math.max(MIN_RD, Math.min(MAX_RD, newPhi * SCALE)),
    vol: Math.min(newSigma, 0.1),
  };
}

/**
 * Rating deviation grows while a player is away (one Glicko-2 rating period per `periodDays` idle),
 * so a returning player's rating moves faster again.
 */
export function decayRd(rating, lastPlayed, now = Date.now(), periodDays = 7) {
  if (!lastPlayed) return rating;
  const periods = Math.floor((now - new Date(lastPlayed).getTime()) / (periodDays * 864e5));
  if (periods <= 0) return rating;
  const phi = rating.rd / SCALE;
  const grown = Math.sqrt(phi * phi + periods * rating.vol * rating.vol) * SCALE;
  return { ...rating, rd: Math.min(MAX_RD, grown) };
}

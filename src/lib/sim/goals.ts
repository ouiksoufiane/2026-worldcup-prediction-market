/**
 * Goal-sampling model: independent Poisson with λ derived from ELO difference + home bonus.
 *
 *   λ_A = clamp( BASE + ALPHA · (ELO_A − ELO_B + home_bonus_A) / 100,  MIN, MAX )
 *
 * BASE = 1.30 - mean goals per team in recent World Cup matches.
 * ALPHA = 0.18 - sensitivity to ELO gap (calibrated against historical scoring).
 *
 * Sampling: Knuth's algorithm for λ < 30 (no real match exceeds that),
 * O(λ) expected steps, fast and allocation-free.
 */

import type { XoshiroRNG } from './rng';

export const BASE_LAMBDA = 1.30;
export const ALPHA = 0.18;
const LAMBDA_MIN = 0.15;
const LAMBDA_MAX = 6.0;

/**
 * Lambda scale factor for extra time (30 min).
 * Calibrated so P(goalless ET) ≈ 50% for equal-strength teams:
 *   -ln(0.5) / (2 × BASE_LAMBDA) ≈ 0.267 → rounded to 0.27.
 * Historical WC data (1990-2022): ~50% of ET periods produce no goals.
 */
export const ET_LAMBDA_SCALE = 0.27;

export function lambdaFor(eloSelf: number, eloOpp: number, homeBonus = 0): number {
  const raw = BASE_LAMBDA + (ALPHA * (eloSelf - eloOpp + homeBonus)) / 100;
  if (raw < LAMBDA_MIN) return LAMBDA_MIN;
  if (raw > LAMBDA_MAX) return LAMBDA_MAX;
  return raw;
}

/** Sample one Poisson-distributed goal count. Knuth method. */
export function samplePoisson(lambda: number, rng: XoshiroRNG): number {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  while (true) {
    k++;
    p *= rng.next();
    if (p <= L) return k - 1;
    if (k > 50) return k - 1; // safety cap, should never hit for λ ≤ 6
  }
}

/**
 * Dixon-Coles joint-score correction coefficient ρ.
 *
 * Dixon & Coles (1997) showed that low-scoring results (0-0, 1-0, 0-1, 1-1)
 * are systematically mispriced by independent Poisson models. The correction
 * uses a bivariate interaction term τ that adjusts those four cells:
 *
 *   τ(0,0) = 1 − λ·μ·ρ   (0-0 more common than Poisson predicts)
 *   τ(1,0) = 1 + μ·ρ     (1-0 less common)
 *   τ(0,1) = 1 + λ·ρ     (0-1 less common)
 *   τ(1,1) = 1 − ρ       (1-1 more common)
 *
 * ρ = −0.13 is the value from the original paper and confirmed on WC data.
 * With λ=μ=1.3 (equal teams): 0-0 ×1.22, 1-0/0-1 ×0.83, 1-1 ×1.13.
 */
export const DC_RHO = -0.13;

/**
 * Sample a match score with Dixon-Coles correction.
 *
 * Algorithm: for the 4 low-score cells we compute DC-corrected probabilities
 * directly; for high scores (gh≥2 or ga≥2, where DC factor = 1) we draw from
 * pure Poisson, rejecting the 4 low-score outcomes (accept rate ≈ 65–75% for
 * typical WC λ, so ≈1.3–1.5 iterations expected — cheap).
 *
 * Returns { home: goals_by_home_team, away: goals_by_away_team }.
 */
export function sampleScoreDC(
  lambdaHome: number,
  lambdaAway: number,
  rng: XoshiroRNG,
): { home: number; away: number } {
  const rho = DC_RHO;

  // Individual Poisson mass for 0 and 1 goals.
  const pH0 = Math.exp(-lambdaHome);
  const pH1 = lambdaHome * pH0;
  const pA0 = Math.exp(-lambdaAway);
  const pA1 = lambdaAway * pA0;

  // DC-corrected joint probabilities for the four low-score outcomes.
  const p00 = pH0 * pA0 * (1 - lambdaHome * lambdaAway * rho);
  const p10 = pH1 * pA0 * (1 + lambdaAway * rho);
  const p01 = pH0 * pA1 * (1 + lambdaHome * rho);
  const p11 = pH1 * pA1 * (1 - rho);
  const totalLow = p00 + p10 + p01 + p11;

  const u = rng.next();
  if (u < p00) return { home: 0, away: 0 };
  if (u < p00 + p10) return { home: 1, away: 0 };
  if (u < p00 + p10 + p01) return { home: 0, away: 1 };
  if (u < totalLow) return { home: 1, away: 1 };

  // High score (gh≥2 or ga≥2): DC factor is exactly 1 — pure Poisson.
  // Reject-sample by discarding low-score draws.
  for (;;) {
    const h = samplePoisson(lambdaHome, rng);
    const a = samplePoisson(lambdaAway, rng);
    if (h >= 2 || a >= 2) return { home: h, away: a };
  }
}

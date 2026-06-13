import type { Team } from './types';
import { sampleScore, effectiveElo } from './match';
import { shootoutWinProb } from './penalties';
import { lambdaFor, samplePoisson, ET_LAMBDA_SCALE } from './goals';
import type { XoshiroRNG } from './rng';
import type { Stage as AbsenceStage } from './absences';

export interface KnockoutMatch {
  homeIdx: number;
  awayIdx: number;
  /** Regulation + extra-time goals combined (penalty goals excluded). */
  gh: number;
  ga: number;
  winnerIdx: number;
  loserIdx: number;
  /** True if regulation ended level (match went to ET, and possibly PK). */
  drawn: boolean;
}

/**
 * Simulate a single knockout match.
 *
 * Sequence:
 *   1. 90-min regulation (Poisson, ELO + absence-adjusted λ).
 *   2. Regulation draw → 30-min extra time (Poisson, λ × ET_LAMBDA_SCALE).
 *      ET_LAMBDA_SCALE is calibrated so ~50% of ET periods are goalless,
 *      matching WC historical data (1990-2022).
 *   3. Still level after ET → penalty shoot-out via Empirical Bayes model
 *      (see penalties.ts). No host-bonus in ET or PK — neutral venue.
 */
export function simulateKnockout(
  homeIdx: number,
  awayIdx: number,
  teams: Team[],
  rng: XoshiroRNG,
  stage: AbsenceStage = 'r16',
  fatigueHome: boolean = false,
  fatigueAway: boolean = false,
): KnockoutMatch {
  const home = teams[homeIdx];
  const away = teams[awayIdx];

  // --- Regulation (90 min) ---
  const { ga: ghReg, gb: gaReg } = sampleScore(home, away, rng, true, stage, fatigueHome, fatigueAway);
  let gh = ghReg;
  let ga = gaReg;
  let drawn = false;
  let winnerIdx: number;
  let loserIdx: number;

  if (gh > ga) {
    winnerIdx = homeIdx; loserIdx = awayIdx;
  } else if (gh < ga) {
    winnerIdx = awayIdx; loserIdx = homeIdx;
  } else {
    // --- Extra time (30 min) ---
    // Both teams are now fatigued; no host bonus (effective neutral ground).
    // λ_ET = λ_reg × ET_LAMBDA_SCALE so P(0 total ET goals) ≈ 50%.
    drawn = true;
    const eloH = effectiveElo(home, stage);
    const eloA = effectiveElo(away, stage);
    const etGh = samplePoisson(lambdaFor(eloH, eloA, 0) * ET_LAMBDA_SCALE, rng);
    const etGa = samplePoisson(lambdaFor(eloA, eloH, 0) * ET_LAMBDA_SCALE, rng);
    gh += etGh;
    ga += etGa;

    if (gh > ga) {
      winnerIdx = homeIdx; loserIdx = awayIdx;
    } else if (gh < ga) {
      winnerIdx = awayIdx; loserIdx = homeIdx;
    } else {
      // --- Penalty shoot-out ---
      const pHome = shootoutWinProb(home.id, away.id);
      if (rng.next() < pHome) {
        winnerIdx = homeIdx; loserIdx = awayIdx;
      } else {
        winnerIdx = awayIdx; loserIdx = homeIdx;
      }
    }
  }

  return { homeIdx, awayIdx, gh, ga, winnerIdx, loserIdx, drawn };
}

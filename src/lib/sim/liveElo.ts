/**
 * Live ELO adjustment module (Tier 1.5 — in-tournament dynamic update).
 *
 * Once the tournament starts, completed match results provide real evidence
 * about team strength that the pre-tournament ELO snapshot cannot capture.
 * We apply K=60 sequential ELO updates (FIFA standard for World Cup matches)
 * in kickoff chronological order so each match uses the ELO already updated
 * by prior results — not the frozen baseline.
 *
 * Goal-difference multiplier (World Football Elo standard):
 *   GD=1 → ×1.0   GD=2 → ×1.5   GD≥3 → ×(11+GD)/8
 * A 4-1 win provides stronger evidence than a 1-0 win.
 *
 * Result scored on regulation time only (r.gh / r.ga). ET / PK outcomes
 * reflect tactical and chance variance, not 90-min strength difference.
 *
 * The adjustments are cached at first call (the state file is static within
 * a single worker invocation) and sum to zero across all teams (ELO is
 * zero-sum per match pair).
 */

import teamsData from '@/data/teams.json';
import { allResults, isTournamentLive } from './state';

const BASE_ELOS = new Map(
  (teamsData as { teams: Array<{ id: string; elo: number }> }).teams.map(t => [t.id, t.elo]),
);

/** K-factor for World Cup matches (FIFA standard). */
export const WC_K = 60;

/**
 * Goal-difference multiplier — matches the World Football Elo Ratings formula.
 *   |GD| = 1 → 1.0
 *   |GD| = 2 → 1.5
 *   |GD| ≥ 3 → (11 + |GD|) / 8
 */
export function goalDiffMultiplier(goalDiff: number): number {
  const d = Math.abs(goalDiff);
  if (d <= 1) return 1.0;
  if (d === 2) return 1.5;
  return (11 + d) / 8;
}

function computeDeltas(): Map<string, number> {
  const deltas = new Map<string, number>();
  if (!isTournamentLive()) return deltas;

  // Sort completed results by kickoff time for sequential updates.
  const completed = Object.values(allResults())
    .filter(r => r.status === 'completed' && r.kickoff_iso)
    .sort((a, b) => new Date(a.kickoff_iso!).getTime() - new Date(b.kickoff_iso!).getTime());

  if (completed.length === 0) return deltas;

  // Work on a mutable copy of ELOs — each match updates the running state.
  const elos = new Map(BASE_ELOS);

  for (const r of completed) {
    const eloH = elos.get(r.home) ?? 1500;
    const eloA = elos.get(r.away) ?? 1500;

    // Win expectancy from home perspective.
    const we = 1 / (Math.pow(10, -(eloH - eloA) / 400) + 1);

    // Regulation result: 1 win / 0.5 draw / 0 loss.
    const result = r.gh > r.ga ? 1 : r.gh < r.ga ? 0 : 0.5;
    const k = WC_K * goalDiffMultiplier(r.gh - r.ga);
    const change = k * (result - we);

    elos.set(r.home, eloH + change);
    elos.set(r.away, eloA - change);
  }

  // Final delta = updated ELO − base ELO, only for teams that played.
  for (const [id, updatedElo] of elos) {
    const base = BASE_ELOS.get(id);
    if (base !== undefined && Math.abs(updatedElo - base) > 0.01) {
      deltas.set(id, updatedElo - base);
    }
  }

  return deltas;
}

let _cache: Map<string, number> | null = null;

/** ELO adjustment for a team derived from completed tournament results.
 *  Returns 0 if the tournament hasn't started or the team hasn't played. */
export function liveEloAdjustment(teamId: string): number {
  if (!_cache) _cache = computeDeltas();
  return _cache.get(teamId) ?? 0;
}

/** All adjustments as a Map — used by UI to display ELO change indicators. */
export function allLiveEloAdjustments(): Map<string, number> {
  if (!_cache) _cache = computeDeltas();
  return _cache;
}

import type { Team } from './types';
import { sampleScore } from './match';
import type { XoshiroRNG } from './rng';
import { getGroupResult } from './state';

export interface TeamStanding {
  teamIdx: number;
  /** Original 0-3 position within the group — used for H2H matrix lookup. Immutable. */
  groupPos: number;
  p: number;     // points
  gf: number;    // goals for
  ga: number;    // goals against
  gd: number;    // goal differential
  tiebreak: number; // seeded random, last-resort tiebreaker
}

/**
 * Round-robin pair order - first index is "home", second is "away" within the group.
 * Slot index 0..5 maps to these pairs (used as part of fixture slot IDs).
 */
export const GROUP_PAIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2],
] as const;

/** Simulates one 4-team group round-robin. Returns 4 standings sorted top→bottom.
 *
 *  If `groupLetter` is provided, the simulator consults the live tournament
 *  state (Tier 1.5): any match already played in real life is taken as-is
 *  instead of being resampled. Pass undefined to force a pure simulation
 *  (used by the backtest harness which has its own state). */
export function simulateGroup(
  teamIdxs: number[],          // 4 team indices into the global team array
  teams: Team[],               // global team array
  rng: XoshiroRNG,
  onMatch?: (pairIdx: number, homeIdx: number, awayIdx: number, gh: number, ga: number) => void,
  groupLetter?: string,
): TeamStanding[] {
  const standings: TeamStanding[] = teamIdxs.map((idx, pos) => ({
    teamIdx: idx,
    groupPos: pos,
    p: 0, gf: 0, ga: 0, gd: 0, tiebreak: rng.next(),
  }));

  // Head-to-head matrices indexed by group position (0-3).
  // h2hGoals[i][j] = goals scored by position-i team vs position-j team.
  // h2hPts[i][j]   = points earned by position-i team vs position-j team.
  const h2hGoals: number[][] = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];
  const h2hPts:   number[][] = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,0]];

  for (let p = 0; p < GROUP_PAIRS.length; p++) {
    const [i, j] = GROUP_PAIRS[p];
    const a = standings[i];
    const b = standings[j];

    let gh: number, gv: number;
    const decided = groupLetter ? getGroupResult(`${groupLetter}:${p}`) : null;
    if (decided && decided.home === teams[a.teamIdx].id && decided.away === teams[b.teamIdx].id) {
      // Use the real result. Note: the engine's home/away ordering is fixed by
      // GROUP_PAIRS, so we only honor the state entry when it matches that
      // orientation. Otherwise fall through to sampling (defensive against a
      // malformed state file).
      gh = decided.gh;
      gv = decided.ga;
    } else {
      const s = sampleScore(teams[a.teamIdx], teams[b.teamIdx], rng, false);
      gh = s.ga;
      gv = s.gb;
    }

    onMatch?.(p, a.teamIdx, b.teamIdx, gh, gv);
    a.gf += gh; a.ga += gv; a.gd += gh - gv;
    b.gf += gv; b.ga += gh; b.gd += gv - gh;

    // Record H2H goals (each pair meets exactly once in the round-robin).
    h2hGoals[i][j] = gh;
    h2hGoals[j][i] = gv;

    if (gh > gv) {
      a.p += 3;
      h2hPts[i][j] = 3;
    } else if (gh < gv) {
      b.p += 3;
      h2hPts[j][i] = 3;
    } else {
      a.p += 1; b.p += 1;
      h2hPts[i][j] = 1;
      h2hPts[j][i] = 1;
    }
  }

  return sortWithH2H(standings, h2hGoals, h2hPts);
}

/**
 * Sort standings by FIFA WC 2026 group-stage tiebreaker order:
 *   1. Points (overall)
 *   2. Goal difference (overall)
 *   3. Goals scored (overall)
 *   4. Head-to-head points among tied teams
 *   5. Head-to-head goal difference among tied teams
 *   6. Head-to-head goals scored among tied teams
 *   7. Drawing of lots (seeded random)
 *
 * Note: fair-play points (step 7 in real FIFA) are not modelled.
 */
function sortWithH2H(
  standings: TeamStanding[],
  h2hGoals: number[][],
  h2hPts: number[][],
): TeamStanding[] {
  // Pass 1 — global criteria (P, GD, GF). Ties left at 0 are resolved in pass 2.
  standings.sort((a, b) => {
    if (a.p !== b.p) return b.p - a.p;
    if (a.gd !== b.gd) return b.gd - a.gd;
    if (a.gf !== b.gf) return b.gf - a.gf;
    return 0;
  });

  // Pass 2 — within each globally-tied block, apply H2H then random.
  let i = 0;
  while (i < standings.length) {
    let j = i + 1;
    while (
      j < standings.length &&
      standings[j].p   === standings[i].p &&
      standings[j].gd  === standings[i].gd &&
      standings[j].gf  === standings[i].gf
    ) j++;

    if (j - i > 1) {
      const block = standings.slice(i, j);
      // Snapshot before sort so comparisons see a stable reference.
      const snapshot = block.slice();
      block.sort((a, b) => {
        const ap = a.groupPos;
        const bp = b.groupPos;
        // H2H points vs every other team in this tied block.
        let hpA = 0, hpB = 0;
        for (const t of snapshot) {
          if (t !== a) hpA += h2hPts[ap][t.groupPos];
          if (t !== b) hpB += h2hPts[bp][t.groupPos];
        }
        if (hpA !== hpB) return hpB - hpA;
        // H2H goal difference vs every other team in this tied block.
        let hdA = 0, hdB = 0;
        for (const t of snapshot) {
          if (t !== a) hdA += h2hGoals[ap][t.groupPos] - h2hGoals[t.groupPos][ap];
          if (t !== b) hdB += h2hGoals[bp][t.groupPos] - h2hGoals[t.groupPos][bp];
        }
        if (hdA !== hdB) return hdB - hdA;
        // H2H goals scored vs every other team in this tied block.
        let hfA = 0, hfB = 0;
        for (const t of snapshot) {
          if (t !== a) hfA += h2hGoals[ap][t.groupPos];
          if (t !== b) hfB += h2hGoals[bp][t.groupPos];
        }
        if (hfA !== hfB) return hfB - hfA;
        // Drawing of lots.
        return b.tiebreak - a.tiebreak;
      });
      standings.splice(i, j - i, ...block);
    }
    i = j;
  }

  return standings;
}

/**
 * Compare two standings for cross-group thirds ranking.
 * H2H is not applicable across groups — use global criteria only.
 */
export function compareStandings(a: TeamStanding, b: TeamStanding): number {
  if (a.p !== b.p) return b.p - a.p;
  if (a.gd !== b.gd) return b.gd - a.gd;
  if (a.gf !== b.gf) return b.gf - a.gf;
  return b.tiebreak - a.tiebreak;
}

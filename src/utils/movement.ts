// Movement rules — mirror of scripts/lib/movement.mjs so both client
// and worker can compute budgets without cross-tree imports. If you
// change a value here, change it there too. (Both files are tiny and
// the test suite covers the equivalence.)

import type { Force, ForceBranch } from '@/types';

export const ARMY_KM_PER_DAY = 25;
export const NAVY_KM_PER_DAY = 200;
export const MOVEMENT_TOLERANCE_KM = 0.1;

export function budgetForBranch(branch: ForceBranch, lastTurnDays: number): number {
  const perDay = branch === 'navy' ? NAVY_KM_PER_DAY : ARMY_KM_PER_DAY;
  return perDay * Math.max(0, lastTurnDays);
}

/** True when the force was raised during the current turn — it can't move
 *  until the next ADVANCE_TURN bumps the counter past createdAtTurn. */
export function isNewlyRaised(force: Force, currentTurnNumber: number): boolean {
  return (
    typeof force.createdAtTurn === 'number' &&
    force.createdAtTurn === currentTurnNumber
  );
}

/** What this specific force is allowed to move this turn. Returns 0 when
 *  the force was raised this same turn; otherwise the standard branch
 *  budget. Used by the UI to size the range circle and by the server-side
 *  gates to reject over-budget submissions. */
export function effectiveBudget(
  force: Force,
  lastTurnDays: number,
  currentTurnNumber: number,
): number {
  if (isNewlyRaised(force, currentTurnNumber)) return 0;
  return budgetForBranch(force.branch, lastTurnDays);
}

/** Whole days between two ISO YYYY-MM-DD dates. Negative if `to` < `from`. */
export function daysBetween(isoFrom: string, isoTo: string): number {
  const a = Date.parse(isoFrom + 'T00:00:00Z');
  const b = Date.parse(isoTo + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

// ── Recruitment budgets ──────────────────────────────────────────────
// Mirror of the same block in scripts/lib/movement.mjs — the reason
// strings are part of the contract, so keep them character-identical.

/** Men (army) and ships (navy) a nation may raise per whole month of
 *  turn length. Flat rates: the calendar is the only brake. */
export const MEN_PER_MONTH = 15000;
export const SHIPS_PER_MONTH = 1;

// Fixed-length month, not the Gregorian calendar — whole 30-day blocks
// so the cap can't be gamed by picking a long month.
const DAYS_PER_MONTH = 30;

/** Whole months in the turn. Floored, so a 59-day turn buys one month's
 *  recruits and a 29-day turn buys none. */
function turnMonths(lastTurnDays: number): number {
  return Math.floor(Math.max(0, lastTurnDays) / DAYS_PER_MONTH);
}

/** Per-nation, per-turn recruitment cap for a branch. */
export function raiseBudget(branch: ForceBranch, lastTurnDays: number): number {
  const perMonth = branch === 'navy' ? SHIPS_PER_MONTH : MEN_PER_MONTH;
  return turnMonths(lastTurnDays) * perMonth;
}

/** What one force charges against its nation's cap this turn.
 *  turnStartStrength is the strength held at the START of the turn, so a
 *  force raised mid-turn carries an anchor of 0 and bills its full
 *  strength — the anchor already encodes "did not exist yet", which is
 *  why createdAtTurn is not consulted here (it is now purely the
 *  movement lock). Reinforcement costs the men added, losses cost
 *  nothing, a split nets zero across both halves, and the backfilled
 *  legacy order of battle costs 0. A re-branded force pays in full: its
 *  anchor was earned in the branch it left, so against the pool it moved
 *  into it is brand new — without that clause a 40000-man army edited to
 *  navy/40 scores max(0, 40 - 40000) = 0 and lands 40 ships. */
export function raiseCost(force: Force): number {
  if (force.branch !== force.turnStartBranch) return force.strength;
  // Asserted, not defaulted: the anchors are optional in the type only
  // for snapshots in flight, and both the worker and the CI validator
  // reject a force missing them. A `?? 0` here would silently bill a
  // legacy force its whole strength and diverge from movement.mjs, which
  // does the bare subtraction.
  return Math.max(0, force.strength - force.turnStartStrength!);
}

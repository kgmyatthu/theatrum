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
// checkRaiseBudgets is deliberately NOT mirrored: it is a gate, and a
// gate belongs to the servers that can refuse a submission. The client
// mirrors only what it needs to PREDICT a refusal — the per-branch cap,
// so a panel can show it, and now the standing ceiling alongside it.

/** Men (army) and ships (navy) a nation may raise per whole month of
 *  turn length. MEN_PER_MONTH is both the men-per-month AT
 *  REFERENCE_POP and the fail-open fallback when no population is given,
 *  and both hats moved together on the 15000 → 10000 cut: a linear
 *  multiplier on the curve, so every unfloored nation scaled by exactly
 *  2/3 and a nation with no table on file is now quoted 10000, which is
 *  intended — the fallback is this rule without a population term, not
 *  the rate as it stood before populations existed.
 *  SHIPS_PER_MONTH stays flat: hulls are limited by yards, not people. */
export const MEN_PER_MONTH = 10000;
export const SHIPS_PER_MONTH = 1;

/** The population MEN_PER_MONTH is quoted at — a nation of exactly this
 *  size raises exactly MEN_PER_MONTH per month, everyone else scales. The
 *  pivot, not a rate: re-pricing MEN_PER_MONTH turns the curve about this
 *  population rather than moving it. */
export const REFERENCE_POP = 15_000_000;

/** Floor under both the monthly rate and the standing ceiling, so a
 *  microstate can still field and keep a garrison rather than being a
 *  nation that cannot play. Held at 3000 while MEN_PER_MONTH fell to
 *  10000, so it is 30% of the pivot rate rather than 20%: it now meets
 *  the curve at 405,000 people, not 120,000, and binds 9 of the 82
 *  shipped nations rather than 5. */
export const MIN_MEN_PER_MONTH = 3000;

/** Hard share of a nation's people that may be under arms at once. A
 *  stock, not a rate, and 3.5% is already extraordinary for the period.
 *  The 4% → 3.5% tightening is a flat 0.875 multiplier on every ceiling
 *  at once, so it reorders nobody and breaches nobody new on the shipped
 *  table — sweden, the tightest nation, moves from 77.4% of its ceiling
 *  to 88.5%. The recruitment curve does not read this constant: flow and
 *  stock are re-priced independently. */
export const MAX_ARMY_POP_SHARE = 0.035;

/** Men per whole month for a nation of `pop` people. CUBE root, not
 *  linear and no longer square: doubling the people multiplies the
 *  regiments by ~1.26 and it takes EIGHT times the people to buy twice
 *  the men, which stops the largest populations out-typing everyone
 *  without starving the small ones — china's 293.8M buys 26,956/mo
 *  against sweden's 5,994, a 4.5× spread over 91× the people (the spread
 *  is a ratio, so re-pricing MEN_PER_MONTH leaves it alone). `pop`
 *  undefined (or non-finite) means the population table was not supplied
 *  — not that the nation has none — so it fails OPEN to the flat
 *  MEN_PER_MONTH this rule replaced. The non-finite half of that guard is
 *  load-bearing: Math.max(3000, NaN) is NaN, which loses every comparison
 *  and would render a cap of "NaN men". */
export function menPerMonth(pop?: number): number {
  if (pop === undefined || !Number.isFinite(pop)) return MEN_PER_MONTH;
  // Clamp before the root. It is no longer NaN defence the way it was
  // under sqrt — Math.cbrt(negative) is an ordinary negative number, not
  // NaN — but a negative rate is nonsense the floor below would merely
  // hide, so "negative population" is pinned to "nobody" here instead.
  const scaled = MEN_PER_MONTH * Math.cbrt(Math.max(0, pop) / REFERENCE_POP);
  return Math.max(MIN_MEN_PER_MONTH, Math.round(scaled));
}

/** The most men a nation may have STANDING at once — a stock ceiling on
 *  everything currently branded army, distinct from the monthly flow: a
 *  nation can be inside its monthly cap every turn and still hit this.
 *  Floored, never rounded, because the rule is "may never exceed".
 *  Fails OPEN on an absent population by returning Infinity, which is
 *  the one-expression spelling of "unenforced" — `standing > Infinity`
 *  is always false, so no call site needs a second branch to ask whether
 *  the rule is switched on. The navy has no equivalent. */
export function standingArmyCeiling(pop?: number): number {
  if (pop === undefined || !Number.isFinite(pop)) return Infinity;
  return Math.max(MIN_MEN_PER_MONTH, Math.floor(MAX_ARMY_POP_SHARE * Math.max(0, pop)));
}

// Fixed-length month, not the Gregorian calendar — whole 30-day blocks
// so the cap can't be gamed by picking a long month.
const DAYS_PER_MONTH = 30;

/** Whole months in the turn. Floored, so a 59-day turn buys one month's
 *  recruits and a 29-day turn buys none. */
function turnMonths(lastTurnDays: number): number {
  return Math.floor(Math.max(0, lastTurnDays) / DAYS_PER_MONTH);
}

/** Per-nation, per-turn recruitment cap for a branch. `pop` is OPTIONAL
 *  and that is load-bearing: omitted, menPerMonth answers MEN_PER_MONTH
 *  and the cap is the flat one this parameter is absent from — the
 *  population-free rule at whatever rate MEN_PER_MONTH currently names,
 *  so every call site that predates population still needs no argument.
 *  The navy never consults it. */
export function raiseBudget(
  branch: ForceBranch,
  lastTurnDays: number,
  pop?: number,
): number {
  const perMonth = branch === 'navy' ? SHIPS_PER_MONTH : menPerMonth(pop);
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

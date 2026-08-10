// Movement rules — shared between the worker, the validator, and the
// client (via src/utils/movement.ts which re-exports these constants).
// Keep dependency-free so the worker bundle stays small.

export const ARMY_KM_PER_DAY = 25;
export const NAVY_KM_PER_DAY = 200;

/** Per-turn km cap for a force. Branches outside the two known values
 *  fall back to the army rate (safer to under-budget than to over-budget). */
export function budgetForBranch(branch, lastTurnDays) {
  const perDay = branch === 'navy' ? NAVY_KM_PER_DAY : ARMY_KM_PER_DAY;
  return perDay * Math.max(0, lastTurnDays);
}

/** Whole days between two ISO YYYY-MM-DD dates, exclusive of the start.
 *  Negative when `to` is before `from`. */
export function daysBetween(isoFrom, isoTo) {
  const a = Date.parse(isoFrom + 'T00:00:00Z');
  const b = Date.parse(isoTo + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Great-circle distance in km. Mirrors src/utils/geometry.ts:haversineKm
 *  so this file has no client dependency. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Float-drift tolerance for the displacement ≤ kmMovedThisTurn sanity
 *  check. 0.1 km absorbs the JSON round-trip on lat/lon. */
export const MOVEMENT_TOLERANCE_KM = 0.1;

// ── Recruitment budgets ──────────────────────────────────────────────
// ponytail: recruitment lives in movement.mjs rather than its own
// recruit.mjs because it's a handful of rules and both server-side
// consumers (worker + validator) already import this file — one import,
// no new build surface. Split it out if the raise rules outgrow this block.

/** Men (army) and ships (navy) a nation may raise per whole month of
 *  turn length. Flat rates: no economy, no population, no upkeep — the
 *  calendar is the only brake. */
export const MEN_PER_MONTH = 15000;
export const SHIPS_PER_MONTH = 1;

// Fixed-length month. Not the Gregorian calendar — a turn is scored on
// whole 30-day blocks so the cap can't be gamed by picking a long month.
const DAYS_PER_MONTH = 30;

/** Whole months in the turn. Floored, so a 59-day turn buys one month's
 *  recruits and a 29-day turn buys none. */
export function turnMonths(lastTurnDays) {
  return Math.floor(Math.max(0, lastTurnDays) / DAYS_PER_MONTH);
}

/** Per-nation, per-turn recruitment cap for a branch. Unknown branches
 *  fall back to the army rate, matching budgetForBranch. */
export function raiseBudget(branch, lastTurnDays) {
  const perMonth = branch === 'navy' ? SHIPS_PER_MONTH : MEN_PER_MONTH;
  return turnMonths(lastTurnDays) * perMonth;
}

/** What one force charges against its nation's cap this turn.
 *  turnStartStrength is the strength the force held at the START of the
 *  turn, so a force raised mid-turn carries an anchor of 0 and bills its
 *  full strength. That anchor already encodes "did not exist yet", which
 *  is why there is no createdAtTurn test here — createdAtTurn is now
 *  purely the movement lock (isNewlyRaised) and has no say in cost.
 *  Every other case falls out of the same subtraction: reinforcement
 *  costs exactly the men added, losses cost nothing (clamped at 0, so a
 *  mauled force bills nothing of its own and regrows up to its own anchor
 *  for free until the turn advances and the anchor resets down to what
 *  survived — the clamp alone does NOT make the surplus forfeit, see the
 *  ponytail note below), a split nets zero because the parent's anchor is
 *  partitioned across both halves, and the legacy order of battle —
 *  backfilled with anchor = strength — costs 0, which is the
 *  grandfathering we want.
 *
 *  A re-branded force pays in full: its anchor was earned in the branch
 *  it left, so against the pool it moved INTO it is a brand-new force.
 *  Without that clause a 40000-man army edited to branch 'navy' with
 *  strength 40 scores max(0, 40 - 40000) = 0 and lands 40 ships against
 *  a cap of 1. turnStartBranch exists only to make that comparison
 *  possible: the anchor is a bare number with no branch identity.
 *
 *  Assumes strength / turnStartStrength / turnStartBranch are validated
 *  — the server rejects forces missing any of them.
 *
 *  ponytail: the anchors are still client-asserted; what keeps that
 *  honest is checkAnchorConservation, which pairs every head force to its
 *  base self by id and refuses a nation whose anchors outrun what those
 *  same forces were anchored at. Ceiling: the pairing is still totalled
 *  per branch rather than matched force-for-force, because a split has to
 *  be free to move anchor from parent to detachment and nothing in the
 *  data says which force is whose child. So a mauled force's surplus
 *  anchor is spendable rather than forfeit: drop its anchor to what
 *  actually survived and hand the difference to any other force in the
 *  same branch — one base already knew, or one raised on the spot with
 *  anchor == strength — and raiseCost bills that force 0 for men the
 *  nation never paid for. The total is conserved either way, so the gate
 *  is silent. That is a ceiling, not a widening: the per-nation anchor
 *  SUM this replaced allowed the identical trade. Upgrade path: record a
 *  parent id on a detachment, which makes a split checkable and lets the
 *  rule tighten from a per-branch total to per-force equality. */
export function raiseCost(force) {
  if (force.branch !== force.turnStartBranch) return force.strength;
  return Math.max(0, force.strength - force.turnStartStrength);
}

/** Cap check for a whole submission. `forcesByNation` is
 *  Record<nation, Force[]>. Returns null when every nation is inside its
 *  budget, else a reason string naming the first offender.
 *
 *  Recomputed from the forces array on every submission rather than
 *  tracked in a counter, so it is cumulative across however many PRs a
 *  nation lands inside one turn — the second PR sees the first PR's
 *  recruits already sitting in the sum. */
export function checkRaiseBudgets(forcesByNation, lastTurnDays) {
  const months = turnMonths(lastTurnDays);
  const days = Math.max(0, lastTurnDays);
  // Sorted so two consumers reporting the same violation name the same
  // nation first — deterministic messages are testable messages.
  for (const nation of Object.keys(forcesByNation).sort()) {
    const spent = { army: 0, navy: 0 };
    for (const f of forcesByNation[nation] || []) {
      // Bucketed by CURRENT branch: a re-branded force bills the pool it
      // moved into, which is the pool its new hulls or men now sit in.
      // Unknown branches bucket as army, same fallback as raiseBudget.
      spent[f.branch === 'navy' ? 'navy' : 'army'] += raiseCost(f);
    }
    for (const branch of ['army', 'navy']) {
      const total = spent[branch];
      if (total <= 0) continue;
      const cap = raiseBudget(branch, lastTurnDays);
      if (total <= cap) continue;
      const unit = branch === 'navy' ? 'ships' : 'men';
      if (months < 1) {
        return `${nation} cannot raise or reinforce its ${branch} this turn: ${total} ${unit} requested but the turn is only ${days} days — shorter than a month, so the cap is 0 ${unit}`;
      }
      return `${nation} exceeded its ${branch} recruitment cap: ${total} ${unit} raised or reinforced this turn, cap is ${cap} ${unit} for a ${months}-month turn`;
    }
  }
  return null;
}

/** One force's turn-start anchor as a { strength, branch } pair.
 *  Bucketed by turnStartBranch, not branch: the anchor was earned in the
 *  branch the force started the turn in, so a re-brand moves the force
 *  between pools without moving its anchor (raiseCost is what charges for
 *  the re-brand, not this). Both halves fall back the same way the
 *  backfill does — strength for a missing number, current branch for a
 *  missing branch — so a base commit older than the anchors doesn't read
 *  as a violation. Falling back to 'army' instead of the force's own
 *  branch would drop every un-backfilled navy anchor into the army pool
 *  and read an untouched fleet as inflation on both sides at once. Head
 *  forces never take either fallback: both servers reject a force missing
 *  them; the shared helper is just so the two sides cannot drift. */
function anchorOf(f) {
  return {
    strength: f.turnStartStrength ?? f.strength,
    branch: (f.turnStartBranch ?? f.branch) === 'navy' ? 'navy' : 'army',
  };
}

/** The gate that makes the client-asserted anchors safe. Every head force
 *  is paired to its base self BY ID, and a nation's per-branch anchor
 *  total may not exceed what exactly those forces were anchored at in
 *  base — a force base never saw contributes 0, so it can only be
 *  submitted with a 0 anchor. Both args are Record<nation, Force[]>; only
 *  nations present in head are checked, since a nation that submitted
 *  nothing cannot cheat.
 *
 *  Passes: a split (the detachment is unknown to base and adds 0 to the
 *  allowance, but the parent's full base anchor is still on offer, so the
 *  two halves may share it), a force raised this turn (anchor 0, adds 0 to
 *  both sides — raiseCost bills it instead), a disbandment (the force is
 *  gone from head, so it drops out of both totals together), and a
 *  RENAME_COUNTRY, which rewrites force.nation and so carries whole ids
 *  from forces/spain.json into forces/hispania.json — the receiving file
 *  had no anchors at base, and only id-pairing sees that they are the
 *  same forces.
 *
 *  Rejects: a force injected with a fat anchor, an existing force's anchor
 *  edited upward to zero out its own growth, a nation that keeps a mauled
 *  force's surplus anchor AND spends it again on a new force, and an id
 *  whose turnStartBranch differs from base (it pairs into a bucket its
 *  base anchor is not in, so that bucket's allowance is 0 — legitimate
 *  only across a turn advance, where the whole check is skipped).
 *
 *  Callers own two things. The turn-advance exception: when the turn
 *  number changes the anchors legitimately reset up to current strengths,
 *  so skip this call for that submission (it is admin-only and gated
 *  elsewhere) — hence no turnNumber parameter here. And the scope: HEAD
 *  may be narrowed to the nations a submission touches, but BASE must be
 *  every force in every nation file. A base narrowed to the same subset
 *  cannot see the old home of a renamed or relocated force, drops its
 *  allowance to 0, and rejects a legal move. */
export function checkAnchorConservation(baseForcesByNation, headForcesByNation) {
  // Base is indexed by id ALONE, never nation+id, for the rename above:
  // keyed by nation, every force in the renamed country would read as
  // freshly invented and a shipped admin feature would be unsubmittable.
  // Ids are unique across nation files (the validator enforces it), so a
  // flat index loses nothing — and a colluding transfer, which is the one
  // thing that wants to be two files at once, is exactly what that
  // uniqueness check rejects first.
  const baseById = new Map();
  for (const forces of Object.values(baseForcesByNation)) {
    for (const f of forces || []) baseById.set(f.id, anchorOf(f));
  }
  // Same sorted-nation, army-before-navy walk as checkRaiseBudgets so
  // both gates name the same first offender.
  for (const nation of Object.keys(headForcesByNation).sort()) {
    const total = { army: 0, navy: 0 };
    const allowance = { army: 0, navy: 0 };
    for (const f of headForcesByNation[nation] || []) {
      const anchor = anchorOf(f);
      total[anchor.branch] += anchor.strength;
      // Only the same id, and only if base held its anchor in this same
      // branch, funds this bucket. Everything else — new id, id last seen
      // in the other branch — funds nothing.
      const was = baseById.get(f.id);
      if (was && was.branch === anchor.branch) {
        allowance[anchor.branch] += was.strength;
        // Spent, not merely read: one base anchor funds exactly ONE head
        // force. Ids are unique in any submission the CI validator will
        // accept, so this only ever bites a repeat — but the worker has no
        // duplicate-id check of its own (and a client that omits `baseline`
        // skips the rebase that would otherwise dedupe by id), so without
        // this a force cloned under its own id multiplies its base anchor
        // once per copy and both clones bill 0.
        baseById.delete(f.id);
      }
    }
    for (const branch of ['army', 'navy']) {
      if (total[branch] <= allowance[branch]) continue;
      const unit = branch === 'navy' ? 'ships' : 'men';
      return `${nation} inflated its ${branch} turn-start strength: its anchors total ${total[branch]} ${unit} in this submission but the same forces were anchored at ${allowance[branch]} ${unit} at the start of the turn — anchors may be split or dropped within a turn, never invented or raised`;
    }
  }
  return null;
}

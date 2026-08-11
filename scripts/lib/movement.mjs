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
 *  turn length. MEN_PER_MONTH wears two hats: it is the men-per-month AT
 *  the reference population (see menPerMonth), and it is the fail-open
 *  fallback used when no population is supplied at all.
 *
 *  Both hats move together when the number does, and that is the whole
 *  content of the 15000 → 10000 cut: it is a LINEAR multiplier on the
 *  curve, so every nation not sitting on the floor scaled by exactly 2/3
 *  (china 40,433 → 26,956, sweden 8,991 → 5,994) while REFERENCE_POP,
 *  MIN_MEN_PER_MONTH, MAX_ARMY_POP_SHARE, the cube root and the flat navy
 *  rate were all left alone. The fallback re-priced to 10000 along with
 *  it, deliberately: the fail-open answer is "this rule with no
 *  population term", not "the rate as it stood before populations
 *  existed", and freezing it at the old 15000 would have made a missing
 *  table the most generous thing that can happen to a nation.
 *
 *  SHIPS_PER_MONTH stays genuinely flat: the navy is hull-limited by
 *  yards and timber, not by how many men a country has. */
export const MEN_PER_MONTH = 10000;
export const SHIPS_PER_MONTH = 1;

/** The population MEN_PER_MONTH is quoted at. A nation of exactly this
 *  many people raises exactly MEN_PER_MONTH per month; everyone else
 *  scales off it. Chosen as the historical mid-sized power, and it is the
 *  PIVOT rather than a rate: re-pricing MEN_PER_MONTH turns the curve
 *  about this population without moving it, which is why the cut to
 *  10000 changed every nation's figure and no nation's ordering. */
export const REFERENCE_POP = 15_000_000;

/** Floor under the monthly rate AND under the standing-army ceiling. A
 *  microstate must still be able to field and replace a garrison, or it
 *  is a nation that cannot play. Deliberately the same number for both:
 *  the floor exists to keep a small nation viable, and viability means
 *  both raising men and being allowed to keep them.
 *
 *  Held at 3000 while MEN_PER_MONTH fell to 10000, so the floor is no
 *  longer the rare edge it was: it is now 30% of the pivot rate rather
 *  than 20%, it meets the curve at a population 405,000 rather than
 *  120,000 (see the crossover derivation in movement.test.mjs), and 9 of
 *  the 82 nations in the shipped table sit on it rather than 5. It is a
 *  genuine mechanic for the small end of the board, not a guard rail
 *  nothing touches. */
export const MIN_MEN_PER_MONTH = 3000;

/** Hard share of a nation's people that may be under arms at once. Not a
 *  rate — a stock. 3.5% is already extraordinary by the period's standards
 *  (levée-en-masse France peaked near it) so it binds only the nations
 *  that have genuinely over-mobilised.
 *
 *  The 4% → 3.5% tightening is a flat 0.875 multiplier on every nation's
 *  ceiling at once — nothing else about the rule moved, so it cannot
 *  reorder anybody — and on the shipped table it breaches nobody new:
 *  sweden is the tightest nation on the board and goes from 77.4% of its
 *  ceiling to 88.5% (100,000 standing against 113,043). mysore was
 *  already over on the floor (8,000 men, no provinces, so 0 people and a
 *  3000 ceiling) and is untouched by this — the floor is where it sits,
 *  and the floor did not move.
 *
 *  Two things this share does NOT reach, both deliberate. The recruitment
 *  curve never reads it: menPerMonth is a flow and this is a stock, so
 *  re-pricing one leaves the other exactly where it was. And its own
 *  floor crossover is MIN_MEN_PER_MONTH / MAX_ARMY_POP_SHARE, which was a
 *  clean 75,000 people at 0.04 and is 85,714.285… at 0.035 — no
 *  population lands exactly on it any more (see the derivation in
 *  movement.test.mjs, which pins the integers either side). */
export const MAX_ARMY_POP_SHARE = 0.035;

/** Men per whole month for a nation of `pop` people. CUBE root, not
 *  linear and no longer square: recruitment scales with the population a
 *  state can actually reach and administer, so doubling the people does
 *  not double the regiments — it multiplies them by ~1.26, and it takes
 *  EIGHT times the people to buy twice the men (under the square root it
 *  was four). That keeps the largest populations from simply out-typing
 *  everyone (china's 293.8M buys 26,956/mo, not 195,860) while a small
 *  nation is not reduced to a trickle (sweden's 3.2M buys 5,994/mo).
 *
 *  The move from square to cube root is a deliberate flattening of the
 *  board, not a retune of one number: scored at today's MEN_PER_MONTH,
 *  the shipped table's top-to-bottom spread falls from 14.8× to 9.0×, and
 *  the nations pinned flat on the MIN_MEN_PER_MONTH floor — nations whose
 *  recruitment is no longer a function of their people at all — drop from
 *  25 to 9. The reference POPULATION is untouched by either change, so
 *  REFERENCE_POP still buys exactly MEN_PER_MONTH and only the curvature
 *  either side of it moved; re-pricing MEN_PER_MONTH is the orthogonal
 *  knob, scaling every unfloored nation by the same factor at once.
 *
 *  FAILS OPEN ON ABSENCE: `undefined` means the population table was not
 *  supplied — not that the nation has no people — and yields the flat
 *  MEN_PER_MONTH this rule replaced. Non-finite is folded into the same
 *  branch on purpose: Math.max(3000, NaN) is NaN, which loses every
 *  comparison it appears in and would render a cap of "NaN men" into a
 *  player-facing reason string. A garbage number is not evidence about a
 *  nation, so it is treated as no evidence.
 *
 *  A nation merely MISSING from a table that WAS supplied is a different
 *  case and is resolved to 0 by the caller, which lands on the floor. */
export function menPerMonth(pop) {
  if (pop === undefined || !Number.isFinite(pop)) return MEN_PER_MONTH;
  // Clamp before the root. Note this clamp changed JOB when the curve did:
  // Math.sqrt(negative) was NaN — the exact failure the guard above exists
  // to prevent — whereas Math.cbrt(negative) is a perfectly ordinary
  // NEGATIVE number (cbrt(-5/15e6)·10000 is -69), so the clamp is no
  // longer NaN defence. It is kept because a negative rate is nonsense
  // that only the floor below would hide: clamping makes "negative
  // population" mean "nobody", which is the sole reading that is true,
  // rather than leaving Math.max to launder -69 men into 3000.
  const scaled = MEN_PER_MONTH * Math.cbrt(Math.max(0, pop) / REFERENCE_POP);
  return Math.max(MIN_MEN_PER_MONTH, Math.round(scaled));
}

/** The most men a nation may have STANDING at once — total strength of
 *  everything currently branded army, whenever it was raised. This is a
 *  stock ceiling and is a different quantity from the monthly flow above:
 *  a nation can be inside its monthly cap every single turn and still
 *  walk into this one.
 *
 *  Floored, never rounded: the rule is "may never exceed", so a ceiling
 *  of 113,043.07 men is 113,043 men.
 *
 *  FAILS OPEN ON ABSENCE by returning Infinity, which is the
 *  one-expression spelling of "unenforced" — `standing > Infinity` is
 *  always false, so the call site needs no second branch and no flag to
 *  ask whether the rule is on. Non-finite folds in here for the same
 *  reason as menPerMonth. */
export function standingArmyCeiling(pop) {
  if (pop === undefined || !Number.isFinite(pop)) return Infinity;
  return Math.max(MIN_MEN_PER_MONTH, Math.floor(MAX_ARMY_POP_SHARE * Math.max(0, pop)));
}

// Fixed-length month. Not the Gregorian calendar — a turn is scored on
// whole 30-day blocks so the cap can't be gamed by picking a long month.
const DAYS_PER_MONTH = 30;

/** Whole months in the turn. Floored, so a 59-day turn buys one month's
 *  recruits and a 29-day turn buys none. */
export function turnMonths(lastTurnDays) {
  return Math.floor(Math.max(0, lastTurnDays) / DAYS_PER_MONTH);
}

/** Per-nation, per-turn recruitment cap for a branch. Unknown branches
 *  fall back to the army rate, matching budgetForBranch.
 *
 *  `pop` is OPTIONAL and that is load-bearing, not politeness: every
 *  caller that predates the population rule passes nothing, menPerMonth
 *  answers MEN_PER_MONTH, and the returned cap is the flat one this
 *  parameter is absent from — bit-for-bit the population-free rule at
 *  whatever rate MEN_PER_MONTH currently names. That makes the
 *  pre-population tests the standing regression suite for the fail-open
 *  path; they track the constant's VALUE, not its history, which is why
 *  the 15000 → 10000 cut moved their expected numbers rather than leaving
 *  them alone — the flat cap IS MEN_PER_MONTH.
 *
 *  The navy is untouched by population: SHIPS_PER_MONTH is flat, and
 *  `pop` never reaches this branch at all. */
export function raiseBudget(branch, lastTurnDays, pop) {
  const perMonth = branch === 'navy' ? SHIPS_PER_MONTH : menPerMonth(pop);
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
 *  recruits already sitting in the sum.
 *
 *  `popByNation` is OPTIONAL: Record<nation, number> | undefined. Omit it
 *  and both population rules switch off — the monthly cap reverts to the
 *  flat MEN_PER_MONTH and the standing ceiling to Infinity — which is
 *  what every pre-population caller does and why they are unaffected.
 *  Supply it and a nation MISSING from it resolves to 0 rather than to
 *  undefined: absence of the whole table is "we don't know", absence of
 *  one nation from a table we do have is a real answer, and it lands that
 *  nation on the MIN_MEN_PER_MONTH floor for both rules.
 *
 *  ANCHORED AT TURN START, by construction. The caller reads population
 *  from public/data/turn.json, which is written only on a turn advance
 *  and whose fields players are already blocked from touching
 *  (worker/src/index.ts:775-797) — so a nation cannot conquer a province
 *  mid-turn and spend the new people in the same turn, and cannot lose
 *  one and have its army retroactively become illegal. The number is
 *  admin-asserted exactly like turnNumber and lastTurnDays sitting beside
 *  it; an admin who could forge it can already edit the force files
 *  directly, so it adds no authority anyone did not have.
 *
 *  ponytail: admin-asserted is the ceiling here. Upgrade path: have the
 *  gates recompute population from state.json ownerships crossed with a
 *  fid-indexed population array and reject on mismatch, which needs
 *  `effectiveOwnerships = isAdmin ? snapshot.ownerships : mainState.ownerships`
 *  mirroring effectiveLastTurnDays at worker/src/index.ts:745-747. Not
 *  done because it costs a join from adm1_code to _fid that NO server
 *  currently performs, a new worker-side file read, and a re-bake — for a
 *  value the same admin could simply have written correctly. */
export function checkRaiseBudgets(forcesByNation, lastTurnDays, popByNation) {
  const months = turnMonths(lastTurnDays);
  const days = Math.max(0, lastTurnDays);
  // Sorted so two consumers reporting the same violation name the same
  // nation first — deterministic messages are testable messages.
  for (const nation of Object.keys(forcesByNation).sort()) {
    // Absence of the table and absence of a nation from it are different
    // questions with different answers, and this one line is where that
    // distinction is made: no table at all stays undefined and fails open
    // through menPerMonth/standingArmyCeiling; a nation the table simply
    // does not list is 0, a real (if unflattering) population.
    const pop = popByNation === undefined ? undefined : (popByNation[nation] ?? 0);
    const spent = { army: 0, navy: 0 };
    let standing = 0;
    for (const f of forcesByNation[nation] || []) {
      // Bucketed by CURRENT branch: a re-branded force bills the pool it
      // moved into, which is the pool its new hulls or men now sit in.
      // Unknown branches bucket as army, same fallback as raiseBudget.
      spent[f.branch === 'navy' ? 'navy' : 'army'] += raiseCost(f);
      // STOCK, not growth — deliberately a different quantity from
      // raiseCost: every man standing under the army brand right now,
      // whenever and however he was raised. Keyed off the CURRENT branch
      // like spent is, because a force branded navy is ships and ships
      // are not men; and matching that fallback exactly means a force
      // that bills the army pool is also counted in the army stock,
      // never one without the other.
      if (f.branch !== 'navy') standing += f.strength;
    }
    for (const branch of ['army', 'navy']) {
      const total = spent[branch];
      if (total <= 0) continue;
      // Army only, and the ceiling outranks the monthly cap: a nation
      // over its ceiling hears about the ceiling, because trimming to the
      // monthly cap would not fix it. The navy has no ceiling — hulls are
      // limited by yards, not by people — so it never reaches this.
      //
      // Sitting AFTER the `total <= 0` guard is what makes the rule safe
      // rather than merely lenient, and the reason is a theorem worth
      // writing down. For any army force, strength <= turnStartStrength +
      // raiseCost(f) (reinforcement bills the difference; a re-branded
      // force has strength === raiseCost(f) exactly). Summing over the
      // nation's army: standing <= sum(army anchors) + spent.army. And
      // checkAnchorConservation independently bounds that anchor sum by
      // what the SAME force ids were anchored at in base. So spent.army
      // === 0 implies the army cannot have grown this turn, and skipping
      // the ceiling test at zero spend cannot let any growth through —
      // the ceiling borrows its soundness from conservation and opens no
      // new attack surface.
      //
      // What that buys is the case this rule must not break: a nation
      // that loses territory can fall UNDER its own ceiling having done
      // nothing wrong (sweden without Finland: 100,000 standing against an
      // 82,629 ceiling). It is over, it cannot recruit — and it can still
      // move, split, disband, take losses and advance the turn, because
      // none of those spend army budget and so none of them reach here.
      // Shrinking back into compliance is possible; being bricked is not.
      if (branch === 'army') {
        const ceiling = standingArmyCeiling(pop);
        if (standing > ceiling) {
          // The percent is DERIVED from the constant, never spelled out:
          // a hardcoded "3.5" silently lies the next time the share moves,
          // and this sentence is what a player reads in a PR rejection.
          //
          // But not the bare `MAX_ARMY_POP_SHARE * 100` this used to
          // interpolate, because that was only ever correct by luck of the
          // binary representation: 0.04·100 is exactly 4, while 0.035·100
          // is 3.5000000000000004 and the rejection would have read "may
          // never exceed 3.5000000000000004%". toFixed(4) rounds the dust
          // away with four decimal places of percent (six of share) still
          // in hand, and the unary + drops the zeros toFixed pads with, so
          // a whole-number share renders "4%" rather than "4.0000%" — the
          // reason a plain toFixed(1) is not enough on its own.
          return `${nation} exceeded its standing army ceiling: ${standing} men under arms, but a population of ${pop} supports at most ${ceiling} — an army may never exceed ${+(MAX_ARMY_POP_SHARE * 100).toFixed(4)}% of the nation it is raised from`;
        }
      }
      const cap = raiseBudget(branch, lastTurnDays, pop);
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

/** Ids this force was split from, or absorbed by merging. Written by the
 *  client (SPLIT_FORCE stamps the parent, MERGE_FORCE stamps everything it
 *  consumed) and read by both gates below, so it is FILTERED rather than
 *  trusted: a missing field, a non-array, or an array with junk in it all
 *  degrade to "no sources", which is the STRICT end of both rules — an
 *  unvouched force may not have marched, and an uncredited anchor bills its
 *  whole strength. Garbage therefore costs the submitter, never the game. */
function fromIdsOf(f) {
  return Array.isArray(f.fromIds) ? f.fromIds.filter((s) => typeof s === 'string') : [];
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
  for (const [nation, forces] of Object.entries(baseForcesByNation)) {
    for (const f of forces || []) baseById.set(f.id, { ...anchorOf(f), nation });
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
      // A MERGE folds several forces into one id, so the survivor's anchor
      // is the SUM of theirs — its own base allowance is short by exactly
      // what it absorbed, and every merge would read as inflation. fromIds
      // funds the difference on the same spend-once terms as the pairing
      // above: each base anchor funds ONE head force and is then gone, so
      // naming an id twice — or naming one that is still standing in its
      // own right — starves whichever force is scored second.
      //
      // SAME NATION ONLY, and unlike the identity pairing that is not
      // paranoia but a denial-of-service fix. Ids are indexed flat across
      // every nation file (deliberately, so RENAME_COUNTRY still pairs), so
      // without this a player could name FRANCE's force id inside their own
      // file, spend france's allowance, and bounce france's next submission
      // for inflation it never committed. A player can only write their own
      // file, so same-nation credit is the entire legitimate use.
      //
      // ponytail: a merge landing in the same PR as an admin RENAME_COUNTRY
      // loses its credit — base still files those ids under the old name —
      // and is rejected. Upgrade path: match against the ids the rename is
      // carrying. Not built: the two are separate PRs in practice, and the
      // failure is a rejection rather than a silent free anchor.
      for (const src of fromIdsOf(f)) {
        const from = baseById.get(src);
        if (from && from.branch === anchor.branch && from.nation === nation) {
          allowance[anchor.branch] += from.strength;
          baseById.delete(src);
        }
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

/** ONE MOVE PER FORCE PER TURN. The distance of that one move is still the
 *  branch budget — this gate says nothing about how far, only how often.
 *
 *  kmMovedThisTurn IS the flag; no field was added for this. It is 0 at
 *  turn start (ADVANCE_TURN resets it) and non-zero the instant a force
 *  marches, and it cannot be under-reported because the per-force
 *  displacement check that runs alongside this one pins it from below.
 *  Over-reporting is possible and simply locks the reporter harder.
 *
 *  Every head force is scored against the most-travelled force it can
 *  point at — itself as BASE knew it, plus anything it was split from or
 *  merged with (fromIds). Three rules, in the order they are cheapest to
 *  fail:
 *
 *    1. Nothing vouches for it → it may not have marched at all. This is
 *       what stops a fabricated id (or a split that hides its parent) from
 *       arriving with a march already on the clock.
 *    2. It may not report LESS travel than its sources account for —
 *       either their own odometers, or the ground between their turn-start
 *       anchors and where this force now stands. A split hands the parent's
 *       odometer to the detachment, and a merge bills the distance the
 *       consumed force walked to the rendezvous, so neither is a way to
 *       launder a march or to teleport men into a stationary stack.
 *    3. If that worst source had already marched, the force stays exactly
 *       where that source stood. This is the lock proper.
 *
 *  Rule 2 is also the whole of the merge rule: the survivor inherits the
 *  WORST case, so combining a fresh force with a spent one yields a spent
 *  one. There is no merge-specific code anywhere in this file.
 *
 *  UNIVERSAL — admins are not exempt, by explicit design call. An admin
 *  fixing a misdrop waits for the turn to advance, same as everyone.
 *
 *  Callers own the turn-advance exception, exactly as they do for
 *  checkAnchorConservation: an advance legitimately resets every odometer
 *  to 0, which is rule 2's definition of laundering. Call both gates from
 *  inside the same "turn number unchanged" branch.
 *
 *  ponytail: sources are named by the submitter, so a hand-crafted PR can
 *  point fromIds at some other unmoved force it never split from and shake
 *  off rule 3. It is not free — the real parent's anchor then funds nothing,
 *  so the detachment bills its FULL strength against the nation's monthly
 *  recruitment cap — which prices the trick at roughly a turn of recruitment
 *  for one extra leg by a token unit. Upgrade path: require every source to
 *  sit at the claiming force's turn-start anchor, which makes a forged
 *  parent geometrically impossible rather than merely expensive. */
export function checkMoveLock(baseForcesByNation, headForcesByNation) {
  // Flat id index for the same reason checkAnchorConservation uses one: a
  // RENAME_COUNTRY carries whole ids into a differently-named file, and
  // pairing by nation+id would read every one of them as brand new.
  const baseById = new Map();
  for (const forces of Object.values(baseForcesByNation)) {
    for (const f of forces || []) baseById.set(f.id, f);
  }
  // Same sorted walk as the two gates above so all three name the same
  // first offender.
  for (const nation of Object.keys(headForcesByNation).sort()) {
    for (const f of headForcesByNation[nation] || []) {
      // Two separate quantities, and keeping them apart is the whole
      // correctness of this loop. `need` is the march this force must own
      // up to; `pin` is a spot it may not have left. A source that walks
      // INTO a merge contributes to the first and must not contribute to
      // the second, or every legitimate merge would be rejected for not
      // standing where the force it absorbed used to be.
      let vouched = false;
      let need = 0;
      let pin = null;
      for (const id of [f.id, ...fromIdsOf(f)]) {
        const src = baseById.get(id);
        if (!src) continue;
        vouched = true;
        // Base is content main already accepted, but it predates this gate,
        // so a legacy force with no odometer reads as unmarched rather than
        // as NaN — which would lose every comparison below and switch the
        // lock off for exactly the forces least able to defend themselves.
        const srcKm = typeof src.kmMovedThisTurn === 'number' ? src.kmMovedThisTurn : 0;
        // The geometric half is what makes a merge cost what it should. The
        // consumed force is gone from head, so the only evidence of its
        // journey is the gap between the anchor BASE has for it and where
        // the survivor now stands — which is exactly the ground it had to
        // cover to get there. Without this, naming a distant force in
        // fromIds folds its men into a stationary one for free: a
        // teleport wearing a disband's clothes, and anchor conservation
        // waves it through precisely because the lineage credit is real.
        // Reading the anchor from BASE rather than from f also pins the
        // anchor itself, so forging turnStart on the survivor buys nothing.
        need = Math.max(
          need,
          srcKm,
          haversineKm(src.turnStartLat, src.turnStartLon, f.lat, f.lon),
        );
        // Only a source that had ALREADY marched before this submission
        // pins anything, and the furthest-travelled one wins.
        if (srcKm > MOVEMENT_TOLERANCE_KM && (pin === null || srcKm > pin.km)) {
          pin = { km: srcKm, lat: src.lat, lon: src.lon };
        }
      }
      if (!vouched) {
        if (f.kmMovedThisTurn > MOVEMENT_TOLERANCE_KM) {
          return `force ${f.id} (${nation}) reports ${Math.round(f.kmMovedThisTurn)} km marched this turn, but neither it nor anything it was split from or merged with is on main — refresh the page and resubmit`;
        }
        continue;
      }
      if (f.kmMovedThisTurn < need - MOVEMENT_TOLERANCE_KM) {
        return `force ${f.id} (${nation}) reports ${Math.round(f.kmMovedThisTurn)} km marched this turn, but ${Math.round(need)} km is already accounted for on main — splitting or merging cannot discard a march`;
      }
      if (pin !== null && haversineKm(pin.lat, pin.lon, f.lat, f.lon) > MOVEMENT_TOLERANCE_KM) {
        return `force ${f.id} (${nation}) has already marched this turn — a force moves once per turn, and cannot move again until the turn advances`;
      }
    }
  }
  return null;
}

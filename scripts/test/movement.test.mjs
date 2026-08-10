// Unit tests for the pure helpers in scripts/lib/movement.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMY_KM_PER_DAY,
  NAVY_KM_PER_DAY,
  MOVEMENT_TOLERANCE_KM,
  MEN_PER_MONTH,
  SHIPS_PER_MONTH,
  budgetForBranch,
  checkAnchorConservation,
  checkRaiseBudgets,
  daysBetween,
  haversineKm,
  raiseBudget,
  raiseCost,
  turnMonths,
} from '../lib/movement.mjs';

test('constants: army & navy km/day match spec', () => {
  assert.equal(ARMY_KM_PER_DAY, 25);
  assert.equal(NAVY_KM_PER_DAY, 200);
  assert.equal(MOVEMENT_TOLERANCE_KM, 0.1);
});

test('budgetForBranch: army × 30 days = 750 km', () => {
  assert.equal(budgetForBranch('army', 30), 750);
});

test('budgetForBranch: navy × 30 days = 6000 km', () => {
  assert.equal(budgetForBranch('navy', 30), 6000);
});

test('budgetForBranch: unknown branch defaults to army rate (safer cap)', () => {
  assert.equal(budgetForBranch('cavalry', 30), 750);
  assert.equal(budgetForBranch(undefined, 10), 250);
});

test('budgetForBranch: zero days = zero budget', () => {
  assert.equal(budgetForBranch('army', 0), 0);
});

test('budgetForBranch: negative days clamp to zero', () => {
  assert.equal(budgetForBranch('army', -5), 0);
});

test('daysBetween: trivial one-month bump', () => {
  assert.equal(daysBetween('1680-01-01', '1680-01-31'), 30);
});

test('daysBetween: year bump accounts for leap year', () => {
  // 1680 was a leap year.
  assert.equal(daysBetween('1680-01-01', '1681-01-01'), 366);
});

test('daysBetween: same date = 0', () => {
  assert.equal(daysBetween('1680-03-15', '1680-03-15'), 0);
});

test('daysBetween: negative when reversed', () => {
  assert.equal(daysBetween('1680-02-01', '1680-01-01'), -31);
});

test('daysBetween: malformed input returns 0', () => {
  assert.equal(daysBetween('not-a-date', '1680-01-01'), 0);
  assert.equal(daysBetween('1680-01-01', ''), 0);
});

test('haversineKm: zero distance on identical points', () => {
  assert.equal(haversineKm(40.4, -3.7, 40.4, -3.7), 0);
});

test('haversineKm: Madrid → Paris is ~1050 km', () => {
  const d = haversineKm(40.4168, -3.7038, 48.8566, 2.3522);
  assert.ok(Math.abs(d - 1053) < 5, `expected ~1053 km, got ${d}`);
});

test('haversineKm: London → New York is ~5570 km', () => {
  const d = haversineKm(51.5074, -0.1278, 40.7128, -74.006);
  assert.ok(Math.abs(d - 5570) < 10, `expected ~5570 km, got ${d}`);
});

// ────────────────────────────────────────────────────────────────────
// Recruitment budgets
//
// The whole cap is derived from turn length, so the month flooring is
// tested first and everything summed on top of it second. The reason
// strings are asserted verbatim: the worker and the validator both emit
// them, and a player reads them as the explanation for a rejection, so
// they are contract, not incidental formatting.
//
// The cost model is the anchor model: turnStartStrength is what the
// force had at the START of the turn, so "raised this turn" is spelled
// as an anchor of 0, not as a createdAtTurn flag. Fixtures below say
// which of the two they mean in exactly that way.
// ────────────────────────────────────────────────────────────────────

/** Minimal force shape — only the fields the two gates read.
 *  turnStartBranch follows branch by default: a force that has not
 *  re-branded started the turn in the branch it is in now, so the
 *  re-brand clause stays out of the way unless a test asks for it.
 *  The id defaults to a fresh one per call because checkAnchorConservation
 *  pairs base to head BY ID: two fixtures that share an id are the same
 *  force, and two that do not are strangers. A shared default would make
 *  every fixture force the same force and quietly collapse the base index
 *  to one entry, so conservation tests below always name their ids. */
let nextUnitId = 0;
function unit(overrides = {}) {
  const branch = overrides.branch ?? 'army';
  return {
    id: `unit-${nextUnitId++}`,
    branch, strength: 0, turnStartStrength: 0, turnStartBranch: branch,
    ...overrides,
  };
}

test('turnMonths: whole months only — 29d buys nothing, 30d buys one', () => {
  assert.equal(turnMonths(29), 0);
  assert.equal(turnMonths(30), 1);
  assert.equal(turnMonths(59), 1);
  assert.equal(turnMonths(60), 2);
  assert.equal(turnMonths(90), 3);
});

test('turnMonths: negative days clamp to zero (no negative cap)', () => {
  assert.equal(turnMonths(-30), 0);
});

test('raiseBudget: a 30-day turn buys 15000 men or 1 ship', () => {
  assert.equal(raiseBudget('army', 30), MEN_PER_MONTH);
  assert.equal(raiseBudget('navy', 30), SHIPS_PER_MONTH);
  assert.equal(MEN_PER_MONTH, 15000);
  assert.equal(SHIPS_PER_MONTH, 1);
});

test('raiseBudget: a 60-day turn doubles both pools', () => {
  assert.equal(raiseBudget('army', 60), 30000);
  assert.equal(raiseBudget('navy', 60), 2);
});

test('raiseBudget: a turn shorter than a month buys nothing at all', () => {
  assert.equal(raiseBudget('army', 29), 0);
  assert.equal(raiseBudget('navy', 29), 0);
});

test('raiseBudget: unknown branch falls back to the army rate, like budgetForBranch', () => {
  assert.equal(raiseBudget('cavalry', 30), MEN_PER_MONTH);
  assert.equal(raiseBudget(undefined, 30), MEN_PER_MONTH);
});

test('raiseCost: a force raised this turn has a zero anchor and charges its whole strength', () => {
  // "Raised this turn" is not a flag any more, it is what an anchor of 0
  // means: the force held nothing at turn start, so all 15000 are new.
  assert.equal(raiseCost(unit({ strength: 15000, turnStartStrength: 0 })), 15000);
});

test('raiseCost: an existing force charges only its growth since turn start', () => {
  // The hole the feature exists to close: reinforcing 20k → 25k is a
  // 5000-man raise, not a free edit.
  assert.equal(raiseCost(unit({ strength: 25000, turnStartStrength: 20000 })), 5000);
});

test('raiseCost: losses are free and bank no headroom', () => {
  assert.equal(raiseCost(unit({ strength: 8000, turnStartStrength: 20000 })), 0);
});

test('raiseCost: the backfilled legacy order of battle (anchor == strength) is free', () => {
  // The grandfather path: every force baked before this rule carries an
  // anchor equal to its strength, so the standing army costs nothing.
  assert.equal(raiseCost(unit({ strength: 40000, turnStartStrength: 40000 })), 0);
});

test('raiseCost: createdAtTurn has no say in the cost — only the anchor does', () => {
  // Same strength, same turn stamp, opposite anchors: the stamp is now
  // purely the movement lock, so it must not move either number.
  assert.equal(raiseCost(unit({ strength: 40000, turnStartStrength: 40000, createdAtTurn: 0 })), 0);
  assert.equal(raiseCost(unit({ strength: 40000, turnStartStrength: 0, createdAtTurn: 0 })), 40000);
  // And no second argument exists to pass a turn number to.
  assert.equal(raiseCost.length, 1);
});

test('raiseCost: a re-branded force pays full strength in the pool it entered', () => {
  // A 40000-man army edited to navy/40 would score max(0, 40 - 40000) = 0
  // on the bare subtraction and land 40 ships for free. The anchor was
  // earned in the army, so against the navy this force is brand new.
  assert.equal(
    raiseCost(unit({ branch: 'navy', turnStartBranch: 'army', strength: 40, turnStartStrength: 40000 })),
    40,
  );
});

test('raiseCost: re-branding the other way bills men, not ships', () => {
  assert.equal(
    raiseCost(unit({ branch: 'army', turnStartBranch: 'navy', strength: 40000, turnStartStrength: 40 })),
    40000,
  );
});

test('checkRaiseBudgets: an empty record is always inside budget', () => {
  assert.equal(checkRaiseBudgets({}, 30), null);
});

test('checkRaiseBudgets: army and navy are independent pools', () => {
  // A 30-day turn buys 15000 men AND 1 ship — spending one pool to the
  // last man must not eat into the other.
  const forces = {
    spain: [
      unit({ branch: 'army', strength: 15000, turnStartStrength: 0 }),
      unit({ branch: 'navy', strength: 1, turnStartStrength: 0 }),
    ],
  };
  assert.equal(checkRaiseBudgets(forces, 30), null);
});

test('checkRaiseBudgets: navy overspend is reported in ships, not men', () => {
  const forces = {
    spain: [unit({ branch: 'navy', strength: 2, turnStartStrength: 0 })],
  };
  assert.equal(
    checkRaiseBudgets(forces, 30),
    'spain exceeded its navy recruitment cap: 2 ships raised or reinforced this turn, cap is 1 ships for a 1-month turn',
  );
});

test('checkRaiseBudgets: a re-branded army lands in the NAVY pool and busts the 1-ship cap', () => {
  // End of the exploit: the cost is bucketed by CURRENT branch, so the
  // 40 hulls this force turned into are scored against the navy cap.
  const forces = {
    spain: [unit({ branch: 'navy', turnStartBranch: 'army', strength: 40, turnStartStrength: 40000 })],
  };
  assert.equal(
    checkRaiseBudgets(forces, 30),
    'spain exceeded its navy recruitment cap: 40 ships raised or reinforced this turn, cap is 1 ships for a 1-month turn',
  );
});

test('checkRaiseBudgets: cumulative — separate forces sum against one cap', () => {
  // This is what makes the cap survive multiple PRs in a turn: the second
  // submission still sees the first submission's force in the array.
  const forces = {
    spain: [
      unit({ strength: 10000, turnStartStrength: 0 }),
      unit({ strength: 6000, turnStartStrength: 0 }),
    ],
  };
  assert.equal(
    checkRaiseBudgets(forces, 30),
    'spain exceeded its army recruitment cap: 16000 men raised or reinforced this turn, cap is 15000 men for a 1-month turn',
  );
});

test('checkRaiseBudgets: raising and reinforcing draw on the same pool', () => {
  const forces = {
    spain: [
      unit({ strength: 9000, turnStartStrength: 0 }),
      unit({ strength: 47000, turnStartStrength: 40000 }),
    ],
  };
  assert.equal(
    checkRaiseBudgets(forces, 30),
    'spain exceeded its army recruitment cap: 16000 men raised or reinforced this turn, cap is 15000 men for a 1-month turn',
  );
});

test('checkRaiseBudgets: a sub-month turn refuses any raise, with its own message', () => {
  // The dash is a literal em dash (U+2014), matching the displacement
  // message in validate-move-core.mjs. Asserted verbatim so a stray
  // hyphen shows up here rather than in a player's rejection comment.
  const forces = {
    britain: [unit({ branch: 'navy', strength: 2, turnStartStrength: 0 })],
  };
  assert.equal(
    checkRaiseBudgets(forces, 14),
    'britain cannot raise or reinforce its navy this turn: 2 ships requested but the turn is only 14 days — shorter than a month, so the cap is 0 ships',
  );
});

test('checkRaiseBudgets: a nation that only took losses passes even a 0-cap turn', () => {
  const forces = {
    spain: [unit({ strength: 5000, turnStartStrength: 40000 })],
  };
  assert.equal(checkRaiseBudgets(forces, 14), null);
});

test('checkRaiseBudgets: the whole legacy order of battle costs nothing (grandfathered)', () => {
  // Every backfilled force carries anchor == strength, so a nation that
  // did nothing this turn spends nothing — even on a 0-cap turn.
  const forces = {
    spain: [
      unit({ strength: 40000, turnStartStrength: 40000 }),
      unit({ branch: 'navy', strength: 22, turnStartStrength: 22 }),
    ],
  };
  assert.equal(checkRaiseBudgets(forces, 14), null);
});

test('checkRaiseBudgets: first offender is deterministic (nations sorted, army first)', () => {
  // Both nations bust both pools; insertion order puts spain first, but
  // the sorted walk must still name france's army — worker and validator
  // have to agree on the message for identical input.
  const bust = () => [
    unit({ branch: 'army', strength: 99000, turnStartStrength: 0 }),
    unit({ branch: 'navy', strength: 9, turnStartStrength: 0 }),
  ];
  const reason = checkRaiseBudgets({ spain: bust(), france: bust() }, 30);
  assert.match(reason, /^france exceeded its army recruitment cap/);
});

// ────────────────────────────────────────────────────────────────────
// Anchor conservation
//
// The cap above subtracts a number the client asserts. This is what
// keeps that number honest: every head force is paired to its base self
// BY ID, and a nation's per-branch anchor total may not exceed what
// exactly those same forces were anchored at in base. An id base never
// saw funds nothing, so a fabricated anchor has nowhere to have come
// from — and pairing by id ALONE, never nation+id, is what lets a
// renamed country carry whole ids into a file that had no anchors at all.
//
// The rule is a per-branch TOTAL over the paired forces, not per-force
// equality, because a split has to be free to move anchor from parent to
// detachment. Anchors bucket by turnStartBranch (the branch they were
// earned in), NOT by current branch — otherwise an honest re-brand, which
// raiseCost already bills in full, would also trip this gate.
//
// There is no turnNumber parameter: on a turn advance every anchor is
// supposed to jump up to current strength, and callers skip the whole
// call for that submission (pinned end-to-end in validate-move.test.mjs).
//
// Every fixture below names its ids, because an id is the only thing
// that says whether a base force and a head force are the same force.
// ────────────────────────────────────────────────────────────────────

test('checkAnchorConservation: an untouched order of battle conserves', () => {
  const forces = { spain: [unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 })] };
  assert.equal(checkAnchorConservation(forces, forces), null);
});

test('checkAnchorConservation: RENAME — a renamed country carries its ids into a file that had none', () => {
  // RENAME_COUNTRY rewrites force.nation, so every id moves from
  // forces/spain.json into forces/hispania.json with its anchor untouched.
  // The receiving nation had nothing at base; only an index keyed by id
  // alone can see these are the same forces, and this is the case that
  // motivated pairing — a per-nation sum rejects a shipped admin feature.
  const carried = unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 });
  const base = { spain: [carried], france: [unit({ id: 'france-1', strength: 30000, turnStartStrength: 30000 })] };
  const head = { hispania: [carried] };
  assert.equal(checkAnchorConservation(base, head), null);
});

test('checkAnchorConservation: SPLIT — parent and detachment share the parent\'s anchor', () => {
  // The detachment's id is unknown to base and funds nothing, but the
  // parent's whole 40000 is still on offer, so the two halves may
  // partition it. This is why the rule totals per branch instead of
  // demanding per-force equality: nothing in the data says which force is
  // whose child.
  const base = { spain: [unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 })] };
  const head = {
    spain: [
      unit({ id: 'spain-1', strength: 25000, turnStartStrength: 25000 }),
      unit({ id: 'alice-1700000000000-0', strength: 15000, turnStartStrength: 15000 }),
    ],
  };
  assert.equal(checkAnchorConservation(base, head), null);
});

test('checkAnchorConservation: RAISED THIS TURN — a zero anchor adds nothing to either side', () => {
  // The legitimate way to grow: raiseCost bills the 15000, the anchor
  // contributes 0 to the total and 0 to the allowance, so the two gates
  // cover each other.
  const base = { spain: [unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 })] };
  const head = {
    spain: [
      unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 }),
      unit({ id: 'alice-1700000000000-0', strength: 15000, turnStartStrength: 0 }),
    ],
  };
  assert.equal(checkAnchorConservation(base, head), null);
});

test('checkAnchorConservation: DELETION — a disbanded force drops out of both totals together', () => {
  const base = {
    spain: [
      unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 }),
      unit({ id: 'spain-2', strength: 10000, turnStartStrength: 10000 }),
    ],
  };
  const head = { spain: [unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 })] };
  assert.equal(checkAnchorConservation(base, head), null);
});

test('checkAnchorConservation: INJECTED ANCHOR — a new force with a fat anchor is rejected', () => {
  // The free-recruit dodge: a brand-new 15000-man force that claims it
  // was already 15000 strong at turn start costs 0 through raiseCost. Its
  // id is the tell — base never saw it, so it funds nothing.
  const base = { spain: [unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 })] };
  const head = {
    spain: [
      unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 }),
      unit({ id: 'alice-1700000000000-0', strength: 15000, turnStartStrength: 15000 }),
    ],
  };
  assert.equal(
    checkAnchorConservation(base, head),
    'spain inflated its army turn-start strength: its anchors total 55000 men in this submission but the same forces were anchored at 40000 men at the start of the turn — anchors may be split or dropped within a turn, never invented or raised',
  );
});

test('checkAnchorConservation: INFLATED ANCHOR — editing an existing force\'s anchor up is rejected', () => {
  // The other half of the same dodge: reinforce 40000 → 60000 and move
  // the anchor up with it so raiseCost sees no growth at all. The id
  // pairs, but it only funds the 40000 it actually carried.
  const base = { spain: [unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 })] };
  const head = { spain: [unit({ id: 'spain-1', strength: 60000, turnStartStrength: 60000 })] };
  assert.equal(
    checkAnchorConservation(base, head),
    'spain inflated its army turn-start strength: its anchors total 60000 men in this submission but the same forces were anchored at 40000 men at the start of the turn — anchors may be split or dropped within a turn, never invented or raised',
  );
});

test('checkAnchorConservation: FREED-ANCHOR SHUFFLE — a mauled force\'s anchor cannot also fund a new one', () => {
  // The ceiling pairing closes. A force mauled 40000 → 10000 keeps its
  // 40000 anchor (it is allowed to regrow into it), but that anchor
  // belongs to that id and to nothing else: spending it a SECOND time on
  // a force base never saw doubles the total against an unchanged 40000.
  const base = { spain: [unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 })] };
  const head = {
    spain: [
      unit({ id: 'spain-1', strength: 10000, turnStartStrength: 40000 }),
      unit({ id: 'alice-1700000000000-0', strength: 40000, turnStartStrength: 40000 }),
    ],
  };
  assert.equal(
    checkAnchorConservation(base, head),
    'spain inflated its army turn-start strength: its anchors total 80000 men in this submission but the same forces were anchored at 40000 men at the start of the turn — anchors may be split or dropped within a turn, never invented or raised',
  );
});

test('checkAnchorConservation: a disbanded force\'s anchor cannot be recycled onto a new one', () => {
  // The same shuffle in the shape the old per-nation SUM genuinely waved
  // through: disband spain-2 and mint a new force carrying exactly its
  // 10000 anchor, and the nation's sum is unchanged at 50000 — 10000 free
  // men. Paired by id, spain-2 is gone from head so its allowance goes
  // with it, and the newcomer funds nothing.
  const base = {
    spain: [
      unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 }),
      unit({ id: 'spain-2', strength: 10000, turnStartStrength: 10000 }),
    ],
  };
  const head = {
    spain: [
      unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 }),
      unit({ id: 'alice-1700000000000-0', strength: 10000, turnStartStrength: 10000 }),
    ],
  };
  assert.equal(
    checkAnchorConservation(base, head),
    'spain inflated its army turn-start strength: its anchors total 50000 men in this submission but the same forces were anchored at 40000 men at the start of the turn — anchors may be split or dropped within a turn, never invented or raised',
  );
});

test('checkAnchorConservation: a base anchor funds ONE head force, not one per copy of its id', () => {
  // Cloning a force under its own id. Both copies pair to the same base
  // entry, so an allowance that merely READ the index would count 40000
  // twice and wave through a free second army — each copy bills 0 through
  // raiseCost, since each carries anchor == strength. The CI validator
  // rejects duplicate ids before it ever reaches this gate, but the worker
  // has no such check and a client that omits `baseline` skips the rebase
  // that would otherwise dedupe by id, so the gate has to stand alone.
  const base = { spain: [unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 })] };
  const head = {
    spain: [
      unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 }),
      unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 }),
    ],
  };
  assert.equal(
    checkAnchorConservation(base, head),
    'spain inflated its army turn-start strength: its anchors total 80000 men in this submission but the same forces were anchored at 40000 men at the start of the turn — anchors may be split or dropped within a turn, never invented or raised',
  );
});

test('checkAnchorConservation: the same id in two nation files funds only the first', () => {
  // The cross-file shape of the clone above: an admin filing one id under
  // two nations. Sorted-nation order decides which one gets the anchor, so
  // the message is deterministic — france is walked first and keeps it.
  const base = { spain: [unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 })] };
  const head = {
    spain: [unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 })],
    france: [unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 })],
  };
  assert.equal(
    checkAnchorConservation(base, head),
    'spain inflated its army turn-start strength: its anchors total 40000 men in this submission but the same forces were anchored at 0 men at the start of the turn — anchors may be split or dropped within a turn, never invented or raised',
  );
});

test('checkAnchorConservation: ANCHOR BRANCH FLIP — an id that changes turnStartBranch funds nothing', () => {
  // Same id, but base says the anchor was earned in the army and head
  // claims the navy. It pairs into a bucket its base anchor is not in, so
  // that bucket's allowance is 0 and the 40 hulls have nothing behind
  // them. Legitimate only across a turn advance, where callers skip the
  // gate outright.
  const base = { spain: [unit({ id: 'spain-1', branch: 'army', strength: 40000, turnStartStrength: 40000 })] };
  const head = {
    spain: [unit({ id: 'spain-1', branch: 'navy', turnStartBranch: 'navy', strength: 40, turnStartStrength: 40 })],
  };
  assert.equal(
    checkAnchorConservation(base, head),
    'spain inflated its navy turn-start strength: its anchors total 40 ships in this submission but the same forces were anchored at 0 ships at the start of the turn — anchors may be split or dropped within a turn, never invented or raised',
  );
});

test('checkAnchorConservation: COLLUDING TRANSFER — once the donor\'s removal has merged, the id funds nothing', () => {
  // Two nations, two PRs. This is the ordering where spain's PR emptying
  // spain.json landed first: base no longer holds spain-1 anywhere, so
  // the 40000 it carries into france.json has no counterpart at turn
  // start. The other ordering — donor still holding the id, so it sits in
  // two nation files at once — is rejected by the duplicate-id check
  // before this gate is reached, and is pinned in validate-move.test.mjs.
  const base = { spain: [], france: [unit({ id: 'france-1', strength: 40000, turnStartStrength: 40000 })] };
  const head = {
    france: [
      unit({ id: 'france-1', strength: 40000, turnStartStrength: 40000 }),
      unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 }),
    ],
  };
  assert.equal(
    checkAnchorConservation(base, head),
    'france inflated its army turn-start strength: its anchors total 80000 men in this submission but the same forces were anchored at 40000 men at the start of the turn — anchors may be split or dropped within a turn, never invented or raised',
  );
});

test('checkAnchorConservation: a nation with no forces in base can only submit zero anchors', () => {
  // A brand-new nation file whose ids are new too: nothing funds them, so
  // the only thing it may contain is forces raised this turn — which
  // raiseCost then bills.
  const head = { poland: [unit({ id: 'poland-1', strength: 15000, turnStartStrength: 0 })] };
  assert.equal(checkAnchorConservation({}, head), null);
  const cheat = { poland: [unit({ id: 'poland-1', strength: 15000, turnStartStrength: 15000 })] };
  assert.match(checkAnchorConservation({}, cheat), /^poland inflated its army turn-start strength/);
});

test('checkAnchorConservation: an honest re-brand moves neither total', () => {
  // 22 ships become 22000 men. The anchor stays in the navy bucket on
  // BOTH sides because turnStartBranch says that is where it was earned,
  // so this gate is silent and raiseCost alone decides whether 22000 men
  // fit. Contrast the branch-flip test above, which edits turnStartBranch
  // itself rather than branch.
  const base = { spain: [unit({ id: 'spain-1', branch: 'navy', strength: 22, turnStartStrength: 22 })] };
  const head = {
    spain: [unit({ id: 'spain-1', branch: 'army', turnStartBranch: 'navy', strength: 22000, turnStartStrength: 22 })],
  };
  assert.equal(checkAnchorConservation(base, head), null);
});

test('checkAnchorConservation: pools are independent — navy anchor cannot pay for army anchor', () => {
  const base = {
    spain: [
      unit({ id: 'spain-1', branch: 'army', strength: 40000, turnStartStrength: 40000 }),
      unit({ id: 'spain-2', branch: 'navy', strength: 22, turnStartStrength: 22 }),
    ],
  };
  // Army anchor up by 1, navy fleet disbanded: the 22 ships of allowance
  // that dropped out must not fund the extra man in the other pool.
  const head = {
    spain: [unit({ id: 'spain-1', branch: 'army', strength: 40001, turnStartStrength: 40001 })],
  };
  assert.match(checkAnchorConservation(base, head), /^spain inflated its army turn-start strength/);
});

test('checkAnchorConservation: navy inflation is reported in ships', () => {
  const base = { spain: [unit({ id: 'spain-1', branch: 'navy', strength: 22, turnStartStrength: 22 })] };
  const head = {
    spain: [
      unit({ id: 'spain-1', branch: 'navy', strength: 22, turnStartStrength: 22 }),
      unit({ id: 'alice-1700000000000-0', branch: 'navy', strength: 3, turnStartStrength: 3 }),
    ],
  };
  assert.equal(
    checkAnchorConservation(base, head),
    'spain inflated its navy turn-start strength: its anchors total 25 ships in this submission but the same forces were anchored at 22 ships at the start of the turn — anchors may be split or dropped within a turn, never invented or raised',
  );
});

test('checkAnchorConservation: a base commit predating the anchors falls back to strength', () => {
  // Back-compat with main as it was before the backfill landed: a base
  // force with no turnStartStrength counts as its own strength, so an
  // unchanged order of battle is not read as an inflation. The fallback
  // is shared with the head side so the two cannot drift apart.
  const base = { spain: [{ id: 'spain-1', branch: 'army', strength: 40000 }] };
  const head = { spain: [unit({ id: 'spain-1', strength: 40000, turnStartStrength: 40000 })] };
  assert.equal(checkAnchorConservation(base, head), null);
});

test('checkAnchorConservation: a base fleet predating turnStartBranch stays in the navy pool', () => {
  // The other half of the same back-compat: bucketing a missing
  // turnStartBranch as 'army' would park the fleet's 8 anchor in the army
  // pool, leaving the navy bucket funded at 0 while head totals 8 — an
  // untouched squadron read as navy inflation, in the merge window only.
  const base = { spain: [{ id: 'spain-1', branch: 'navy', strength: 8 }] };
  const head = { spain: [unit({ id: 'spain-1', branch: 'navy', strength: 8, turnStartStrength: 8 })] };
  assert.equal(checkAnchorConservation(base, head), null);
});

test('checkAnchorConservation: nations absent from head are not checked', () => {
  // A submission that touches only spain says nothing about france, and
  // france's own file on main is untouched — nothing to compare.
  const base = { france: [unit({ id: 'france-1', strength: 40000, turnStartStrength: 40000 })] };
  const head = { spain: [unit({ id: 'spain-1', strength: 15000, turnStartStrength: 0 })] };
  assert.equal(checkAnchorConservation(base, head), null);
});

test('checkAnchorConservation: empty and undefined nation arrays are tolerated on both sides', () => {
  // The callers hand this whatever the force files contain, including a
  // nation whose file was emptied and a key that resolved to nothing.
  assert.equal(checkAnchorConservation({}, {}), null);
  assert.equal(checkAnchorConservation({ spain: undefined }, { spain: undefined }), null);
  assert.equal(checkAnchorConservation({ spain: [] }, { spain: [] }), null);
});

test('checkAnchorConservation: first offender is deterministic (nations sorted, army first)', () => {
  // Same walk order as checkRaiseBudgets so the worker and the validator
  // name the same nation and the same branch for identical input.
  const cheat = () => [
    unit({ branch: 'army', strength: 40000, turnStartStrength: 40000 }),
    unit({ branch: 'navy', strength: 5, turnStartStrength: 5 }),
  ];
  const reason = checkAnchorConservation({}, { spain: cheat(), france: cheat() });
  assert.match(reason, /^france inflated its army turn-start strength/);
});

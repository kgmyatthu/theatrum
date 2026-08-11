// Unit tests for the pure helpers in scripts/lib/movement.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ARMY_KM_PER_DAY,
  NAVY_KM_PER_DAY,
  MOVEMENT_TOLERANCE_KM,
  MEN_PER_MONTH,
  SHIPS_PER_MONTH,
  MAX_ARMY_POP_SHARE,
  MIN_MEN_PER_MONTH,
  REFERENCE_POP,
  budgetForBranch,
  checkAnchorConservation,
  checkMoveLock,
  checkRaiseBudgets,
  daysBetween,
  haversineKm,
  menPerMonth,
  raiseBudget,
  raiseCost,
  standingArmyCeiling,
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

// Every raiseBudget block from here to the population section below
// deliberately omits the third (population) argument, and that omission is
// the assertion: it pins the FAIL-OPEN fallback. With no population
// supplied menPerMonth answers the flat MEN_PER_MONTH, so these are
// bit-for-bit the numbers this rule produced before populations existed —
// which is also why the 193 tests that predate the feature needed no edit
// to keep passing. Do not "modernise" these by threading a population
// through: that would delete the only coverage of the path every
// pre-population caller still takes.
test('raiseBudget: a 30-day turn buys 10000 men or 1 ship', () => {
  assert.equal(raiseBudget('army', 30), MEN_PER_MONTH);
  assert.equal(raiseBudget('navy', 30), SHIPS_PER_MONTH);
  assert.equal(MEN_PER_MONTH, 10000);
  assert.equal(SHIPS_PER_MONTH, 1);
});

test('raiseBudget: a 60-day turn doubles both pools', () => {
  assert.equal(raiseBudget('army', 60), 20000);
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
  // A 30-day turn buys 10000 men AND 1 ship — spending one pool to the
  // last man must not eat into the other.
  const forces = {
    spain: [
      unit({ branch: 'army', strength: 10000, turnStartStrength: 0 }),
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
    'spain exceeded its army recruitment cap: 16000 men raised or reinforced this turn, cap is 10000 men for a 1-month turn',
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
    'spain exceeded its army recruitment cap: 16000 men raised or reinforced this turn, cap is 10000 men for a 1-month turn',
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
// Population-derived recruitment: the monthly FLOW and the standing STOCK
//
// Two different quantities, and keeping them apart is the whole design.
// menPerMonth is a FLOW — men a nation may raise per whole month — and it
// scales with cbrt(pop), so china's 293.8M buys 26,956/mo rather than
// out-typing the board 91:1 over sweden — it settles for 4.5:1. (That
// ratio is the curve's, not the rate's: MEN_PER_MONTH is a linear
// multiplier, so cutting it 15000 → 10000 moved both ends by 2/3 and left
// the 4.5:1 between them exactly where it was.)
// standingArmyCeiling is a STOCK — men under arms at once, whenever they
// were raised — and it is a flat 3.5% share, untouched by the curve moving
// from square to cube root and re-priced independently of it (the 4% →
// 3.5% cut multiplied every ceiling by 0.875 and left menPerMonth, which
// never reads the share at all, bit for bit where it was). A nation can
// sit inside its monthly flow
// every single turn and still walk into the stock ceiling; and it can be
// OVER the stock ceiling having raised nothing at all, because losing
// provinces moves the ceiling and not the army.
//
// The two absences are not the same absence, and every gate in the game
// leans on the difference:
//   - no population argument at all → the table does not exist, so the
//     rule is UNENFORCED: flat MEN_PER_MONTH, ceiling Infinity. Fail
//     OPEN. This is what stops a turn.json written before the feature
//     from bricking every submission in the game.
//   - a nation merely MISSING from a table that does exist → a real (if
//     unflattering) answer of 0 people, so the MIN_MEN_PER_MONTH floor
//     for both rules. Fail CLOSED.
//
// The shipped figures are asserted as literals on purpose. They are what
// public/data/turn.json actually contains today, so a re-bake that moves
// a population fails loudly right here instead of quietly handing a
// player a different army — and SHIPPED_POP below is what makes that
// claim true rather than merely stated.
// ────────────────────────────────────────────────────────────────────

// ponytail: a bare readFileSync, no fixture harness and no helper, because
// the literals below are the point and this only has to prove they are
// still real. It exists because the claim above was false for as long as
// nothing checked it: the literals asserted f(105562162) === 39792 and
// labelled it "britain", but no nation in the table has ever had that
// population (britain is 18,082,841; 105.5M was closest to britain plus
// its colonies, and drifted). f(literal) === literal passes forever
// however far the bake moves, so the coupling to production data needs one
// assertion on the INPUT to bite. Cheapest thing that bites: read the file.
const SHIPPED_POP = JSON.parse(
  readFileSync(new URL('../../public/data/turn.json', import.meta.url), 'utf8'),
).populationByNation;

test('the client mirror is still a mirror — constants and bodies, character for character', () => {
  // src/utils/movement.ts is a hand-maintained COPY of the block above it,
  // and its own header has always claimed "the test suite covers the
  // equivalence". That claim was false in exactly the way the SHIPPED_POP
  // one was: nothing read the other file, so nothing could see it drift.
  //
  // The drift this catches is a constant re-priced on one side only, and
  // MAX_ARMY_POP_SHARE is the case that motivated it — 0.04 → 0.035 had to
  // be typed into two files, and a gate that refuses at 3.5% while the
  // panel and the hover card size their promises at 4% is a player told he
  // may raise men the server will bounce. The mirror is what the CLIENT
  // predicts a refusal with; the file above is what actually refuses.
  //
  // TEXTUAL, not behavioural, and deliberately: this is a .mjs runner with
  // no TypeScript in it, so importing the mirror would cost a transpile
  // step and a build dependency to check four constants and five
  // expressions. Reading the source needs neither and bites on precisely
  // the edit that matters. It cannot prove the two files COMPUTE the same
  // thing — only that the lines that do the computing are identical, which
  // is the property a copy has to hold.
  const RULE = readFileSync(new URL('../lib/movement.mjs', import.meta.url), 'utf8');
  const MIRROR = readFileSync(new URL('../../src/utils/movement.ts', import.meta.url), 'utf8');
  // Compared as SOURCE TEXT on both sides rather than against the values
  // imported at the top of this file: only one of the two is importable
  // here, and asserting the mirror against this file's own imports would
  // just be re-checking the side that is already covered.
  const constOf = (src, where, name) => {
    const m = new RegExp(`^export const ${name} = (.+);$`, 'm').exec(src);
    assert.ok(m, `${name} is not declared in ${where}`);
    return m[1];
  };
  for (const name of [
    'ARMY_KM_PER_DAY',
    'NAVY_KM_PER_DAY',
    'MOVEMENT_TOLERANCE_KM',
    'MEN_PER_MONTH',
    'SHIPS_PER_MONTH',
    'REFERENCE_POP',
    'MIN_MEN_PER_MONTH',
    'MAX_ARMY_POP_SHARE',
  ]) {
    assert.equal(
      constOf(MIRROR, 'src/utils/movement.ts', name),
      constOf(RULE, 'scripts/lib/movement.mjs', name),
      `${name} has drifted between the rule and its client mirror`,
    );
  }
  // The two bodies the constants feed. Both guards are included because
  // the fail-open branches are rules in their own right — a mirror that
  // returned 0 instead of Infinity would size a panel against a ceiling
  // the gate is not enforcing.
  for (const line of [
    'if (pop === undefined || !Number.isFinite(pop)) return MEN_PER_MONTH;',
    'const scaled = MEN_PER_MONTH * Math.cbrt(Math.max(0, pop) / REFERENCE_POP);',
    'return Math.max(MIN_MEN_PER_MONTH, Math.round(scaled));',
    'if (pop === undefined || !Number.isFinite(pop)) return Infinity;',
    'return Math.max(MIN_MEN_PER_MONTH, Math.floor(MAX_ARMY_POP_SHARE * Math.max(0, pop)));',
  ]) {
    assert.ok(RULE.includes(line), `scripts/lib/movement.mjs no longer contains: ${line}`);
    assert.ok(MIRROR.includes(line), `src/utils/movement.ts no longer contains: ${line}`);
  }
  // And the asymmetry that is NOT drift: checkRaiseBudgets is a gate, so it
  // belongs to the servers that can refuse a submission and is deliberately
  // absent from the client. Pinned so that "the mirror is missing a
  // function" reads as intended rather than as something to go and fix —
  // and so the reason string, which is a contract, cannot acquire a second
  // copy that drifts from the first. Matched on the DECLARATION, not on the
  // name: the mirror's header discusses the gate at length, and prose about
  // a function is not a second implementation of it.
  assert.ok(
    !/^export function checkRaiseBudgets/m.test(MIRROR),
    'the gate must not be mirrored into the client',
  );
  // Matched on the sentence's own tail rather than on "may never exceed",
  // which the mirror quotes as PROSE for the same reason the rule does —
  // it is why the ceiling floors instead of rounding.
  assert.ok(
    !MIRROR.includes('of the nation it is raised from'),
    'the reason string must have exactly one home',
  );
  assert.ok(RULE.includes('of the nation it is raised from'), 'and that home is the rule');
});

test('menPerMonth: the reference population raises exactly MEN_PER_MONTH', () => {
  // The calibration point the whole curve hangs off, and the reason it is
  // written against the CONSTANT and not against a literal: REFERENCE_POP
  // is the pivot the curve turns about, so re-pricing MEN_PER_MONTH moves
  // the rate here and nothing else about the shape. This identity has to
  // survive that, and it did — only the second line below moved.
  assert.equal(REFERENCE_POP, 15_000_000);
  assert.equal(menPerMonth(REFERENCE_POP), MEN_PER_MONTH);
  assert.equal(menPerMonth(15_000_000), 10000);
  // CUBE root, not square and not linear: it takes 8× the people to buy
  // 2× the men, where the square root took 4×. Asserted at the exact
  // multiple of REFERENCE_POP where the answer is a round number, so a
  // regression to either neighbour is unmistakable — 120M under linear
  // scaling would be 80000, and under the old sqrt 28284.
  assert.equal(menPerMonth(8 * REFERENCE_POP), 20000);
  assert.equal(menPerMonth(120_000_000), 20000);
  // And the proof point that used to read "60e6 → 2× proves sqrt, not
  // linear" is now the proof that it is NOT sqrt either: 4× the people
  // buys 1.587× the men (cbrt(4)), not 2×. This single number separates
  // all three candidate curves at once — linear says 40000, sqrt says
  // 20000, cbrt says 15874.
  assert.equal(menPerMonth(4 * REFERENCE_POP), 15874);
  assert.equal(menPerMonth(60_000_000), 15874);
});

test('menPerMonth: the real shipped populations — a re-bake must fail here, loudly', () => {
  // These four are the spread the curve has to survive, every figure read
  // off public/data/turn.json: china is the largest population in the
  // game, austria a great power, britain a great power that is mostly
  // colonies (18.1M at home, filed apart from "british colonies"), and
  // sweden the tightest-squeezed nation on the board. 91× china's
  // population over sweden's buys only 4.5× the men — under the square
  // root the same 91× bought 9.5×, which is the whole reason the curve
  // moved.
  //
  // The input half is what makes this test the re-bake tripwire the
  // section header claims: assert the population IS the shipped one, then
  // assert what the curve does with it.
  assert.equal(SHIPPED_POP.china, 293790263);
  assert.equal(SHIPPED_POP.austria, 21222995);
  assert.equal(SHIPPED_POP.britain, 18082841);
  assert.equal(SHIPPED_POP.sweden, 3229802);
  assert.equal(menPerMonth(293790263), 26956); // china
  assert.equal(menPerMonth(21222995), 11226); // austria
  assert.equal(menPerMonth(18082841), 10643); // britain
  assert.equal(menPerMonth(3229802), 5994); // sweden
  // The direction of the change is itself the feature: the cube root
  // pulls the top DOWN and pushes the bottom UP, both against the same
  // untouched reference point. china loses 39%, sweden gains 29% — and
  // both percentages are unmoved by the 15000 → 10000 re-pricing, because
  // the sqrt rates it is compared against scaled by the same 2/3 (china
  // 66,384 → 44,256, sweden 6,960 → 4,640).
  assert.ok(menPerMonth(293790263) < 44256, 'china must fall from its sqrt rate');
  assert.ok(menPerMonth(3229802) > 4640, 'sweden must rise from its sqrt rate');
});

test('menPerMonth: the floor, and the exact crossover where both branches agree', () => {
  // 405,000 is where the curve meets the floor exactly. Solved, not
  // quoted: the two branches agree when MEN_PER_MONTH·cbrt(pop/
  // REFERENCE_POP) equals MIN_MEN_PER_MONTH, i.e. at the population
  // REFERENCE_POP/(MEN_PER_MONTH/MIN_MEN_PER_MONTH)³. The reference rate
  // is 10/3× the floor (10000/3000), so the crossover sits at the
  // population (10/3)-CUBED = 1000/27 ≈ 37.04 times smaller than
  // REFERENCE_POP: 15e6 × 27/1000 = 405,000. The square root wanted
  // (10/3)-SQUARED = 100/9 times smaller — 15e6 × 9/100 = 1,350,000 — so
  // raising the root still divides the crossover by another 10/3, and
  // with it the count of nations pinned flat on the floor with no
  // population term left in their recruitment at all (25 → 9 across the
  // shipped table, scored at today's MEN_PER_MONTH).
  //
  // The crossover moves with the RATE as hard as it moves with the root:
  // cutting MEN_PER_MONTH 15000 → 10000 while the floor stayed at 3000
  // raised it from 120,000 to 405,000, because the floor went from 20% to
  // 30% of the pivot rate and a cube amplifies that 1.5× into 3.375×.
  //
  // Asserting the raw arithmetic alongside the result pins WHY it is the
  // crossover, so moving MEN_PER_MONTH, MIN_MEN_PER_MONTH, REFERENCE_POP
  // or the root itself without moving this test becomes impossible. Every
  // constant in the derivation is imported, and the exponent is the
  // literal 3 that makes it a cube — write 2 and it is 1,350,000 again.
  //
  // Spelled as one integer ratio rather than the arithmetically identical
  // REFERENCE_POP / (MEN_PER_MONTH / MIN_MEN_PER_MONTH) ** 3, and that is
  // a float fact, not a style choice: 10/3 has no binary representation,
  // cubing it compounds the error, and the division lands on
  // 404999.9999999999 — an assert.equal that fails on a derivation that
  // is correct. Cubing the two integer constants separately keeps every
  // intermediate exact (3000³ = 2.7e10, 10000³ = 1e12, both integers).
  assert.equal((REFERENCE_POP * MIN_MEN_PER_MONTH ** 3) / MEN_PER_MONTH ** 3, 405_000);
  assert.equal((REFERENCE_POP * MIN_MEN_PER_MONTH ** 2) / MEN_PER_MONTH ** 2, 1_350_000); // what sqrt gave
  // The floor's height as a fraction of the pivot rate — 30% now, 20%
  // when MEN_PER_MONTH was 15000 — which is the one number the whole
  // derivation above turns on. Written this way up on purpose: 3000/10000
  // rounds to exactly the double the literal 0.3 parses to, where
  // 10000/3000 is the recurring 10/3 that costs the derivation its
  // exactness the moment it is cubed.
  assert.equal(MIN_MEN_PER_MONTH / MEN_PER_MONTH, 0.3);
  assert.equal(MEN_PER_MONTH * Math.cbrt(405_000 / REFERENCE_POP), MIN_MEN_PER_MONTH);
  assert.equal(menPerMonth(405_000), 3000);
  // Below it the floor is doing the work, all the way down to nobody —
  // including at 120,000, which WAS the crossover at the old rate and is
  // now well under the floor (the curve offers it 2000).
  assert.equal(menPerMonth(120_000), 3000);
  assert.equal(Math.round(MEN_PER_MONTH * Math.cbrt(120_000 / REFERENCE_POP)), 2000);
  assert.equal(menPerMonth(100_000), 3000);
  assert.equal(menPerMonth(0), 3000);
  assert.equal(MIN_MEN_PER_MONTH, 3000);
  // And the sqrt crossover is firmly ON the curve rather than under the
  // floor — the tell that the floor really did move and that a population
  // 10/3 times smaller is now the one being rescued.
  assert.equal(menPerMonth(1_350_000), 4481);
  assert.ok(menPerMonth(1_350_000) > MIN_MEN_PER_MONTH);
});

test('menPerMonth: absence fails OPEN — no population means the flat rate, not no men', () => {
  // The load-bearing case. `undefined` is "we were not told", and the
  // answer to that is the rule this one replaced, bit for bit.
  assert.equal(menPerMonth(undefined), MEN_PER_MONTH);
  assert.equal(menPerMonth(), MEN_PER_MONTH);
  // Garbage folds into the same branch deliberately. Math.max(3000, NaN)
  // is NaN, which loses every comparison it appears in AND renders "cap
  // is NaN men" into a player-facing rejection. A garbage number is not
  // evidence about a nation, so it is treated as no evidence.
  assert.equal(menPerMonth(NaN), MEN_PER_MONTH);
  assert.equal(menPerMonth(Infinity), MEN_PER_MONTH);
  // A negative population is nonsense but it is FINITE, so it does not
  // take the branch above — it is clamped to 0 before the root instead.
  // Note the clamp changed job with the curve and this test did not:
  // sqrt(negative) was NaN, the very failure the guard above exists to
  // prevent, whereas cbrt(negative) is an ordinary negative number, so
  // the clamp now stops a negative RATE rather than a NaN one. Both roads
  // end at the floor, which is exactly why the clamp needs its own
  // assertion — delete it and this still reads 3000, silently, off
  // Math.max(3000, -69) instead of off a population of nobody.
  assert.equal(menPerMonth(-5), MIN_MEN_PER_MONTH);
  assert.ok(Number.isFinite(Math.cbrt(-5)), 'cbrt(negative) is a number, not NaN');
  assert.equal(Math.round(MEN_PER_MONTH * Math.cbrt(-5 / REFERENCE_POP)), -69);
});

test('standingArmyCeiling: 3.5% of the shipped populations, unmoved by the curve', () => {
  // Same four nations as the flow test, and the point of repeating them is
  // that these numbers do not answer to the root. The ceiling is a flat
  // share of a population, never a function of the recruitment curve, so
  // swapping sqrt for cbrt left every figure here alone — and when the
  // share itself moved 4% → 3.5%, all four scaled by exactly 0.875 while
  // the menPerMonth figures above did not move at all. Recomputed from the
  // shipped populations rather than hand-scaled from the old literals: a
  // ×0.875 on a FLOORED number is not the floor of a ×0.875 (britain's old
  // 723,313 × 0.875 is 632,898.9, the true figure is 632,899).
  assert.equal(MAX_ARMY_POP_SHARE, 0.035);
  assert.equal(standingArmyCeiling(3229802), 113043); // sweden
  assert.equal(standingArmyCeiling(18082841), 632899); // britain
  assert.equal(standingArmyCeiling(21222995), 742804); // austria
  assert.equal(standingArmyCeiling(293790263), 10282659); // china
});

test('standingArmyCeiling: floors, never rounds — "may never exceed"', () => {
  // 0.035 × 1142872 is 40000.52. Rounded that is 40001 and the nation gets
  // a man its people do not support; floored it is 40000. The rule is a
  // hard ceiling, so the fractional man is always lost. (The population
  // moved with the share — 1000013 landed on 35000.455 at 0.035, where
  // floor and round agree and the test proves nothing — but the .52 it is
  // chosen for did not, so the two arms below still differ by a man.)
  assert.equal(Math.round(MAX_ARMY_POP_SHARE * 1142872), 40001);
  assert.equal(standingArmyCeiling(1142872), 40000);
});

test('standingArmyCeiling: the same floor as the monthly rate, for the same reason', () => {
  // A microstate must be able to KEEP a garrison, not merely to raise one
  // — a 3000/month rate over a 35-man ceiling would be a nation that
  // cannot play. Hence one shared floor.
  assert.equal(standingArmyCeiling(0), MIN_MEN_PER_MONTH);
  assert.equal(standingArmyCeiling(100), MIN_MEN_PER_MONTH);
  assert.equal(standingArmyCeiling(85_713), MIN_MEN_PER_MONTH);
  // The ceiling's own crossover — the population at which the share first
  // buys as many men as the floor hands out — is MIN_MEN_PER_MONTH /
  // MAX_ARMY_POP_SHARE. At 0.04 that was a clean 75,000 and a literal
  // could sit exactly on it; at 0.035 it is 85,714.285…, because the share
  // is 7/200 and 3000·200/7 does not divide. So there is no population ON
  // the crossover to assert, and asserting the fraction itself would test
  // arithmetic rather than the rule.
  //
  // Pin the integers either side instead, and pin them on the RAW product
  // rather than on the ceiling: the two answers are the same 3000 (below
  // the line the floor is rescuing the nation, above it the share has
  // caught up and the floor has stopped doing any work), so only the
  // product shows the line being crossed at all. Written as the exact
  // rational 3000·200/7, which is bit-identical to the division and says
  // out loud where the non-integer comes from.
  assert.equal(MIN_MEN_PER_MONTH / MAX_ARMY_POP_SHARE, (MIN_MEN_PER_MONTH * 200) / 7);
  assert.equal(MIN_MEN_PER_MONTH / MAX_ARMY_POP_SHARE, 85_714.28571428571);
  assert.equal(Math.floor(MAX_ARMY_POP_SHARE * 85_714), 2999);
  assert.equal(Math.floor(MAX_ARMY_POP_SHARE * 85_715), 3000);
  assert.equal(standingArmyCeiling(85_714), MIN_MEN_PER_MONTH);
  assert.equal(standingArmyCeiling(85_715), MIN_MEN_PER_MONTH);
  // And the first population the floor is genuinely off, which is the
  // observable half of the crossover: a whole man ABOVE the floor needs
  // 3001/0.035 = 85,742.857… people, so 85,742 still reads 3000 and 85,743
  // is the first ceiling the share alone decides.
  assert.equal(standingArmyCeiling(85_742), MIN_MEN_PER_MONTH);
  assert.equal(standingArmyCeiling(85_743), 3001);
  assert.equal(standingArmyCeiling(-5), MIN_MEN_PER_MONTH);
});

test('standingArmyCeiling: absence fails OPEN as Infinity — the one-expression "unenforced"', () => {
  // Infinity rather than a null/flag/boolean because `standing > Infinity`
  // is always false: the call site gets "rule off" for free and needs no
  // second branch asking whether the rule is on at all.
  assert.equal(standingArmyCeiling(undefined), Infinity);
  assert.equal(standingArmyCeiling(), Infinity);
  assert.equal(standingArmyCeiling(NaN), Infinity);
  assert.ok(!(Number.MAX_SAFE_INTEGER > standingArmyCeiling(undefined)));
});

test('raiseBudget: population scales the army pool and never the navy', () => {
  // sweden's 3.2M. The army rate is population-derived and multiplies by
  // the month count like it always did; the navy is flat, because hulls
  // are limited by yards and timber rather than by how many people a
  // country has. The third argument reaching the navy branch at all would
  // be the bug.
  assert.equal(raiseBudget('army', 30, 3229802), 5994);
  assert.equal(raiseBudget('army', 60, 3229802), 11988);
  assert.equal(raiseBudget('navy', 30, 3229802), SHIPS_PER_MONTH);
  assert.equal(raiseBudget('navy', 60, 3229802), 2);
  // Unknown branches still fall back to the army rate — now the
  // population-derived one, matching menPerMonth rather than the flat cap.
  assert.equal(raiseBudget('cavalry', 30, 3229802), 5994);
  // And a sub-month turn buys nothing however many people you have —
  // china's 293.8M included.
  assert.equal(raiseBudget('army', 29, 293790263), 0);
});

test('checkRaiseBudgets: a population table replaces the flat cap in the same message', () => {
  // The cap message is unchanged prose with a different number
  // interpolated — no new string, no new shape for a player to learn.
  // sweden's shipped 3,229,802 people buy 5,994 men a month under the cube
  // root, so 6,000 is a raise of six men too many.
  const forces = { sweden: [unit({ strength: 6000, turnStartStrength: 0 })] };
  assert.equal(
    checkRaiseBudgets(forces, 30, { sweden: 3229802 }),
    'sweden exceeded its army recruitment cap: 6000 men raised or reinforced this turn, cap is 5994 men for a 1-month turn',
  );
});

test('checkRaiseBudgets: raising exactly the population-derived cap passes', () => {
  const forces = { sweden: [unit({ strength: 5994, turnStartStrength: 0 })] };
  assert.equal(checkRaiseBudgets(forces, 30, { sweden: 3229802 }), null);
});

test('checkRaiseBudgets: a nation missing from a supplied table is 0 people, not unknown', () => {
  // FAIL CLOSED ON CONTENTS. The table exists, so its silence about spain
  // is an answer: 0 people, which is the 3000 floor for both rules. The
  // ceiling bites first here, and the message says "a population of 0" —
  // which is exactly the tell an admin needs to spot a nation that fell
  // out of the bake.
  const table = { france: 15_000_000 };
  assert.equal(
    checkRaiseBudgets({ spain: [unit({ strength: 3001, turnStartStrength: 0 })] }, 30, table),
    'spain exceeded its standing army ceiling: 3001 men under arms, but a population of 0 supports at most 3000 — an army may never exceed 3.5% of the nation it is raised from',
  );
  // And the floor really is usable rather than merely present: 3000 men
  // clears the ceiling (not >) and exactly fills the floored monthly cap.
  assert.equal(
    checkRaiseBudgets({ spain: [unit({ strength: 3000, turnStartStrength: 0 })] }, 30, table),
    null,
  );
  // An empty table is still a table — present, and silent about everyone.
  assert.equal(
    checkRaiseBudgets({ spain: [unit({ strength: 3001, turnStartStrength: 0 })] }, 30, {}),
    'spain exceeded its standing army ceiling: 3001 men under arms, but a population of 0 supports at most 3000 — an army may never exceed 3.5% of the nation it is raised from',
  );
});

test('checkRaiseBudgets: a garbage population fails OPEN for that nation, not "NaN men"', () => {
  // ?? only catches null and undefined, so a NaN sitting in the table
  // reaches menPerMonth/standingArmyCeiling as a real value. Both fold it
  // into their absence branch, so this nation lands on exactly the
  // no-table behaviour — the flat MEN_PER_MONTH (10000 today) and no
  // ceiling — rather than being told its cap is NaN, a message no player
  // could act on. Note that fail OPEN means "this rule with no population
  // term", not "no rule at all", which is why the numbers here track
  // MEN_PER_MONTH and moved with it.
  const forces = (raised) => ({
    spain: [
      unit({ strength: 900000, turnStartStrength: 900000 }),
      unit({ strength: raised, turnStartStrength: 0 }),
    ],
  });
  // 900,000 standing would break any real ceiling; NaN yields Infinity, so
  // nothing catches it, and the flat monthly cap is what remains in force.
  assert.equal(checkRaiseBudgets(forces(10000), 30, { spain: NaN }), null);
  const overFlat = checkRaiseBudgets(forces(10001), 30, { spain: NaN });
  assert.equal(
    overFlat,
    'spain exceeded its army recruitment cap: 10001 men raised or reinforced this turn, cap is 10000 men for a 1-month turn',
  );
  // The whole point of folding non-finite into the absence branch: no
  // arithmetic on NaN ever reaches a player's rejection comment.
  assert.ok(!overFlat.includes('NaN'));
  // null and undefined VALUES do get the ?? treatment and read as 0,
  // because a key present with no number is the same evidence as no key.
  assert.match(
    checkRaiseBudgets({ spain: [unit({ strength: 3001, turnStartStrength: 0 })] }, 30, { spain: null }),
    /a population of 0 supports at most 3000/,
  );
  assert.match(
    checkRaiseBudgets({ spain: [unit({ strength: 3001, turnStartStrength: 0 })] }, 30, { spain: undefined }),
    /a population of 0 supports at most 3000/,
  );
});

test('checkRaiseBudgets: NO BRICK — a nation that loses land is over its ceiling and still playable', () => {
  // The case this rule must not break, and the reason the ceiling test
  // sits AFTER the `total <= 0` guard rather than before it. Sweden loses
  // Finland: its population drops to 2,360,845, its ceiling drops with it
  // to 82,629, and its 100,000 standing men are suddenly illegal having
  // done nothing whatsoever. Hard-rejecting there would mean sweden can no
  // longer move, split, disband, take losses, or advance the turn — a
  // nation deleted from the game by an ownership edit it did not make.
  //
  // Every shape below spends 0 army budget and so never reaches the
  // ceiling test at all. If this test starts failing, the ceiling has
  // regressed to hard-reject semantics; do NOT relax the assertion.
  const pop = { sweden: 2360845 };
  // Standing still: the whole order of battle, anchored at its own strength.
  assert.equal(
    checkRaiseBudgets({ sweden: [unit({ strength: 100000, turnStartStrength: 100000 })] }, 30, pop),
    null,
  );
  // Split: the anchor partitions across both halves, so neither shows growth.
  assert.equal(
    checkRaiseBudgets({
      sweden: [
        unit({ strength: 60000, turnStartStrength: 60000 }),
        unit({ strength: 40000, turnStartStrength: 40000 }),
      ],
    }, 30, pop),
    null,
  );
  // Disband: the force is simply gone from the array.
  assert.equal(checkRaiseBudgets({ sweden: [] }, 30, pop), null);
  // Losses: raiseCost clamps at 0, so a mauled army bills nothing — and
  // note this one ends UNDER the ceiling anyway, which is the way out.
  assert.equal(
    checkRaiseBudgets({ sweden: [unit({ strength: 90000, turnStartStrength: 100000 })] }, 30, pop),
    null,
  );
  // A turn advance restamps every anchor to current strength — still no
  // growth, so still nothing spent, so still no ceiling test.
  assert.equal(
    checkRaiseBudgets({ sweden: [unit({ strength: 100000, turnStartStrength: 100000 })] }, 60, pop),
    null,
  );
});

test('checkRaiseBudgets: over the ceiling, raising even one man is refused', () => {
  // The other half of the no-brick case: sweden may do everything except
  // grow. One man is enough to reach the test, and the message names the
  // stock, the population behind it, and the ceiling that stock broke.
  const forces = {
    sweden: [
      unit({ strength: 100000, turnStartStrength: 100000 }),
      unit({ strength: 1, turnStartStrength: 0 }),
    ],
  };
  assert.equal(
    checkRaiseBudgets(forces, 30, { sweden: 2360845 }),
    'sweden exceeded its standing army ceiling: 100001 men under arms, but a population of 2360845 supports at most 82629 — an army may never exceed 3.5% of the nation it is raised from',
  );
});

test('checkRaiseBudgets: the ceiling is strict > — you may recruit up TO it, never past it', () => {
  // pop 1,142,858 puts the ceiling at exactly 40000, so all three cases
  // below turn on the comparison operator alone. Re-derived when the share
  // moved, not scaled: the exact population is 40000/0.035 = 1,142,857.14…,
  // which is not a person, so the fixture is the smallest INTEGER whose
  // floored ceiling is 40000 — 1,142,857 lands on 39,999.995 and floors to
  // 39,999, one short, and the boundary these three cases test would have
  // quietly stopped being a boundary.
  const pop = { spain: 1_142_858 };
  // Sitting exactly on the ceiling, spending nothing: legal.
  assert.equal(
    checkRaiseBudgets({ spain: [unit({ strength: 40000, turnStartStrength: 40000 })] }, 30, pop),
    null,
  );
  // Recruiting the last man the population supports, landing exactly on
  // the ceiling: also legal. `>=` here would make the ceiling unreachable.
  assert.equal(
    checkRaiseBudgets({ spain: [unit({ strength: 40000, turnStartStrength: 39999 })] }, 30, pop),
    null,
  );
  // One man past it: refused.
  assert.equal(
    checkRaiseBudgets({ spain: [unit({ strength: 40001, turnStartStrength: 40000 })] }, 30, pop),
    'spain exceeded its standing army ceiling: 40001 men under arms, but a population of 1142858 supports at most 40000 — an army may never exceed 3.5% of the nation it is raised from',
  );
});

test('checkRaiseBudgets: the ceiling reason renders a clean percent, never float dust', () => {
  // The one place a float reaches a player's prose, and it was correct only
  // by luck until now: `MAX_ARMY_POP_SHARE * 100` is exactly 4 at 0.04 and
  // 3.5000000000000004 at 0.035, so the rejection comment would have read
  // "may never exceed 3.5000000000000004% of the nation it is raised from"
  // — a regression nothing else in this suite can see, because every other
  // assertion in the file quotes the sentence rather than deriving it.
  const reason = checkRaiseBudgets(
    { spain: [unit({ strength: 40001, turnStartStrength: 40000 })] },
    30,
    { spain: 1_142_858 },
  );
  assert.ok(reason.includes('3.5%'), reason);
  assert.ok(!reason.includes('3.5000000000000004'), reason);
  // No dust at all, whatever shape it takes: the percent is one or two
  // characters of digits, nothing longer.
  assert.match(reason, /may never exceed \d+(\.\d)?% of the nation/);
  // And the formatting has to survive the share moving BACK to a whole
  // number: `+(x).toFixed(4)` renders 0.04 as "4%", where the toFixed(1)
  // that would also have killed the dust ships "4.0%" at a player.
  assert.equal(`${+(MAX_ARMY_POP_SHARE * 100).toFixed(4)}%`, '3.5%');
  assert.equal(`${+(0.04 * 100).toFixed(4)}%`, '4%');
  assert.equal((0.04 * 100).toFixed(1), '4.0');
});

test('checkRaiseBudgets: the ceiling is army-only — the navy sails over it', () => {
  // Two independent claims. First: a nation whose ARMY is over its ceiling
  // may still lay down a hull, because the navy's spend is a separate pool
  // and the army iteration `continue`s at zero spend before the ceiling
  // test is ever reached.
  assert.equal(
    checkRaiseBudgets({
      sweden: [
        unit({ branch: 'army', strength: 100000, turnStartStrength: 100000 }),
        unit({ branch: 'navy', strength: 1, turnStartStrength: 0 }),
      ],
    }, 30, { sweden: 2360845 }),
    null,
  );
  // Second: ships are not men, so a fleet contributes NOTHING to the
  // stock. 900,000 hulls beside a 1-man army is 1 man under arms against
  // a 40000 ceiling — absurd as a fleet, but the right answer here, and
  // the navy has no ceiling of its own to catch it.
  assert.equal(
    checkRaiseBudgets({
      spain: [
        unit({ branch: 'navy', strength: 900000, turnStartStrength: 900000 }),
        unit({ branch: 'army', strength: 1, turnStartStrength: 0 }),
      ],
    }, 30, { spain: 1_142_858 }),
    null,
  );
});

test('checkRaiseBudgets: a force that bills the army pool is always also counted in the army stock', () => {
  // Both sums key off the CURRENT branch, and this pins that they cannot
  // drift apart. A fleet re-branded into the army bills its full strength
  // (the anchor was earned in the navy) — and the very same men land in
  // the stock, so the ceiling sees them. Bucketing `standing` by
  // turnStartBranch instead would let 40001 men enter the army invisibly.
  const forces = {
    spain: [unit({ branch: 'army', turnStartBranch: 'navy', strength: 40001, turnStartStrength: 40 })],
  };
  assert.equal(
    checkRaiseBudgets(forces, 30, { spain: 1_142_858 }),
    'spain exceeded its standing army ceiling: 40001 men under arms, but a population of 1142858 supports at most 40000 — an army may never exceed 3.5% of the nation it is raised from',
  );
});

test('checkRaiseBudgets: PRECEDENCE — busting both the ceiling and the cap reports the ceiling', () => {
  // sweden's cap is 5,399/month (2,360,845 people through the cube root)
  // and its ceiling 82,629; this submission breaks both. The ceiling wins
  // because trimming to the monthly cap would not fix it — the nation is
  // over on STOCK, and reporting a flow number would send the player to
  // shave 4,601 men off a raise that is not the problem. The two numbers
  // are re-priced by different knobs and neither knob touches the other:
  // the flow moves with the curve and with MEN_PER_MONTH, the ceiling only
  // ever with MAX_ARMY_POP_SHARE — the share of a population is that share
  // of it whatever root scales the raising and whatever rate the curve is
  // quoted at, which is why the 4% → 3.5% cut moved the 82,629 here and
  // left the 5,399 exactly alone. The operative rule is "over the ceiling ⇒
  // no men at all", not "recruit up to the ceiling", and the message has
  // to say so.
  const forces = {
    sweden: [
      unit({ strength: 100000, turnStartStrength: 100000 }),
      unit({ strength: 10000, turnStartStrength: 0 }),
    ],
  };
  // "breaks BOTH" asserted rather than asserted-in-prose, because it is
  // the precondition the whole test rests on and it is invisible in the
  // expected message: the ceiling reason is the only output, so if the cap
  // ever stopped being broken — MEN_PER_MONTH rising past the 10,000 men
  // raised here would do it, and nothing else in this file would notice —
  // this would silently degrade into an ordinary over-ceiling test that
  // proves no precedence at all. Derived from raiseBudget rather than
  // quoted, so the two figures in the comment above cannot rot apart from
  // the rule the way a hand-copied 5,400 already did once.
  assert.equal(raiseBudget('army', 30, 2360845), 5399);
  assert.ok(10000 > raiseBudget('army', 30, 2360845), 'the raise must also bust the monthly cap');
  assert.ok(100000 + 10000 > standingArmyCeiling(2360845), 'and the standing ceiling');
  assert.equal(
    checkRaiseBudgets(forces, 30, { sweden: 2360845 }),
    'sweden exceeded its standing army ceiling: 110000 men under arms, but a population of 2360845 supports at most 82629 — an army may never exceed 3.5% of the nation it is raised from',
  );
});

test('checkRaiseBudgets: omitting the population argument switches BOTH rules off', () => {
  // FAIL OPEN ON ABSENCE, at the gate rather than at the helper. The same
  // sweden that is 17,371 men over its ceiling two tests up is simply
  // uncapped here, and the flat MEN_PER_MONTH is back — which is
  // precisely the behaviour every one of this file's pre-population tests
  // relies on, at whatever value that constant currently holds (10000).
  const overCeiling = (raised) => ({
    sweden: [
      unit({ strength: 100000, turnStartStrength: 100000 }),
      unit({ strength: raised, turnStartStrength: 0 }),
    ],
  });
  assert.equal(checkRaiseBudgets(overCeiling(10000), 30), null);
  assert.equal(
    checkRaiseBudgets(overCeiling(10001), 30),
    'sweden exceeded its army recruitment cap: 10001 men raised or reinforced this turn, cap is 10000 men for a 1-month turn',
  );
  // Explicit undefined is the same absence as no argument — the value the
  // callers actually pass when turn.json carries no table.
  assert.equal(checkRaiseBudgets(overCeiling(10000), 30, undefined), null);
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

// ── checkMoveLock — one march per force per turn ─────────────────────
// A force with a position and an odometer. Turn-start anchor at (0,0)
// unless overridden; lon 5 is ~556 km east of it, comfortably inside an
// army's 750 km turn and comfortably outside the 0.1 km tolerance.
function stack(overrides = {}) {
  return {
    id: `stack-${nextUnitId++}`,
    branch: 'army',
    strength: 1000,
    turnStartStrength: 1000,
    turnStartBranch: 'army',
    lat: 0,
    lon: 0,
    turnStartLat: 0,
    turnStartLon: 0,
    kmMovedThisTurn: 0,
    ...overrides,
  };
}

const MARCHED_KM = haversineKm(0, 0, 0, 5);
// One degree further east. Measured rather than approximated: the gate
// compares reported km against the ground actually covered, so an odometer
// hand-rounded a few hundred metres short reads as a march being hidden.
const MARCHED_FURTHER_KM = haversineKm(0, 0, 0, 6);

test('checkMoveLock: an unmarched force may march', () => {
  const base = { spain: [stack({ id: 'sp-1' })] };
  const head = { spain: [stack({ id: 'sp-1', lon: 5, kmMovedThisTurn: MARCHED_KM })] };
  assert.equal(checkMoveLock(base, head), null);
});

test('checkMoveLock: a force that already marched cannot march again', () => {
  const base = { spain: [stack({ id: 'sp-1', lon: 5, kmMovedThisTurn: MARCHED_KM })] };
  const head = { spain: [stack({ id: 'sp-1', lon: 6, kmMovedThisTurn: MARCHED_FURTHER_KM })] };
  assert.match(checkMoveLock(base, head), /^force sp-1 \(spain\) has already marched this turn/);
});

test('checkMoveLock: a marched force may still be edited where it stands', () => {
  // Reinforcing, renaming or disbanding a force that has already marched
  // is untouched by this gate — only its position is pinned.
  const base = { spain: [stack({ id: 'sp-1', lon: 5, kmMovedThisTurn: MARCHED_KM })] };
  const head = {
    spain: [stack({ id: 'sp-1', lon: 5, kmMovedThisTurn: MARCHED_KM, strength: 4000 })],
  };
  assert.equal(checkMoveLock(base, head), null);
});

test('checkMoveLock: a march already on main cannot be discarded', () => {
  // The odometer is what locks the force, so winding it back would hand
  // out a second march. A genuine recall never reaches the server — it is
  // only offered while the march is still unsubmitted.
  const base = { spain: [stack({ id: 'sp-1', lon: 5, kmMovedThisTurn: MARCHED_KM })] };
  const head = { spain: [stack({ id: 'sp-1', lon: 5, kmMovedThisTurn: 0 })] };
  assert.match(checkMoveLock(base, head), /cannot discard a march/);
});

test('checkMoveLock: a force main has never seen cannot arrive mid-march', () => {
  const head = { spain: [stack({ id: 'sp-new', lon: 5, kmMovedThisTurn: MARCHED_KM })] };
  assert.match(checkMoveLock({}, head), /neither it nor anything it was split from/);
});

test('checkMoveLock: a detachment of an unmarched parent may march', () => {
  const base = { spain: [stack({ id: 'sp-1' })] };
  const head = {
    spain: [
      stack({ id: 'sp-1' }),
      stack({ id: 'sp-2', fromIds: ['sp-1'], lon: 5, kmMovedThisTurn: MARCHED_KM }),
    ],
  };
  assert.equal(checkMoveLock(base, head), null);
});

test('checkMoveLock: a detachment of a marched parent is pinned to it', () => {
  // The split loophole: a new id has no history of its own, so without
  // lineage it would read as a fresh force standing wherever the parent
  // happened to finish, free to march again.
  const base = { spain: [stack({ id: 'sp-1', lon: 5, kmMovedThisTurn: MARCHED_KM })] };
  const parked = stack({ id: 'sp-2', fromIds: ['sp-1'], lon: 5, kmMovedThisTurn: MARCHED_KM });
  assert.equal(checkMoveLock(base, { spain: [parked] }), null);
  const marched = { ...parked, lon: 6, kmMovedThisTurn: MARCHED_FURTHER_KM };
  assert.match(checkMoveLock(base, { spain: [marched] }), /has already marched this turn/);
});

test('checkMoveLock: a detachment cannot shed the march it inherited', () => {
  const base = { spain: [stack({ id: 'sp-1', lon: 5, kmMovedThisTurn: MARCHED_KM })] };
  const head = {
    spain: [stack({ id: 'sp-2', fromIds: ['sp-1'], lon: 5, kmMovedThisTurn: 0 })],
  };
  assert.match(checkMoveLock(base, head), /cannot discard a march/);
});

test('checkMoveLock: a merge bills the march its source walked to get there', () => {
  // sp-2 starts the turn 556 km east, marches onto sp-1 and is consumed.
  // The survivor keeps sp-1's id and position and owns sp-2's march.
  const base = {
    spain: [stack({ id: 'sp-1' }), stack({ id: 'sp-2', lon: 5, turnStartLon: 5 })],
  };
  const merged = stack({
    id: 'sp-1',
    kmMovedThisTurn: MARCHED_KM,
    fromIds: ['sp-2'],
    strength: 2000,
  });
  assert.equal(checkMoveLock(base, { spain: [merged] }), null);
  // The same merge claiming a clean odometer. This is the teleport: sp-2's
  // men arrive without walking, and the survivor is still free to march.
  const teleported = { ...merged, kmMovedThisTurn: 0 };
  assert.match(checkMoveLock(base, { spain: [teleported] }), /cannot discard a march/);
});

test('checkMoveLock: merging into a spent force cannot un-spend it', () => {
  const base = {
    spain: [
      stack({ id: 'sp-1', lon: 5, kmMovedThisTurn: MARCHED_KM }),
      stack({ id: 'sp-2', lon: 5, turnStartLon: 5 }),
    ],
  };
  // Survivor sits where the spent force stands, carrying its odometer.
  const ok = stack({
    id: 'sp-2',
    lon: 5,
    turnStartLon: 5,
    kmMovedThisTurn: MARCHED_KM,
    fromIds: ['sp-1'],
    strength: 2000,
  });
  assert.equal(checkMoveLock(base, { spain: [ok] }), null);
  // Same merge, then walking the combined force on.
  const walked = { ...ok, lon: 6, kmMovedThisTurn: MARCHED_FURTHER_KM };
  assert.match(checkMoveLock(base, { spain: [walked] }), /has already marched this turn/);
});

test('checkMoveLock: a base force with no odometer reads as unmarched, not as NaN', () => {
  const legacy = stack({ id: 'sp-1' });
  delete legacy.kmMovedThisTurn;
  const head = { spain: [stack({ id: 'sp-1', lon: 5, kmMovedThisTurn: MARCHED_KM })] };
  assert.equal(checkMoveLock({ spain: [legacy] }, head), null);
});

test('checkMoveLock: junk lineage degrades to "no lineage", never to a free pass', () => {
  const base = { spain: [stack({ id: 'sp-1', lon: 5, kmMovedThisTurn: MARCHED_KM })] };
  for (const fromIds of ['sp-1', { 0: 'sp-1' }, [null, 42]]) {
    const head = { spain: [stack({ id: 'sp-2', fromIds, lon: 5, kmMovedThisTurn: MARCHED_KM })] };
    assert.match(checkMoveLock(base, head), /neither it nor anything it was split from/);
  }
});

test('checkMoveLock: empty and undefined nation arrays are tolerated on both sides', () => {
  assert.equal(checkMoveLock({}, {}), null);
  assert.equal(checkMoveLock({ spain: undefined }, { spain: undefined }), null);
  assert.equal(checkMoveLock({ spain: [] }, { spain: [] }), null);
});

// ── checkAnchorConservation × lineage ────────────────────────────────

test('checkAnchorConservation: a merged force is funded by the ids it absorbed', () => {
  // Anchors add on a merge — no men were raised — so the survivor's anchor
  // exceeds its own base allowance by exactly what it consumed.
  const base = {
    spain: [
      unit({ id: 'sp-1', strength: 10000, turnStartStrength: 10000 }),
      unit({ id: 'sp-2', strength: 5000, turnStartStrength: 5000 }),
    ],
  };
  const head = {
    spain: [unit({ id: 'sp-1', strength: 15000, turnStartStrength: 15000, fromIds: ['sp-2'] })],
  };
  assert.equal(checkAnchorConservation(base, head), null);
  // Without the lineage it is indistinguishable from inventing 5000 men.
  const bare = { spain: [unit({ id: 'sp-1', strength: 15000, turnStartStrength: 15000 })] };
  assert.match(checkAnchorConservation(base, bare), /^spain inflated its army turn-start strength/);
});

test('checkAnchorConservation: lineage credit is same-nation only', () => {
  // Otherwise a player names another nation's force id inside their own
  // file, spends that nation's allowance, and bounces its next submission
  // for inflation it never committed.
  const base = {
    france: [unit({ id: 'fr-1', strength: 40000, turnStartStrength: 40000 })],
    spain: [unit({ id: 'sp-1', strength: 1000, turnStartStrength: 1000 })],
  };
  const head = {
    spain: [unit({ id: 'sp-1', strength: 41000, turnStartStrength: 41000, fromIds: ['fr-1'] })],
  };
  assert.match(checkAnchorConservation(base, head), /^spain inflated its army turn-start strength/);
});

test('checkAnchorConservation: one base anchor funds one heir, not two', () => {
  const base = {
    spain: [
      unit({ id: 'sp-1', strength: 10000, turnStartStrength: 10000 }),
      unit({ id: 'sp-2', strength: 10000, turnStartStrength: 10000 }),
    ],
  };
  // Both survivors claim sp-2's anchor; whichever is scored second is
  // funded by nothing.
  const head = {
    spain: [
      unit({ id: 'sp-1', strength: 20000, turnStartStrength: 20000, fromIds: ['sp-2'] }),
      unit({ id: 'sp-3', strength: 10000, turnStartStrength: 10000, fromIds: ['sp-2'] }),
    ],
  };
  assert.match(checkAnchorConservation(base, head), /^spain inflated its army turn-start strength/);
});

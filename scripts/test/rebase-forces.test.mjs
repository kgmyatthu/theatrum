// Tests for the per-nation 3-way merge. Every test names the concurrent
// scenario it exercises — if the rebase regresses, the failing test tells
// you which case broke.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rebaseForceFile } from '../lib/rebase-forces.mjs';

const f = (id, overrides = {}) => ({
  id,
  nation: 'spain',
  branch: 'army',
  name: 'Corps',
  strength: 10000,
  commander: 'X',
  lon: 0,
  lat: 0,
  ...overrides,
});

const ids = (arr) => arr.map((x) => x.id).sort();
const byId = (arr, id) => arr.find((x) => x.id === id);

// ────────────────────────────────────────────────────────────────────
// Trivial sanity — no concurrent changes, single-player flows
// ────────────────────────────────────────────────────────────────────

test('no-op: player made no changes, main untouched', () => {
  const baseline = [f('A'), f('B')];
  const snapshot = [f('A'), f('B')];
  const main = [f('A'), f('B')];
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.deepEqual(out, main);
});

test('add: solo player adds a force', () => {
  const baseline = [f('A')];
  const snapshot = [f('A'), f('B')];
  const main = [f('A')];
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.deepEqual(ids(out), ['A', 'B']);
});

test('edit: solo player moves a force', () => {
  const baseline = [f('A', { lat: 0 })];
  const snapshot = [f('A', { lat: 50 })];
  const main = [f('A', { lat: 0 })];
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.equal(byId(out, 'A').lat, 50);
});

test('remove: solo player deletes their force', () => {
  const baseline = [f('A'), f('B')];
  const snapshot = [f('A')];
  const main = [f('A'), f('B')];
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.deepEqual(ids(out), ['A']);
});

// ────────────────────────────────────────────────────────────────────
// Concurrent writes — the whole reason this rebase exists
// ────────────────────────────────────────────────────────────────────

test('concurrent: two players add forces in the same nation; both adds preserved', () => {
  // Both players bootstrapped against the same baseline (one force A).
  // Alice added B and merged first → main is now {A, B}.
  // Carol adds C. Her baseline still says {A}. Her snapshot: {A, C}.
  // Naive overwrite would drop B. Rebase must keep all three.
  const baseline = [f('A')];
  const snapshot = [f('A'), f('C')];
  const main = [f('A'), f('B')]; // alice's add already landed
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.deepEqual(ids(out), ['A', 'B', 'C']);
});

test('concurrent: two players edit different forces; both edits preserved', () => {
  // Alice moved A; Carol independently moves B. Carol's baseline has
  // A at lat=0 (pre-alice). Without rebase, Carol's submit would
  // roll A back. Rebase: A in main is current (lat=50), Carol didn't
  // touch A in her snapshot, so it's preserved.
  const baseline = [f('A', { lat: 0 }), f('B', { lat: 0 })];
  const snapshot = [f('A', { lat: 0 }), f('B', { lat: 70 })];
  const main = [f('A', { lat: 50 }), f('B', { lat: 0 })]; // alice moved A
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.equal(byId(out, 'A').lat, 50, 'alice\'s move on A survived');
  assert.equal(byId(out, 'B').lat, 70, 'carol\'s move on B applied');
});

test('concurrent: two players remove different forces; both deletions preserved', () => {
  const baseline = [f('A'), f('B'), f('C')];
  // Alice deleted A → main is {B, C}.
  // Carol deletes B. Baseline still has {A, B, C}, snapshot {A, C}.
  const snapshot = [f('A'), f('C')];
  const main = [f('B'), f('C')]; // alice's delete already applied
  const out = rebaseForceFile(baseline, snapshot, main);
  // Carol's "delete B" must apply. Alice's "delete A" already in main.
  // A in Carol's snapshot is from her stale baseline — not an add (she
  // didn't add it, it was always there). The rebase recognizes this:
  // A is in BOTH baseline and snapshot, content identical → no intent,
  // preserve main (which doesn't have A).
  assert.deepEqual(ids(out), ['C']);
});

test('concurrent: player edits while another removes the same force; remove wins', () => {
  // Alice removed force A. Carol's baseline had A; she edited A's position.
  // Carol's edit can't apply — A no longer exists in main.
  const baseline = [f('A', { lat: 0 })];
  const snapshot = [f('A', { lat: 80 })]; // carol's edit
  const main = []; // alice removed A
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.deepEqual(out, [], 'A stays removed; carol\'s edit silently dropped');
});

test('concurrent: player removes while another edits the same force; remove wins', () => {
  // Alice moved A. Carol's baseline had A; she submits without A (delete).
  // Carol's intent was to delete — that should win, even though Alice's
  // edit landed in between.
  const baseline = [f('A', { lat: 0 })];
  const snapshot = []; // carol deleted A
  const main = [f('A', { lat: 60 })]; // alice's move on A
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.deepEqual(out, [], 'carol\'s delete applies; alice\'s move discarded');
});

test('concurrent: player adds while another player removes a different force', () => {
  const baseline = [f('A'), f('B')];
  // Alice removed A → main is {B}.
  const snapshot = [f('A'), f('B'), f('C')]; // carol added C
  const main = [f('B')];
  const out = rebaseForceFile(baseline, snapshot, main);
  // Alice's delete preserved (A absent in main, no intent from carol to readd).
  // Carol's add applied.
  // A is in baseline AND snapshot, identical content → no intent → preserve main → A not present.
  assert.deepEqual(ids(out), ['B', 'C']);
});

test('concurrent: collision on the same force id resolves to player\'s edit', () => {
  // Hypothetical: two players coincidentally produce the same id (which
  // shouldn't happen with deterministic ids, but be defensive). Player's
  // edit replaces main's content for that id since the player explicitly
  // intends to change it.
  const baseline = [f('shared', { lat: 0 })];
  const snapshot = [f('shared', { lat: 10 })]; // carol edits
  const main = [f('shared', { lat: 20 })]; // someone else also wrote to 'shared'
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.equal(byId(out, 'shared').lat, 10, 'player\'s edit wins for forces they touched');
});

test('concurrent: player\'s new id collides with main; main wins (player\'s add is dropped)', () => {
  // Player thinks they're adding a new force (not in baseline), but main
  // already has that id (another player got there first). Don't clobber.
  const baseline = [];
  const snapshot = [f('X', { lat: 100 })]; // player's add
  const main = [f('X', { lat: 50 })]; // someone else's add with same id
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.equal(
    byId(out, 'X').lat,
    50,
    'main\'s X wins; player\'s "new" add doesn\'t clobber (deterministic ids should make this unreachable, but defensive)',
  );
});

// ────────────────────────────────────────────────────────────────────
// Order independence — applying two players' rebases in either order
// should yield the same final state (commutativity of disjoint edits).
// ────────────────────────────────────────────────────────────────────

test('commutativity: alice-then-carol == carol-then-alice for disjoint adds', () => {
  // Both start from {A}. Alice adds B, Carol adds C.
  const startMain = [f('A')];
  const aliceBaseline = [f('A')];
  const aliceSnapshot = [f('A'), f('B')];
  const carolBaseline = [f('A')];
  const carolSnapshot = [f('A'), f('C')];

  // Order 1: alice first, carol second
  const afterAlice = rebaseForceFile(aliceBaseline, aliceSnapshot, startMain);
  const order1 = rebaseForceFile(carolBaseline, carolSnapshot, afterAlice);

  // Order 2: carol first, alice second
  const afterCarol = rebaseForceFile(carolBaseline, carolSnapshot, startMain);
  const order2 = rebaseForceFile(aliceBaseline, aliceSnapshot, afterCarol);

  assert.deepEqual(ids(order1), ids(order2));
  assert.deepEqual(ids(order1), ['A', 'B', 'C']);
});

test('commutativity: alice-then-carol == carol-then-alice for disjoint deletes', () => {
  const startMain = [f('A'), f('B'), f('C')];
  const aliceBaseline = [f('A'), f('B'), f('C')];
  const aliceSnapshot = [f('B'), f('C')]; // delete A
  const carolBaseline = [f('A'), f('B'), f('C')];
  const carolSnapshot = [f('A'), f('B')]; // delete C

  const afterAlice = rebaseForceFile(aliceBaseline, aliceSnapshot, startMain);
  const order1 = rebaseForceFile(carolBaseline, carolSnapshot, afterAlice);

  const afterCarol = rebaseForceFile(carolBaseline, carolSnapshot, startMain);
  const order2 = rebaseForceFile(aliceBaseline, aliceSnapshot, afterCarol);

  assert.deepEqual(ids(order1), ids(order2));
  assert.deepEqual(ids(order1), ['B']);
});

test('commutativity: disjoint edits commute', () => {
  const startMain = [f('A', { lat: 0 }), f('B', { lat: 0 })];
  const aliceBaseline = [f('A', { lat: 0 }), f('B', { lat: 0 })];
  const aliceSnapshot = [f('A', { lat: 50 }), f('B', { lat: 0 })]; // edit A
  const carolBaseline = [f('A', { lat: 0 }), f('B', { lat: 0 })];
  const carolSnapshot = [f('A', { lat: 0 }), f('B', { lat: 70 })]; // edit B

  const afterAlice = rebaseForceFile(aliceBaseline, aliceSnapshot, startMain);
  const order1 = rebaseForceFile(carolBaseline, carolSnapshot, afterAlice);

  const afterCarol = rebaseForceFile(carolBaseline, carolSnapshot, startMain);
  const order2 = rebaseForceFile(aliceBaseline, aliceSnapshot, afterCarol);

  // Both orders → A.lat=50 AND B.lat=70
  assert.equal(byId(order1, 'A').lat, 50);
  assert.equal(byId(order1, 'B').lat, 70);
  assert.equal(byId(order2, 'A').lat, 50);
  assert.equal(byId(order2, 'B').lat, 70);
});

// ────────────────────────────────────────────────────────────────────
// Idempotence — rebasing the same submission twice should be a no-op
// the second time. (Important for retry safety: if the worker fails
// halfway and the client retries, rebase shouldn't multiply effects.)
// ────────────────────────────────────────────────────────────────────

test('idempotence: rebasing the same submission twice yields the same result', () => {
  const baseline = [f('A'), f('B')];
  const snapshot = [f('A', { lat: 99 }), f('C')]; // edit A, delete B, add C
  const main = [f('A'), f('B')];

  const once = rebaseForceFile(baseline, snapshot, main);

  // If a client retries with the same baseline + snapshot after the
  // first apply already merged, the rebase should produce the same
  // result (no double-adds, no resurrected forces).
  const twice = rebaseForceFile(baseline, snapshot, once);
  assert.deepEqual(ids(once), ids(twice));
  assert.equal(byId(twice, 'A').lat, 99);
  assert.equal(byId(twice, 'C').id, 'C');
});

// ────────────────────────────────────────────────────────────────────
// Stale-baseline scenarios — the original rejection failure mode
// ────────────────────────────────────────────────────────────────────

test('stale: player\'s snapshot has old positions for forces they didn\'t touch', () => {
  // Player loaded an hour ago. Their baseline has A at lat=0. Many other
  // players moved A in the interim → main has A at lat=88. Player only
  // edits B; their snapshot still shows A at lat=0 (because that's where
  // they last saw it). Rebase must preserve main's A.
  const baseline = [f('A', { lat: 0 }), f('B', { lat: 0 })];
  const snapshot = [f('A', { lat: 0 }), f('B', { lat: 30 })];
  const main = [f('A', { lat: 88 }), f('B', { lat: 0 })];
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.equal(byId(out, 'A').lat, 88, 'main\'s latest A preserved');
  assert.equal(byId(out, 'B').lat, 30, 'player\'s edit on B applied');
});

test('stale: many concurrent operations layered correctly', () => {
  // The "tons of concurrent activity" stress case.
  // Baseline: A, B, C
  // Player edits B (moves it), adds D.
  // Meanwhile in main: someone deleted A, edited C, added E.
  // Expected merged:
  //   A: deleted (main's deletion, no objection from player)
  //   B: player's edit (player's intent)
  //   C: main's edit (player didn't touch)
  //   D: added (player's intent)
  //   E: preserved (main's add, player wasn't involved)
  const baseline = [f('A'), f('B', { lat: 0 }), f('C', { lat: 0 })];
  const snapshot = [
    f('A'), // unchanged in snapshot
    f('B', { lat: 50 }), // player moved B
    f('C', { lat: 0 }), // unchanged in snapshot
    f('D'), // player added D
  ];
  const main = [
    // A removed
    f('B', { lat: 0 }), // B at original position
    f('C', { lat: 99 }), // someone edited C
    f('E'), // someone added E
  ];
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.deepEqual(ids(out), ['B', 'C', 'D', 'E']);
  assert.equal(byId(out, 'B').lat, 50, 'player\'s B edit applied');
  assert.equal(byId(out, 'C').lat, 99, 'main\'s C edit preserved');
});

// ────────────────────────────────────────────────────────────────────
// Merge conflict resolution — same force touched by multiple players.
// 3-way merge resolves these deterministically (no manual conflict
// resolution required, no "merge conflict" rejection at the PR level).
// ────────────────────────────────────────────────────────────────────

test('conflict: alice and bob both edit same force; bob\'s rebase overwrites alice (last-write-wins)', () => {
  // Both bootstrapped at F.lat=0.
  // Alice edits to lat=50, merges first → main.F.lat = 50.
  // Bob edits to lat=80, his baseline still has lat=0.
  // Bob's submission lands after Alice — his rebase sees baseline=0
  // and snapshot=80 (his edit), with main=50 (alice's edit).
  // Rule: "in both, content differs → replace in main". Bob's edit wins.
  // This is *deliberate* last-write-wins for genuinely conflicting moves;
  // a true CRDT-style merge of two players moving the same force is not
  // semantically meaningful (where does the force end up?). Bob saw an
  // older state and made his call; his call is the most-recent intent.
  const baseline = [f('F', { lat: 0 })];
  const aliceSnap = [f('F', { lat: 50 })];
  let main = [f('F', { lat: 0 })];
  main = rebaseForceFile(baseline, aliceSnap, main);
  assert.equal(byId(main, 'F').lat, 50, 'alice merged first');

  const bobSnap = [f('F', { lat: 80 })];
  const afterBob = rebaseForceFile(baseline, bobSnap, main);
  assert.equal(byId(afterBob, 'F').lat, 80, 'bob\'s edit overwrites alice');
});

test('conflict: edit vs edit on multiple forces — each force resolves independently', () => {
  // Alice edits A and B both (compound change). Bob edits only A.
  // Alice merges first → main has both alice's A-edit and B-edit.
  // Bob's rebase: he changed A, didn't change B. His A-edit wins.
  // Alice's B-edit is preserved (Bob didn't touch B).
  const baseline = [f('A', { lat: 0 }), f('B', { lat: 0 })];
  const aliceSnap = [f('A', { lat: 10 }), f('B', { lat: 10 })];
  const bobSnap = [f('A', { lat: 99 }), f('B', { lat: 0 })]; // bob only touched A

  let main = [f('A', { lat: 0 }), f('B', { lat: 0 })];
  main = rebaseForceFile(baseline, aliceSnap, main);
  assert.equal(byId(main, 'A').lat, 10);
  assert.equal(byId(main, 'B').lat, 10);

  main = rebaseForceFile(baseline, bobSnap, main);
  assert.equal(byId(main, 'A').lat, 99, 'bob\'s A-edit wins over alice\'s A-edit');
  assert.equal(byId(main, 'B').lat, 10, 'alice\'s B-edit preserved (bob didn\'t touch B)');
});

test('conflict: alice deletes F, bob edits F — alice\'s delete wins (force is gone, edit moot)', () => {
  // Alice deleted F → main: [].
  // Bob's baseline still had F; his snapshot edits F.
  // Bob's rebase: "in both, content differs → replace IN MAIN". main
  // doesn't have F → don't replace. F stays gone.
  const baseline = [f('F', { lat: 0 })];
  const mainAfterAlice = [];
  const bobSnap = [f('F', { lat: 80 })];
  const merged = rebaseForceFile(baseline, bobSnap, mainAfterAlice);
  assert.deepEqual(merged, [], 'F stays deleted; bob\'s edit silently dropped');
});

test('conflict: alice edits F, bob deletes F — bob\'s delete wins (player\'s explicit removal)', () => {
  // Alice's edit landed → main has F with alice's values.
  // Bob's baseline had F; his snapshot drops it (delete).
  // Removals run before adds/edits in the rebase, so F is dropped
  // unconditionally. Alice's edit is discarded along with the force.
  const baseline = [f('F', { lat: 0 })];
  const mainAfterAlice = [f('F', { lat: 50 })];
  const bobSnap = [];
  const merged = rebaseForceFile(baseline, bobSnap, mainAfterAlice);
  assert.deepEqual(merged, [], 'bob\'s delete wins; alice\'s edit removed with the force');
});

test('conflict: same id appears in alice and bob\'s adds — main\'s value wins (deterministic-id collision defense)', () => {
  // Both add a new force "X" (would only happen if the deterministic
  // id scheme breaks — same login, same millisecond, same seq — but
  // be defensive). Alice merges first → main has X with alice's content.
  // Bob's add: his baseline doesn't have X, his snapshot does. Rebase
  // "add" branch: skip if main already has the id. So bob's add is
  // silently dropped, alice's X survives.
  const baseline = [];
  const aliceSnap = [f('X', { lat: 1 })];
  let main = [];
  main = rebaseForceFile(baseline, aliceSnap, main);
  assert.equal(byId(main, 'X').lat, 1);

  const bobSnap = [f('X', { lat: 999 })];
  main = rebaseForceFile(baseline, bobSnap, main);
  assert.equal(byId(main, 'X').lat, 1, 'alice\'s X survives; bob\'s collision-add discarded');
});

// ────────────────────────────────────────────────────────────────────
// Three-way cascade — three players in the same nation, sequential
// merges. The rebase must compose cleanly across all of them.
// ────────────────────────────────────────────────────────────────────

test('cascade-3: three players add disjoint forces; all preserved', () => {
  const baseline = [f('A')];
  const aliceSnap = [f('A'), f('B')];
  const bobSnap = [f('A'), f('C')];
  const carolSnap = [f('A'), f('D')];

  let main = [f('A')];
  main = rebaseForceFile(baseline, aliceSnap, main); // [A, B]
  main = rebaseForceFile(baseline, bobSnap, main); // [A, B, C]
  main = rebaseForceFile(baseline, carolSnap, main); // [A, B, C, D]
  assert.deepEqual(ids(main), ['A', 'B', 'C', 'D']);
});

test('cascade-3: three players each edit a different force in same nation', () => {
  const baseline = [f('A', { lat: 0 }), f('B', { lat: 0 }), f('C', { lat: 0 })];
  // Each player edits a different force AND leaves the others alone.
  const aliceSnap = [f('A', { lat: 10 }), f('B', { lat: 0 }), f('C', { lat: 0 })];
  const bobSnap = [f('A', { lat: 0 }), f('B', { lat: 20 }), f('C', { lat: 0 })];
  const carolSnap = [f('A', { lat: 0 }), f('B', { lat: 0 }), f('C', { lat: 30 })];

  let main = [f('A', { lat: 0 }), f('B', { lat: 0 }), f('C', { lat: 0 })];
  main = rebaseForceFile(baseline, aliceSnap, main);
  main = rebaseForceFile(baseline, bobSnap, main);
  main = rebaseForceFile(baseline, carolSnap, main);

  // All three edits preserved.
  assert.equal(byId(main, 'A').lat, 10);
  assert.equal(byId(main, 'B').lat, 20);
  assert.equal(byId(main, 'C').lat, 30);
});

test('cascade-3: mixed adds/edits/deletes across three players', () => {
  // Baseline: [A, B, C]
  // Alice: edits A, deletes B
  // Bob:   adds D, edits C (independent of alice's changes)
  // Carol: deletes A (which alice edited!), adds E
  //
  // Sequential merges, alice → bob → carol:
  //   after alice: [A(edited), C]                — B deleted
  //   after bob:   [A(edited), C(edited), D]
  //   after carol: [C(edited), D, E]             — A deleted, alice's edit discarded
  const baseline = [f('A', { lat: 0 }), f('B'), f('C', { lat: 0 })];
  const aliceSnap = [f('A', { lat: 50 }), f('C', { lat: 0 })]; // edit A, delete B
  const bobSnap = [f('A', { lat: 0 }), f('B'), f('C', { lat: 70 }), f('D')]; // edit C, add D
  const carolSnap = [f('B'), f('C', { lat: 0 }), f('E')]; // delete A, add E

  let main = [f('A', { lat: 0 }), f('B'), f('C', { lat: 0 })];
  main = rebaseForceFile(baseline, aliceSnap, main);
  assert.deepEqual(ids(main), ['A', 'C']);
  assert.equal(byId(main, 'A').lat, 50);

  main = rebaseForceFile(baseline, bobSnap, main);
  // Bob's baseline didn't reflect alice's changes. He left A and B as-is.
  // Rebase: A unchanged in bob's snapshot vs his baseline → preserve main
  // (alice's edit). B unchanged in his snapshot → preserve main (which
  // doesn't have B — alice deleted it). C: bob edited → apply. D: bob
  // added → apply.
  assert.deepEqual(ids(main), ['A', 'C', 'D']);
  assert.equal(byId(main, 'A').lat, 50, 'alice\'s A-edit still there');
  assert.equal(byId(main, 'C').lat, 70, 'bob\'s C-edit applied');

  main = rebaseForceFile(baseline, carolSnap, main);
  // Carol's baseline had A,B,C. She removes A, keeps B (as in baseline),
  // keeps C (as in baseline), adds E.
  // Rebase: A in baseline, not in carol's snapshot → DELETE from main.
  // B identical in baseline + carol's snapshot → preserve main (deleted).
  // C: identical content (lat:0) in baseline + carol's snapshot → preserve
  // main (which has bob's edit, lat:70). Carol's "unchanged" C respects
  // bob's edit. D not in baseline/snapshot → preserve main. E new → add.
  assert.deepEqual(ids(main), ['C', 'D', 'E']);
  assert.equal(byId(main, 'C').lat, 70, 'bob\'s C-edit survives carol\'s rebase');
});

// ────────────────────────────────────────────────────────────────────
// Merge-conflict avoidance — the textual git conflict cases that the
// rebase prevents from ever reaching the PR's mergeability check.
// ────────────────────────────────────────────────────────────────────

test('avoid: two players appending to the same nation file', () => {
  // Without rebase: both PRs write `[A, B]` vs `[A, C]` against the same
  // base `[A]`. Git's textual merge sees both modifying the line that
  // closes the array and flags a conflict.
  // With rebase: alice commits `[A, B]`; bob's worker rebases at submit
  // time against the now-updated main `[A, B]`, produces `[A, B, C]`,
  // and his PR has no textual conflict with main.
  const baseline = [f('A')];
  let main = [f('A')];

  // Alice submits.
  main = rebaseForceFile(baseline, [f('A'), f('B')], main);
  assert.deepEqual(ids(main), ['A', 'B']);

  // Carol's worker fetches main (now [A, B]) and rebases her stale
  // snapshot ([A, C]) against it.
  const carolMerged = rebaseForceFile(baseline, [f('A'), f('C')], main);
  assert.deepEqual(ids(carolMerged), ['A', 'B', 'C']);
});

test('avoid: two players deleting different forces from same nation', () => {
  // Without rebase: both PRs write `[B]` vs `[A]` against `[A, B]`.
  // Each PR removes a different line; depending on git's heuristics
  // these can still merge, but the rebase guarantees a clean output.
  const baseline = [f('A'), f('B')];
  let main = [f('A'), f('B')];

  main = rebaseForceFile(baseline, [f('B')], main); // alice deletes A
  assert.deepEqual(ids(main), ['B']);

  const carolMerged = rebaseForceFile(baseline, [f('A')], main); // carol deletes B
  assert.deepEqual(ids(carolMerged), [], 'both deletes applied; no conflict');
});

test('avoid: heavy concurrent churn — five players in same nation, all add', () => {
  // Worst case for textual conflicts: every player tries to append a
  // new entry at the end of the array. Five rebases composed.
  const baseline = [f('seed')];
  let main = [f('seed')];

  const players = ['a', 'b', 'c', 'd', 'e'];
  for (const p of players) {
    const snap = [f('seed'), f(`${p}-new`, { name: `${p}-corps` })];
    main = rebaseForceFile(baseline, snap, main);
  }

  assert.deepEqual(ids(main), ['a-new', 'b-new', 'c-new', 'd-new', 'e-new', 'seed']);
});

// ────────────────────────────────────────────────────────────────────
// Complex single-submission shapes — add + edit + delete combined.
// ────────────────────────────────────────────────────────────────────

test('compound: single submission with add + edit + delete; concurrent main changes preserved', () => {
  // Baseline: [A, B, C]
  // Player's intent: edit A, delete B, add D. (C untouched.)
  // Meanwhile in main: someone edited C and added E.
  const baseline = [f('A', { lat: 0 }), f('B'), f('C', { lat: 0 })];
  const snapshot = [
    f('A', { lat: 88 }), // edit
    f('C', { lat: 0 }), // unchanged
    f('D'), // add
    // B deleted
  ];
  const main = [
    f('A', { lat: 0 }),
    f('B'),
    f('C', { lat: 77 }), // concurrent edit
    f('E'), // concurrent add
  ];
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.deepEqual(ids(out), ['A', 'C', 'D', 'E']);
  assert.equal(byId(out, 'A').lat, 88, 'player\'s A-edit applied');
  assert.equal(byId(out, 'C').lat, 77, 'main\'s C-edit preserved (player didn\'t touch C)');
});

test('compound: player edits a force that another player concurrently added — main\'s add wins', () => {
  // Baseline: []
  // Player adds X with lat=10 in their snapshot.
  // Meanwhile, someone else added X with lat=50 to main first.
  // Player's add is dropped (id collision defense); main's X survives.
  const baseline = [];
  const snapshot = [f('X', { lat: 10 })];
  const main = [f('X', { lat: 50 })];
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.equal(byId(out, 'X').lat, 50);
});

// ────────────────────────────────────────────────────────────────────
// Edge cases — empty arrays, content equality, defensive behavior.
// ────────────────────────────────────────────────────────────────────

test('edge: all three inputs empty → empty output', () => {
  assert.deepEqual(rebaseForceFile([], [], []), []);
});

test('edge: baseline empty, snapshot has adds, main has unrelated forces — both preserved', () => {
  const baseline = [];
  const snapshot = [f('new1'), f('new2')];
  const main = [f('existing')];
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.deepEqual(ids(out), ['existing', 'new1', 'new2']);
});

test('edge: snapshot identical to baseline — output equals main verbatim', () => {
  // Player has no intent (snapshot == baseline). Output must equal main
  // exactly, preserving anything concurrent edits put there.
  const baseline = [f('A'), f('B')];
  const snapshot = [f('A'), f('B')];
  const main = [f('A', { lat: 99 }), f('B'), f('C')]; // main moved
  const out = rebaseForceFile(baseline, snapshot, main);
  assert.deepEqual(out, main);
});

test('edge: main empty (file was just deleted by another concurrent op)', () => {
  // Player's baseline had forces. Concurrent op removed them all (e.g.
  // admin cleared the nation file). Player's snapshot edits remain.
  // Per "edit only if main has the force": main empty → no edits apply.
  // Per "add only if main doesn't have the id": adds go through (main
  // has nothing).
  const baseline = [f('A'), f('B')];
  const snapshot = [f('A', { lat: 99 }), f('B'), f('C')]; // edit A, add C
  const main = [];
  const out = rebaseForceFile(baseline, snapshot, main);
  // A's edit dropped (main empty), C added.
  assert.deepEqual(ids(out), ['C']);
});

// ────────────────────────────────────────────────────────────────────
// Retry safety — the same client retrying after a partial failure must
// converge, not double-apply or duplicate.
// ────────────────────────────────────────────────────────────────────

test('retry: rebase twice with same inputs vs once-with-merged → same final state', () => {
  const baseline = [f('A'), f('B')];
  const snapshot = [f('A', { lat: 50 }), f('C')]; // edit A, delete B, add C
  const main = [f('A'), f('B')];

  const once = rebaseForceFile(baseline, snapshot, main);
  const twice = rebaseForceFile(baseline, snapshot, once);

  assert.deepEqual(ids(once), ids(twice));
  // The once-merged result should be stable when re-rebased — no
  // ghost adds, no resurrected deletes.
  assert.equal(byId(twice, 'A').lat, 50);
  assert.equal(byId(twice, 'C').id, 'C');
});

test('retry: after main moved between attempts, retry rebases against new main', () => {
  // Player submits, succeeds. Network blip, client retries the same
  // submission. Meanwhile, another player merged. The retry sees the
  // updated main and merges cleanly.
  const baseline = [f('A')];
  const snapshot = [f('A'), f('B')]; // player adds B

  // First attempt: main = [A], merge → [A, B]
  let main = [f('A')];
  main = rebaseForceFile(baseline, snapshot, main);

  // Someone else added C in the meantime.
  main = [...main, f('C')];

  // Retry: baseline still [A], snapshot still [A, B], main now [A, B, C].
  const retried = rebaseForceFile(baseline, snapshot, main);
  assert.deepEqual(ids(retried), ['A', 'B', 'C'], 'B not duplicated; C preserved');
});

// ────────────────────────────────────────────────────────────────────
// Non-deterministic ordering — the result depends only on contents,
// not on the input arrays' positional order.
// ────────────────────────────────────────────────────────────────────

test('order: shuffling input array order doesn\'t change output set', () => {
  const baseline = [f('A'), f('B'), f('C')];
  const snapshot = [f('A'), f('B'), f('C'), f('D')];
  const main = [f('A'), f('B'), f('C')];

  // Same logical inputs, different positional order.
  const baselineShuffled = [f('C'), f('A'), f('B')];
  const snapshotShuffled = [f('D'), f('B'), f('C'), f('A')];
  const mainShuffled = [f('B'), f('C'), f('A')];

  const out1 = rebaseForceFile(baseline, snapshot, main);
  const out2 = rebaseForceFile(baselineShuffled, snapshotShuffled, mainShuffled);
  assert.deepEqual(ids(out1), ids(out2));
});

// ────────────────────────────────────────────────────────────────────
// Multi-nation isolation — two nations' PRs at the same time should
// not interfere with each other at all. The rebase function operates
// per nation, so file-per-nation gives us this isolation for free —
// these tests prove it explicitly.
// ────────────────────────────────────────────────────────────────────

test('multi-nation: two different nations submit concurrently; rebases are independent', () => {
  // Each nation has its own baseline, snapshot, and main slice.
  // Alice (spain) and Bob (france) both submit at the same instant.
  // Their rebases share no state — neither can affect the other.
  const spainBase = [f('s1', { nation: 'spain' })];
  const spainSnap = [f('s1', { nation: 'spain' }), f('s2', { nation: 'spain' })];
  const spainMain = [f('s1', { nation: 'spain' })];

  const franceBase = [f('f1', { nation: 'france' })];
  const franceSnap = [f('f1', { nation: 'france' }), f('f2', { nation: 'france' })];
  const franceMain = [f('f1', { nation: 'france' })];

  const spainMerged = rebaseForceFile(spainBase, spainSnap, spainMain);
  const franceMerged = rebaseForceFile(franceBase, franceSnap, franceMain);

  assert.deepEqual(ids(spainMerged), ['s1', 's2']);
  assert.deepEqual(ids(franceMerged), ['f1', 'f2']);
});

test('multi-nation: alice (spain) submits AFTER bob (france) merged; spain main untouched', () => {
  // Whatever happens in france.json never reaches the spain rebase —
  // they\'re different files, different inputs.
  const aliceBaseSpain = [f('s1', { nation: 'spain' })];
  const aliceSnapSpain = [f('s1', { nation: 'spain' }), f('s2', { nation: 'spain' })];
  // Bob's france merge already landed (main.france updated) — irrelevant
  // to alice's spain rebase. main_spain is unchanged from her baseline.
  const mainSpain = [f('s1', { nation: 'spain' })];

  const merged = rebaseForceFile(aliceBaseSpain, aliceSnapSpain, mainSpain);
  assert.deepEqual(ids(merged), ['s1', 's2']);
});

test('multi-nation: ten different nations all rebase independently, no cross-talk', () => {
  // Simulates the worker iterating over allNations for an admin commit:
  // each nation file's rebase is its own pure call.
  const nations = ['spain', 'france', 'austria', 'prussia', 'russia',
                   'britain', 'sweden', 'denmark', 'poland', 'bulgaria'];

  for (const n of nations) {
    const base = [f(`${n}-1`, { nation: n })];
    const snap = [f(`${n}-1`, { nation: n }), f(`${n}-2`, { nation: n })];
    const main = [f(`${n}-1`, { nation: n })];
    const out = rebaseForceFile(base, snap, main);
    assert.deepEqual(ids(out), [`${n}-1`, `${n}-2`]);
    // Each force's nation matches its filename — no leakage.
    for (const x of out) assert.equal(x.nation, n);
  }
});

// ────────────────────────────────────────────────────────────────────
// Same-nation races — two players in the SAME nation submit
// concurrently. This is the multi-player-per-nation hot spot.
// ────────────────────────────────────────────────────────────────────

test('same-nation race: simultaneous adds — second worker sees first\'s commit in main', () => {
  // T0: both players bootstrap, baseline = [seed].
  // T1: alice clicks submit; worker reads main ([seed]), rebases, commits [seed, A].
  // T2: while alice's PR auto-merges, carol clicks submit; worker reads
  //     main (now [seed, A]), rebases against carol's baseline ([seed]),
  //     applies carol's add → [seed, A, C].
  // Crucially: carol's worker reads main JUST-IN-TIME, so it sees alice's
  // commit. Even if her local UI hadn't refreshed, the server-side rebase
  // is against the freshest main.
  const baseline = [f('seed')];
  let main = [f('seed')];

  // Alice submits first.
  const aliceMerged = rebaseForceFile(baseline, [f('seed'), f('alice-A')], main);
  assert.deepEqual(ids(aliceMerged), ['alice-A', 'seed']);
  main = aliceMerged; // alice merged

  // Carol submits — worker reads fresh main here.
  const carolMerged = rebaseForceFile(baseline, [f('seed'), f('carol-C')], main);
  assert.deepEqual(ids(carolMerged), ['alice-A', 'carol-C', 'seed']);
});

test('same-nation race: same player edits force F, while another deletes F', () => {
  // Both started from [F].
  // Alice deletes F → main = [].
  // Carol edits F.lat = 99; her worker rebases against current main []
  // (which has no F). Carol's edit is dropped. Alice's intent survives.
  const baseline = [f('F', { lat: 0 })];
  let main = [f('F', { lat: 0 })];

  main = rebaseForceFile(baseline, [], main); // alice deletes
  assert.deepEqual(main, []);

  const carolMerged = rebaseForceFile(baseline, [f('F', { lat: 99 })], main);
  assert.deepEqual(carolMerged, [], 'F stays deleted');
});

test('same-nation race: edit-then-edit-then-delete sequence', () => {
  // Three players in same nation, each touching same force F.
  // Alice moves F to lat=10; Bob moves F to lat=20; Carol deletes F.
  // All started from F at lat=0. Sequential merges in submission order.
  const baseline = [f('F', { lat: 0 })];
  let main = [f('F', { lat: 0 })];

  main = rebaseForceFile(baseline, [f('F', { lat: 10 })], main);
  assert.equal(byId(main, 'F').lat, 10);

  main = rebaseForceFile(baseline, [f('F', { lat: 20 })], main);
  assert.equal(byId(main, 'F').lat, 20, 'bob\'s edit overwrites alice\'s');

  main = rebaseForceFile(baseline, [], main);
  assert.deepEqual(main, [], 'carol\'s delete wipes everything');
});

test('same-nation race: 5 players add, all preserved in commit order', () => {
  // Simulates a thundering herd of new-force submissions to the same
  // nation. Each player\'s baseline was [seed]; each adds one force.
  const baseline = [f('seed')];
  let main = [f('seed')];

  const submissions = [
    [f('seed'), f('p1-corps', { commander: 'p1' })],
    [f('seed'), f('p2-corps', { commander: 'p2' })],
    [f('seed'), f('p3-corps', { commander: 'p3' })],
    [f('seed'), f('p4-corps', { commander: 'p4' })],
    [f('seed'), f('p5-corps', { commander: 'p5' })],
  ];
  for (const snap of submissions) {
    main = rebaseForceFile(baseline, snap, main);
  }
  assert.deepEqual(
    ids(main),
    ['p1-corps', 'p2-corps', 'p3-corps', 'p4-corps', 'p5-corps', 'seed'],
    'all five adds preserved; seed survived',
  );
});

test('same-nation race: player\'s no-op submission is a literal no-op even when main drifted', () => {
  // Alice's snapshot is identical to her baseline (she made no changes).
  // Meanwhile, four other players added forces. Alice\'s rebase output
  // must equal main exactly — no resurrections, no duplicates.
  const baseline = [f('A')];
  const aliceSnap = [f('A')]; // no intent
  const drifted = [f('A'), f('B'), f('C'), f('D'), f('E')];

  const out = rebaseForceFile(baseline, aliceSnap, drifted);
  assert.deepEqual(out, drifted);
});

// ────────────────────────────────────────────────────────────────────
// Main drift — long timelines where main moves many times between
// when the player loaded and when their commit lands.
// ────────────────────────────────────────────────────────────────────

test('drift: 10 concurrent merges between player\'s load and submit; player\'s intent survives', () => {
  // Player\'s baseline frozen at the start.
  const baseline = [f('seed', { nation: 'spain' })];
  // Player\'s intent: add one new force.
  const snapshot = [f('seed', { nation: 'spain' }), f('player-new', { nation: 'spain' })];

  // 10 other players merged in the meantime.
  let main = [f('seed', { nation: 'spain' })];
  for (let i = 0; i < 10; i++) {
    main = [...main, f(`drifter-${i}`, { nation: 'spain' })];
  }

  const out = rebaseForceFile(baseline, snapshot, main);
  // All 10 drifters preserved + player\'s new force + seed.
  assert.equal(out.length, 12);
  assert.ok(byId(out, 'player-new'), 'player\'s add survived');
  for (let i = 0; i < 10; i++) {
    assert.ok(byId(out, `drifter-${i}`), `drifter ${i} survived`);
  }
});

test('drift: main moves WHILE player\'s submit is in flight; rebase produces correct merge', () => {
  // The realistic scenario: player\'s submit started, but the worker
  // hadn\'t yet read main. By the time it does, main has moved.
  const baseline = [f('A'), f('B')];
  const snapshot = [f('A', { lat: 100 }), f('B'), f('C')]; // player\'s intent: edit A, add C

  // Worker reads main here — and main has been updated by another player
  // who added D in the milliseconds since the player\'s baseline was taken.
  const mainAtCommitTime = [f('A'), f('B'), f('D')];

  const out = rebaseForceFile(baseline, snapshot, mainAtCommitTime);
  assert.deepEqual(ids(out), ['A', 'B', 'C', 'D']);
  assert.equal(byId(out, 'A').lat, 100, 'player\'s A-edit applied');
  assert.ok(byId(out, 'D'), 'concurrent drifter D preserved');
});

test('drift: snapshot was taken AFTER baseline but BEFORE last main update', () => {
  // Three-time-points scenario: T0 baseline, T1 snapshot (player paused
  // briefly), T2 main update (other player), T3 worker reads main.
  // The rebase only cares about (baseline, snapshot, current main).
  const baseline = [f('A')];
  const snapshot = [f('A'), f('player-B')]; // taken at T1
  // After T1, someone else added C. Worker reads main at T3:
  const main = [f('A'), f('other-C')];

  const out = rebaseForceFile(baseline, snapshot, main);
  assert.deepEqual(ids(out), ['A', 'other-C', 'player-B']);
});

test('drift: player\'s baseline force was DELETED then RE-ADDED with different content in main', () => {
  // Pathological: force X was in player\'s baseline. In the interim,
  // another player deleted X, then yet another added a new X with
  // completely different content (only possible if deterministic ids
  // weren\'t deterministic, but be defensive).
  // Player\'s snapshot has X unchanged from their baseline.
  // Rebase: baseline.X equals snapshot.X (no edit intent), preserve main\'s X.
  const baseline = [f('X', { lat: 0, commander: 'original' })];
  const snapshot = [f('X', { lat: 0, commander: 'original' })]; // unchanged
  const main = [f('X', { lat: 999, commander: 'completely different' })];

  const out = rebaseForceFile(baseline, snapshot, main);
  assert.equal(byId(out, 'X').commander, 'completely different',
    'player didn\'t intend to change X — main\'s version preserved');
});

test('drift: stress — 20 sequential rebases interspersed with main drift', () => {
  // Worst case: every other rebase, an "external" force gets added to
  // main by some other workflow. Each player adds their own force.
  // After 20 iterations, every player\'s add and every drifter must
  // be present.
  const baseline = [f('seed')];
  let main = [f('seed')];

  for (let i = 0; i < 20; i++) {
    // Player i submits an add.
    main = rebaseForceFile(baseline, [f('seed'), f(`player-${i}`)], main);
    // Main drift: another player not going through the rebase adds
    // an outside force (e.g. admin direct push, validator bot, etc).
    if (i % 2 === 0) main = [...main, f(`outside-${i}`)];
  }

  // Expect: seed, 20 player adds, 10 outside drifters = 31 forces.
  assert.equal(main.length, 31);
  assert.ok(byId(main, 'seed'));
  for (let i = 0; i < 20; i++) assert.ok(byId(main, `player-${i}`), `player-${i} preserved`);
  for (let i = 0; i < 20; i += 2) assert.ok(byId(main, `outside-${i}`), `outside-${i} preserved`);
});

// ────────────────────────────────────────────────────────────────────
// "Two-nation PRs at the same time" worker-level scenario — proves
// that the worker iterating over (nation_a, nation_b) produces the
// same final state regardless of order. Important for admin PRs that
// touch multiple nation files.
// ────────────────────────────────────────────────────────────────────

test('admin: rebasing two nations in a single submission — order independence', () => {
  // Admin\'s submission has changes for both spain and france. The
  // worker iterates the union of nations; either order should yield
  // the same final state for each nation independently.
  const adminBaseSpain = [f('s1', { nation: 'spain' })];
  const adminSnapSpain = [f('s1', { nation: 'spain' }), f('s2', { nation: 'spain' })];
  const mainSpain = [f('s1', { nation: 'spain' })];

  const adminBaseFrance = [f('f1', { nation: 'france' })];
  const adminSnapFrance = [f('f1', { nation: 'france' }), f('f2', { nation: 'france' })];
  const mainFrance = [f('f1', { nation: 'france' })];

  const spainFirst = rebaseForceFile(adminBaseSpain, adminSnapSpain, mainSpain);
  const franceFirst = rebaseForceFile(adminBaseFrance, adminSnapFrance, mainFrance);

  // Doing france first then spain — same independent results.
  const franceAlsoFirst = rebaseForceFile(adminBaseFrance, adminSnapFrance, mainFrance);
  const spainAlsoSecond = rebaseForceFile(adminBaseSpain, adminSnapSpain, mainSpain);

  assert.deepEqual(ids(spainFirst), ids(spainAlsoSecond));
  assert.deepEqual(ids(franceFirst), ids(franceAlsoFirst));
});

// Adversarial tests for the v7 move validator. Each test is one
// scenario expressed as a fixture passed to the pure validateMove()
// function — no fs, no gh CLI, no network. Run with:
//
//   npm test
//
// Each test names its attack vector. If the validator regresses, the
// failure message tells you exactly which guarantee slipped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMove } from '../lib/validate-move-core.mjs';

// ────────────────────────────────────────────────────────────────────
// Fixture builders
// ────────────────────────────────────────────────────────────────────

function force(overrides = {}) {
  const lon = overrides.lon ?? -3.7;
  const lat = overrides.lat ?? 40.4;
  const strength = overrides.strength ?? 40000;
  const branch = overrides.branch ?? 'army';
  return {
    id: 'seed-0-0',
    nation: 'spain',
    branch,
    name: '1st Corps',
    strength,
    commander: 'Castaños',
    lon,
    lat,
    // Default to a stationary force at turn start — passes the budget gate.
    turnStartLon: overrides.turnStartLon ?? lon,
    turnStartLat: overrides.turnStartLat ?? lat,
    kmMovedThisTurn: overrides.kmMovedThisTurn ?? 0,
    // Same idea for strength: unchanged since turn start, so the force
    // has recruited nothing and passes the raise-budget gate. That is the
    // shape of an EXISTING force (and of every backfilled legacy one) —
    // a force meant to read as "raised this turn" must pass
    // turnStartStrength: 0 explicitly, because a zero anchor is now the
    // only thing that makes a force bill its whole strength.
    turnStartStrength: overrides.turnStartStrength ?? strength,
    // The anchor's branch identity. Defaults to the current branch: a
    // force that has not re-branded started the turn where it is now.
    turnStartBranch: overrides.turnStartBranch ?? branch,
    ...overrides,
  };
}

function stateFile(overrides = {}) {
  return {
    appVersion: 'theatrum/v10',
    ownerships: [
      [0, 'spain'],
      [1, 'france'],
      [2, 'spain'],
    ],
    countries: [
      { name: 'spain', color: '#1F4E9C' },
      { name: 'france', color: '#D7837F' },
    ],
    ...overrides,
  };
}

function turnFile(overrides = {}) {
  return {
    appVersion: 'theatrum/v10',
    currentDate: '1680-01-01',
    lastTurnDays: 30,
    turnNumber: 0,
    ...overrides,
  };
}

function forcesMap(overrides = {}) {
  return {
    spain: [force({ id: 'spain-1', nation: 'spain', name: '1st Corps' })],
    france: [force({ id: 'france-1', nation: 'france', name: 'Grande Armée', commander: 'Bonaparte' })],
    ...overrides,
  };
}

const PERMS = {
  master: { role: 'admin' },
  alice: { role: 'player', nation: 'spain' },
  bob: { role: 'player', nation: 'france' },
  // Mixed-case nation in perm.json — must still resolve to the lowercase file.
  carol: { role: 'player', nation: 'Spain' },
  // A registered user with no nation — borked entry.
  dangling: { role: 'player' },
};

function defaults(overrides = {}) {
  // Backfill turn on caller-supplied base/head so older tests written
  // before the state↔turn split don't have to be rewritten — they pass
  // { state, forces } and we transparently add a default turn.
  const base = overrides.base
    ? { state: stateFile(), turn: turnFile(), forces: forcesMap(), ...overrides.base }
    : { state: stateFile(), turn: turnFile(), forces: forcesMap() };
  const head = overrides.head
    ? { state: stateFile(), turn: turnFile(), forces: forcesMap(), ...overrides.head }
    : { state: stateFile(), turn: turnFile(), forces: forcesMap() };
  const { base: _b, head: _h, ...rest } = overrides;
  void _b;
  void _h;
  return {
    base,
    head,
    perms: PERMS,
    prAuthor: 'alice',
    changedFiles: ['public/data/forces/spain.json'],
    mergeable: true,
    ...rest,
  };
}

function expectReject(result, pattern) {
  assert.equal(result.valid, false, `expected reject, got pass: ${JSON.stringify(result)}`);
  if (pattern) assert.match(result.reason, pattern);
}

function expectPass(result) {
  assert.equal(result.valid, true, `expected pass, got reject: ${JSON.stringify(result)}`);
}

// ────────────────────────────────────────────────────────────────────
// Authorization
// ────────────────────────────────────────────────────────────────────

test('reject: random GitHub user not in perm.json', () => {
  expectReject(
    validateMove(defaults({ prAuthor: 'random_attacker' })),
    /not registered/,
  );
});

test('reject: registered user with no role/nation field', () => {
  expectReject(
    validateMove(defaults({ prAuthor: 'dangling' })),
    /no playable role/,
  );
});

test('reject: registered user with explicitly garbage role', () => {
  expectReject(
    validateMove(
      defaults({
        prAuthor: 'eve',
        perms: { ...PERMS, eve: { role: 'superuser', nation: 'spain' } },
      }),
    ),
    /no playable role/,
  );
});

// ────────────────────────────────────────────────────────────────────
// File scope: players are quarantined to their nation's force file
// ────────────────────────────────────────────────────────────────────

test('reject: player tries to edit perm.json (privilege escalation)', () => {
  expectReject(
    validateMove(
      defaults({
        changedFiles: ['public/data/forces/spain.json', 'public/data/perm.json'],
      }),
    ),
    /modifies files outside/,
  );
});

test('reject: player tries to edit state.json (province ownership)', () => {
  expectReject(
    validateMove(
      defaults({
        changedFiles: ['public/data/forces/spain.json', 'public/data/state.json'],
      }),
    ),
    /modifies files outside/,
  );
});

test('reject: player tries to edit a workflow file', () => {
  expectReject(
    validateMove(
      defaults({
        changedFiles: ['public/data/forces/spain.json', '.github/workflows/validate-and-merge.yml'],
      }),
    ),
    /modifies files outside/,
  );
});

test('reject: player tries to add a brand-new file', () => {
  expectReject(
    validateMove(
      defaults({
        changedFiles: ['public/data/forces/spain.json', 'src/payload.ts'],
      }),
    ),
    /modifies files outside/,
  );
});

test('reject: player tries to edit another nation\'s force file', () => {
  expectReject(
    validateMove(
      defaults({
        changedFiles: ['public/data/forces/france.json'],
      }),
    ),
    /modifies files outside/,
  );
});

// ────────────────────────────────────────────────────────────────────
// Force/file consistency invariants (universal — admins too)
// ────────────────────────────────────────────────────────────────────

test('reject: force in spain.json with nation=france (impersonation)', () => {
  const head = {
    state: stateFile(),
    forces: {
      ...forcesMap(),
      // Player puts a france-nation force inside their own file.
      spain: [
        force({ id: 'spain-1', nation: 'spain' }),
        force({ id: 'sneaky', nation: 'france', name: 'Phantom Army' }),
      ],
    },
  };
  expectReject(validateMove(defaults({ head })), /declares nation "france"; must match filename/);
});

test('reject: numeric force id (must be string)', () => {
  const head = {
    state: stateFile(),
    forces: {
      ...forcesMap(),
      spain: [
        force({ id: 'spain-1', nation: 'spain' }),
        // Cast to bypass the helper's string default
        { ...force({ id: 'x', nation: 'spain', name: 'Numeric' }), id: 999 },
      ],
    },
  };
  expectReject(validateMove(defaults({ head })), /not a string/);
});

test('reject: duplicate force id across nation files', () => {
  const head = {
    state: stateFile(),
    forces: {
      spain: [force({ id: 'dup', nation: 'spain' })],
      france: [force({ id: 'dup', nation: 'france', name: 'Collision' })],
    },
  };
  expectReject(validateMove(defaults({ head })), /duplicate force id dup/);
});

test('reject: duplicate force id within a single nation file', () => {
  const head = {
    state: stateFile(),
    forces: {
      ...forcesMap(),
      spain: [
        force({ id: 'spain-1', nation: 'spain' }),
        force({ id: 'spain-1', nation: 'spain', name: 'Decoy' }),
      ],
    },
  };
  expectReject(validateMove(defaults({ head })), /duplicate force id/);
});

test('reject: orphan force file (country removed but file kept)', () => {
  const head = {
    state: stateFile({
      countries: [{ name: 'france', color: '#D7837F' }], // spain removed
    }),
    forces: forcesMap(), // spain.json still has forces
  };
  expectReject(
    validateMove(defaults({ head, prAuthor: 'master' })),
    /forces\/spain\.json exists but spain is not in state\.json countries/,
  );
});

// ────────────────────────────────────────────────────────────────────
// Schema gate — stale browser clients can't regress the file shape
// ────────────────────────────────────────────────────────────────────

test('reject: appVersion is the legacy v6 (stale client)', () => {
  const head = { state: stateFile({ appVersion: 'theatrum/v6' }), forces: forcesMap() };
  expectReject(validateMove(defaults({ head })), /appVersion mismatch/);
});

test('reject: appVersion is missing entirely (very stale client)', () => {
  const head = { state: stateFile(), forces: forcesMap() };
  delete head.state.appVersion;
  expectReject(validateMove(defaults({ head })), /appVersion mismatch/);
});

test('reject: schema gate fires before admin bypass (admin\'s stale client too)', () => {
  // The production failure mode that triggered this redesign: an admin's
  // cached old client submitted v6 and the admin bypass let it through.
  // Must NOT happen.
  const head = { state: stateFile({ appVersion: 'theatrum/v6' }), forces: forcesMap() };
  expectReject(
    validateMove(defaults({ prAuthor: 'master', head })),
    /appVersion mismatch/,
  );
});

// ────────────────────────────────────────────────────────────────────
// Mergeability gate
// ────────────────────────────────────────────────────────────────────

test('reject: PR has merge conflicts', () => {
  expectReject(validateMove(defaults({ mergeable: false })), /merge conflict/);
});

test('reject: GitHub couldn\'t determine mergeability (still pending)', () => {
  expectReject(validateMove(defaults({ mergeable: null })), /mergeability could not be determined/);
});

// ────────────────────────────────────────────────────────────────────
// Happy paths — legitimate player actions must pass
// ────────────────────────────────────────────────────────────────────

test('pass: player legitimately moves their own force', () => {
  const head = {
    state: stateFile(),
    forces: {
      ...forcesMap(),
      spain: [force({ id: 'spain-1', nation: 'spain', lat: 41, lon: -4 })],
    },
  };
  expectPass(validateMove(defaults({ head })));
});

test('pass: player adds a new force of their own nation', () => {
  // A force raised this turn carries a zero anchor: it charges its whole
  // strength against the cap (15000 is exactly one month) and adds
  // nothing to the nation's anchor sum, so both gates are satisfied.
  const head = {
    state: stateFile(),
    forces: {
      ...forcesMap(),
      spain: [
        force({ id: 'spain-1', nation: 'spain' }),
        force({
          id: 'alice-123-0', nation: 'spain', name: '2nd Corps',
          strength: 15000, turnStartStrength: 0, createdAtTurn: 0,
        }),
      ],
    },
  };
  expectPass(validateMove(defaults({ head })));
});

test('pass: player removes one of their own forces', () => {
  const head = {
    state: stateFile(),
    forces: {
      ...forcesMap(),
      spain: [], // alice deletes her one force
    },
  };
  expectPass(validateMove(defaults({ head })));
});

test('pass: case-insensitive nation match (perm.json has TitleCase)', () => {
  expectPass(validateMove(defaults({ prAuthor: 'carol' })));
});

test('pass: deterministic string IDs from multiple players in same nation', () => {
  // Two spain players added forces — both ids namespaced by their own
  // login, so no collision. Both are raises (anchor 0) and together they
  // come to exactly the 15000 the 30-day turn allows.
  const head = {
    state: stateFile(),
    forces: {
      ...forcesMap(),
      spain: [
        force({ id: 'spain-1', nation: 'spain' }),
        force({
          id: 'alice-1715551200000-0', nation: 'spain', name: 'Reserve',
          strength: 10000, turnStartStrength: 0, createdAtTurn: 0,
        }),
        force({
          id: 'carol-1715551200001-0', nation: 'spain', name: 'Aragón',
          strength: 5000, turnStartStrength: 0, createdAtTurn: 0,
        }),
      ],
    },
  };
  expectPass(validateMove(defaults({ head })));
});

// ────────────────────────────────────────────────────────────────────
// Admin bypass — master can do anything (modulo schema + consistency)
// ────────────────────────────────────────────────────────────────────

test('pass: admin moves an enemy force', () => {
  const head = {
    state: stateFile(),
    forces: {
      ...forcesMap(),
      france: [
        force({ id: 'france-1', nation: 'france', name: 'Grande Armée', commander: 'Bonaparte', lat: 0, lon: 0 }),
      ],
    },
  };
  expectPass(
    validateMove(defaults({ head, prAuthor: 'master', changedFiles: ['public/data/forces/france.json'] })),
  );
});

test('pass: admin changes ownership', () => {
  const head = {
    state: stateFile({
      ownerships: [
        [0, 'france'],
        [1, 'france'],
        [2, 'france'],
      ],
    }),
    forces: forcesMap(),
  };
  expectPass(
    validateMove(defaults({ head, prAuthor: 'master', changedFiles: ['public/data/state.json'] })),
  );
});

// A country rename empties one force file and fills another: RENAME_COUNTRY
// rewrites force.nation, so whole ids move from forces/spain.json into
// forces/spain-empire.json and the receiving file had no anchors at base.
// Anchor conservation pairs base to head BY ID across every nation file,
// never by nation+id, which is exactly what lets these two tests both
// pass — mid-turn and on the turn advance alike.
const RENAME = {
  state: stateFile({
    countries: [
      { name: 'spain-empire', color: '#1F4E9C' },
      { name: 'france', color: '#D7837F' },
    ],
  }),
  forces: {
    // forces/spain.json deleted; forces/spain-empire.json created with renamed nation
    'spain-empire': [force({ id: 'spain-1', nation: 'spain-empire', name: '1st Corps' })],
    france: forcesMap().france,
  },
};
const RENAME_FILES = [
  'public/data/state.json',
  'public/data/forces/spain.json',
  'public/data/forces/spain-empire.json',
];

test('pass: admin renames a country mid-turn (anchors follow their ids into the new file)', () => {
  // The case id-pairing exists for. forces/spain-empire.json holds anchors
  // its own nation never had at base, so a per-nation anchor SUM rejects
  // it and a shipped admin feature becomes unsubmittable until the next
  // turn advance. Paired by id, spain-1 funds itself wherever its file
  // now lives. Note that spain never appears in the head scope at all —
  // its file is gone — so this only works because BASE is indexed whole.
  expectPass(
    validateMove(defaults({ head: RENAME, prAuthor: 'master', changedFiles: RENAME_FILES })),
  );
});

test('pass: admin renames a country on the turn advance (conservation skipped)', () => {
  // turnNumber moves, so every anchor is expected to reset — the gate
  // does not run and the rename goes through. Admin-only by file scope.
  expectPass(
    validateMove(
      defaults({
        head: { ...RENAME, turn: turnFile({ turnNumber: 1 }) },
        prAuthor: 'master',
        changedFiles: [...RENAME_FILES, 'public/data/turn.json'],
      }),
    ),
  );
});

test('pass: admin perm-only PR (no state.json or force edits)', () => {
  expectPass(
    validateMove(
      defaults({
        prAuthor: 'master',
        changedFiles: ['public/data/perm.json'],
      }),
    ),
  );
});

// ────────────────────────────────────────────────────────────────────
// Bot-authored PRs (the worker submitting as the App)
// ────────────────────────────────────────────────────────────────────

const BOT = 'theatrumauth[bot]';
const marker = (login) => `Some prose.\n\n<!-- theatrum-submitter: ${login} -->`;

test('reject: bot PR with no body marker', () => {
  expectReject(
    validateMove(
      defaults({
        prAuthor: BOT,
        prBody: 'plain prose, no marker',
      }),
    ),
    /missing the theatrum-submitter marker/,
  );
});

test('reject: bot PR with marker pointing to an unregistered user', () => {
  expectReject(
    validateMove(
      defaults({
        prAuthor: BOT,
        prBody: marker('randomattacker'),
      }),
    ),
    /not registered/,
  );
});

test('pass: bot PR with marker for an admin', () => {
  expectPass(
    validateMove(
      defaults({
        prAuthor: BOT,
        prBody: marker('master'),
        changedFiles: ['public/data/state.json'],
        head: {
          state: stateFile({
            ownerships: [[0, 'france'], [1, 'france'], [2, 'france']],
          }),
          forces: forcesMap(),
        },
      }),
    ),
  );
});

test('pass: bot PR with marker for a player moving their own force', () => {
  const head = {
    state: stateFile(),
    forces: {
      ...forcesMap(),
      spain: [force({ id: 'spain-1', nation: 'spain', lat: 41 })],
    },
  };
  expectPass(
    validateMove(
      defaults({
        prAuthor: BOT,
        prBody: marker('alice'),
        head,
      }),
    ),
  );
});

test('reject: bot PR with marker for a player editing another nation\'s file', () => {
  expectReject(
    validateMove(
      defaults({
        prAuthor: BOT,
        prBody: marker('alice'),
        changedFiles: ['public/data/forces/france.json'],
      }),
    ),
    /modifies files outside/,
  );
});

test('reject: bot PR with malformed marker (non-alphanumeric chars)', () => {
  expectReject(
    validateMove(
      defaults({
        prAuthor: BOT,
        prBody: '<!-- theatrum-submitter: not a login -->',
      }),
    ),
    /missing the theatrum-submitter marker/,
  );
});

test('pass: non-bot PR ignores stray marker', () => {
  // Real user opens a PR with a forged marker pointing to someone else —
  // the validator must NOT honor it.
  expectPass(
    validateMove(
      defaults({
        prAuthor: 'master',
        prBody: marker('not-a-real-login'),
      }),
    ),
  );
});

test('reject: non-bot PR with forged marker still uses pr.user.login', () => {
  expectReject(
    validateMove(
      defaults({
        prAuthor: 'random_attacker',
        prBody: marker('master'),
      }),
    ),
    /not registered/,
  );
});

// ────────────────────────────────────────────────────────────────────
// Per-force movement budget (army 25 km/day, navy 200 km/day)
// ────────────────────────────────────────────────────────────────────

// ~600 km due north of Madrid (5.4° of latitude). Exact-axis move so
// the displacement math is trivial: 5.4 × 111 ≈ 599 km.
const MOVED_600KM_LAT = 45.8;
const MOVED_600KM_LON = -3.7;

test('pass: army moves within budget (~600 km on a 30-day turn)', () => {
  const moved = force({
    id: 'spain-1',
    nation: 'spain',
    name: '1st Corps',
    lat: MOVED_600KM_LAT,
    lon: MOVED_600KM_LON,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    // Cumulative ≥ great-circle displacement (~600.5) and within 750 budget.
    kmMovedThisTurn: 601,
  });
  expectPass(
    validateMove(
      defaults({
        head: { state: stateFile(), forces: forcesMap({ spain: [moved] }) },
      }),
    ),
  );
});

test('reject: army exceeds budget (800 km cumulative on a 30-day turn)', () => {
  const cheating = force({
    id: 'spain-1',
    nation: 'spain',
    lat: 40.4,
    lon: -3.7,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 800,
  });
  expectReject(
    validateMove(
      defaults({
        head: { state: stateFile(), forces: forcesMap({ spain: [cheating] }) },
      }),
    ),
    /exceeded movement budget/,
  );
});

test('reject: navy exceeds budget at navy rate (7000 km on a 30-day turn)', () => {
  const fleet = force({
    id: 'spain-1',
    nation: 'spain',
    branch: 'navy',
    name: 'Cadiz Fleet',
    lat: 40.4,
    lon: -3.7,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 7000,
  });
  expectReject(
    validateMove(
      defaults({
        head: { state: stateFile(), forces: forcesMap({ spain: [fleet] }) },
      }),
    ),
    /exceeded movement budget/,
  );
});

test('pass: navy covers 6000 km on a 30-day turn (under navy budget of 6000)', () => {
  const atlantic = { id: 'spain-1', nation: 'spain', branch: 'navy', name: 'Atlantic Fleet' };
  const fleet = force({
    ...atlantic,
    lat: 40.4,
    lon: -3.7,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 6000,
  });
  expectPass(
    validateMove(
      defaults({
        // spain-1 is a fleet in base as well: leaving base's default army
        // in place would make this submission a re-brand, moving 40000 of
        // anchor into a navy pool that had none — a conservation
        // violation, and rightly so. This test is about the km budget.
        base: { forces: forcesMap({ spain: [force(atlantic)] }) },
        head: { state: stateFile(), forces: forcesMap({ spain: [fleet] }) },
      }),
    ),
  );
});

test('reject: kmMovedThisTurn < displacement (cheating client lied about path)', () => {
  // Force is now 600 km from turnStart, but client claims it only moved 0 km.
  // The sanity gate should catch this.
  const liar = force({
    id: 'spain-1',
    nation: 'spain',
    lat: MOVED_600KM_LAT,
    lon: MOVED_600KM_LON,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 0,
  });
  expectReject(
    validateMove(
      defaults({
        head: { state: stateFile(), forces: forcesMap({ spain: [liar] }) },
      }),
    ),
    /displacement.*exceeds reported movement/,
  );
});

test('reject: force missing turn-tracking fields (stale client bundle)', () => {
  const stale = force({ id: 'spain-1', nation: 'spain' });
  delete stale.turnStartLon;
  delete stale.kmMovedThisTurn;
  expectReject(
    validateMove(
      defaults({
        head: { state: stateFile(), forces: forcesMap({ spain: [stale] }) },
      }),
    ),
    /missing turn-tracking fields/,
  );
});

test('reject: turn.json missing lastTurnDays (stale schema)', () => {
  const turn = turnFile();
  delete turn.lastTurnDays;
  expectReject(
    validateMove(
      defaults({
        head: { state: stateFile(), turn, forces: forcesMap() },
      }),
    ),
    /lastTurnDays is missing/,
  );
});

test('reject: turn.json appVersion mismatch (stale schema)', () => {
  expectReject(
    validateMove(
      defaults({
        head: { state: stateFile(), turn: turnFile({ appVersion: 'theatrum/v7' }), forces: forcesMap() },
      }),
    ),
    /appVersion mismatch in turn\.json/,
  );
});

test('reject: player touching turn.json gets file-scope rejection', () => {
  expectReject(
    validateMove(
      defaults({
        head: {
          state: stateFile(),
          turn: turnFile({ currentDate: '1680-06-01' }),
          forces: forcesMap(),
        },
        // changedFiles still scoped to forces/spain.json — but base→head
        // turn drift trips the belt-and-suspenders gate.
      }),
    ),
    /turn\.json cannot be changed by players/,
  );
});

test('pass: longer turn unlocks more movement (900 km on a 90-day turn = 2250 budget)', () => {
  const moved = force({
    id: 'spain-1',
    nation: 'spain',
    lat: MOVED_600KM_LAT,
    lon: MOVED_600KM_LON,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 900,
  });
  // Bumping lastTurnDays is admin-only, and turn fields now live in
  // turn.json (separate file from state.json). The validator accepts
  // them as long as both base and head agree — admin "advance turn" PRs
  // appear here as already-bumped base + head, with the budget basis
  // taken from head.turn.
  expectPass(
    validateMove(
      defaults({
        base: { state: stateFile(), turn: turnFile({ lastTurnDays: 90 }), forces: forcesMap() },
        head: {
          state: stateFile(),
          turn: turnFile({ lastTurnDays: 90 }),
          forces: forcesMap({ spain: [moved] }),
        },
        prAuthor: 'master',
        changedFiles: ['public/data/turn.json', 'public/data/forces/spain.json'],
      }),
    ),
  );
});

test('reject: newly raised force cannot move during the turn it was raised', () => {
  // Force raised on turn 0 (= current turn) trying to move 100 km.
  const justRaised = force({
    id: 'spain-new-1',
    nation: 'spain',
    lat: MOVED_600KM_LAT,
    lon: MOVED_600KM_LON,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 601,
    createdAtTurn: 0,
  });
  expectReject(
    validateMove(
      defaults({
        head: { state: stateFile(), forces: forcesMap({ spain: [justRaised] }) },
      }),
    ),
    /raised this turn and cannot move until the next turn/,
  );
});

test('pass: newly raised force that stays put is fine', () => {
  // Same as above but the force never left its placement spot.
  const placed = force({
    id: 'spain-new-2',
    nation: 'spain',
    // Raised this turn, so its anchor is 0 and its whole strength charges
    // the raise budget: exactly one month's worth on the 30-day default
    // turn. This test is about the movement lock, not the cap.
    strength: 15000,
    turnStartStrength: 0,
    lat: 40.4,
    lon: -3.7,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 0,
    createdAtTurn: 0,
  });
  expectPass(
    validateMove(
      defaults({
        head: { state: stateFile(), forces: forcesMap({ spain: [placed] }) },
      }),
    ),
  );
});

test('pass: force raised in a previous turn can move normally', () => {
  // Force raised on turn 0; we are now on turn 1 (admin advanced).
  const movedNextTurn = force({
    id: 'spain-1',
    nation: 'spain',
    lat: MOVED_600KM_LAT,
    lon: MOVED_600KM_LON,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 601,
    createdAtTurn: 0,
  });
  expectPass(
    validateMove(
      defaults({
        base: { state: stateFile(), turn: turnFile({ turnNumber: 1 }), forces: forcesMap() },
        head: {
          state: stateFile(),
          turn: turnFile({ turnNumber: 1 }),
          forces: forcesMap({ spain: [movedNextTurn] }),
        },
      }),
    ),
  );
});

test('pass: legacy seed force without createdAtTurn is treated as primordial (movable)', () => {
  // Seed forces baked without createdAtTurn must not be locked — they
  // existed before the rule did. Verify the gate is opt-in.
  const seed = force({
    id: 'seed-0-0',
    nation: 'spain',
    lat: MOVED_600KM_LAT,
    lon: MOVED_600KM_LON,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 601,
    // createdAtTurn intentionally omitted
  });
  delete seed.createdAtTurn;
  expectPass(
    validateMove(
      defaults({
        // The seed force has to be in base under the same id: anchor
        // conservation pairs by id, and a 40000-man anchor on an id base
        // never saw is an injected anchor no matter how primordial the
        // force claims to be. This test is about the movement lock.
        base: { forces: forcesMap({ spain: [force({ id: 'seed-0-0', nation: 'spain' })] }) },
        head: { state: stateFile(), forces: forcesMap({ spain: [seed] }) },
      }),
    ),
  );
});

test('pass: tolerance absorbs sub-100m float drift on displacement check', () => {
  // Real displacement is ~600.45 km; reported 600.4 km (diff < 0.1 tolerance).
  const moved = force({
    id: 'spain-1',
    nation: 'spain',
    lat: MOVED_600KM_LAT,
    lon: MOVED_600KM_LON,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 600.4,
  });
  expectPass(
    validateMove(
      defaults({
        head: { state: stateFile(), forces: forcesMap({ spain: [moved] }) },
      }),
    ),
  );
});

// ────────────────────────────────────────────────────────────────────
// Force splitting (SPLIT_FORCE in the app)
//
// A split detachment is a NEW force id that inherits the parent's
// turn-tracking fields verbatim: same turnStart anchor, same
// kmMovedThisTurn, same createdAtTurn. These tests pin down that the
// validator accepts that shape — and that the inheritance is exactly
// what stops a split from minting free movement or dodging the
// newly-raised lock.
// ────────────────────────────────────────────────────────────────────

test('pass: mid-turn split — detachment inherits turn-tracking fields', () => {
  // Parent marched ~122 km (budget 750 for 30 days), then split 15k off.
  // No createdAtTurn — a primordial force, movable this turn (the default
  // turn fixture has turnNumber 0, so stamping 0 here would mean "raised
  // this turn" and lock it; the lock-inheritance case is the third test).
  const marched = {
    lat: 41.5,
    lon: -3.7,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 200,
  };
  const parent = force({ id: 'spain-1', nation: 'spain', strength: 25000, ...marched });
  const child = force({
    id: 'alice-1700000000000-0',
    nation: 'spain',
    name: '1st Corps (detachment)',
    strength: 15000,
    commander: '',
    ...marched,
  });
  expectPass(
    validateMove(
      defaults({
        head: { state: stateFile(), forces: forcesMap({ spain: [parent, child] }) },
      }),
    ),
  );
});

test('pass: detachment keeps marching after the split within remaining budget', () => {
  const parent = force({
    id: 'spain-1',
    nation: 'spain',
    strength: 25000,
    lat: 41.5,
    lon: -3.7,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 200,
  });
  // Child carried the parent's 200 km, then walked ~167 km more on its
  // own: displacement (turnStart → here) ≈ 289 km ≤ 367 km reported,
  // and 367 ≤ 750 budget.
  const child = force({
    id: 'alice-1700000000000-0',
    nation: 'spain',
    name: '1st Corps (detachment)',
    strength: 15000,
    lat: 43.0,
    lon: -3.7,
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 367,
  });
  expectPass(
    validateMove(
      defaults({
        head: { state: stateFile(), forces: forcesMap({ spain: [parent, child] }) },
      }),
    ),
  );
});

test('pass: split of an existing force nets zero recruitment cost', () => {
  // Scored on a 29-day turn, where the cap is exactly 0 — so this passes
  // only if the split really costs nothing, not merely "little". The
  // anchors partition: parent 40000/40000 detaches 15000, leaving
  // 25000/25000, and the child carries 15000/15000. Neither half shows
  // growth, and neither gained free headroom.
  const parent = force({ id: 'spain-1', nation: 'spain', strength: 25000, turnStartStrength: 25000 });
  const child = force({
    id: 'alice-1700000000000-0',
    nation: 'spain',
    name: '1st Corps (detachment)',
    strength: 15000,
    turnStartStrength: 15000,
  });
  expectPass(
    validateMove(
      defaults({
        base: { turn: turnFile({ lastTurnDays: 29 }) },
        head: { turn: turnFile({ lastTurnDays: 29 }), forces: forcesMap({ spain: [parent, child] }) },
      }),
    ),
  );
});

test('pass: split of a force raised THIS turn still costs its original strength once', () => {
  // 15000 men raised this turn fills a 30-day cap exactly. Splitting them
  // 10000/5000 must not re-bill either half: the parent's zero anchor
  // partitions into 0/0, so each half charges its own strength and the
  // sum is still 15000. If the parent kept its pre-split strength — or
  // the child were billed on top of an unreduced parent — the sum would
  // blow the cap.
  const parent = force({
    id: 'spain-new-1', nation: 'spain', strength: 10000, turnStartStrength: 0, createdAtTurn: 0,
  });
  const child = force({
    id: 'alice-1700000000000-0',
    nation: 'spain',
    name: 'Levy (detachment)',
    strength: 5000,
    turnStartStrength: 0,
    createdAtTurn: 0,
  });
  expectPass(
    validateMove(
      defaults({ head: { forces: forcesMap({ spain: [parent, child] }) } }),
    ),
  );
});

test('reject: detachment split off a just-raised force inherits the movement lock', () => {
  // Parent was raised this turn (createdAtTurn === turnNumber === 0) and
  // is locked. The child inherits that stamp — moving it is the dodge
  // this test pins down.
  const parent = force({
    id: 'spain-1', nation: 'spain', strength: 10000, turnStartStrength: 0, createdAtTurn: 0,
  });
  const child = force({
    id: 'alice-1700000000000-0',
    nation: 'spain',
    name: '1st Corps (detachment)',
    strength: 5000,
    turnStartStrength: 0,
    createdAtTurn: 0,
    lat: 41.9, // ~167 km north of the raise point
    turnStartLat: 40.4,
    turnStartLon: -3.7,
    kmMovedThisTurn: 170,
  });
  expectReject(
    validateMove(
      defaults({
        head: { state: stateFile(), forces: forcesMap({ spain: [parent, child] }) },
      }),
    ),
    /raised this turn/,
  );
});

// ────────────────────────────────────────────────────────────────────
// Per-nation recruitment cap (15000 men / 1 ship per whole month)
//
// The rule arithmetic is unit-tested in movement.test.mjs; these pin the
// wiring: the gate runs over the whole Record<nation, Force[]> (so it
// sums), it runs for admins too, and it fires on the fields the client
// actually writes. The default fixture force is 40000/40000 — unchanged
// since turn start, so it costs nothing and every raise below is
// attributable to the force the test adds. A raise is written as
// turnStartStrength: 0 (nothing at turn start, so all of it is new);
// createdAtTurn rides along because the client stamps it, but it is the
// movement lock now and buys the cap model nothing.
// ────────────────────────────────────────────────────────────────────

test('pass: raising exactly one month of men (15000 on the 30-day turn)', () => {
  const levy = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 15000, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectPass(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), levy] }) } })),
  );
});

test('reject: raising one man over the cap', () => {
  const levy = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 15001, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectReject(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), levy] }) } })),
    /spain exceeded its army recruitment cap: 15001 men .* cap is 15000 men for a 1-month turn/,
  );
});

test('pass: a 60-day turn buys two months of recruits (30000 men)', () => {
  const levy = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 30000, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectPass(
    validateMove(
      defaults({
        base: { turn: turnFile({ lastTurnDays: 60 }) },
        head: {
          turn: turnFile({ lastTurnDays: 60 }),
          forces: forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), levy] }),
        },
      }),
    ),
  );
});

test('reject: a 29-day turn is shorter than a month, so nothing can be raised', () => {
  const levy = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 1, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectReject(
    validateMove(
      defaults({
        base: { turn: turnFile({ lastTurnDays: 29 }) },
        head: {
          turn: turnFile({ lastTurnDays: 29 }),
          forces: forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), levy] }),
        },
      }),
    ),
    /spain cannot raise or reinforce its army this turn: 1 men requested but the turn is only 29 days/,
  );
});

test('pass: the navy pool is separate — a full army raise plus a ship both fit', () => {
  const levy = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 15000, turnStartStrength: 0, createdAtTurn: 0,
  });
  const ship = force({
    id: 'alice-1700000000000-1', nation: 'spain', branch: 'navy', name: 'San Juan',
    strength: 1, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectPass(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [levy, ship] }) } })),
  );
});

test('reject: two ships on a one-month turn (navy cap is 1)', () => {
  const fleet = force({
    id: 'alice-1700000000000-1', nation: 'spain', branch: 'navy', name: 'Squadron',
    strength: 2, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectReject(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [fleet] }) } })),
    /spain exceeded its navy recruitment cap: 2 ships .* cap is 1 ships/,
  );
});

test('reject: cumulative across submissions — a second raise sums with the first', () => {
  // The multi-PR dodge: 10000 landed in an earlier PR this turn, so it is
  // already sitting in spain.json when the 6000 arrives. The gate sums the
  // whole file every time, so the second submission is the one rejected.
  const first = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 10000, turnStartStrength: 0, createdAtTurn: 0,
  });
  const second = force({
    id: 'alice-1700000000001-0', nation: 'spain', name: 'Second Levy',
    strength: 6000, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectReject(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [first, second] }) } })),
    /spain exceeded its army recruitment cap: 16000 men/,
  );
});

test('reject: reinforcing an existing force over the cap', () => {
  // The hole this feature exists to close — a veteran force that quietly
  // grows 40000 → 60000 is a 20000-man raise, not a rename.
  const reinforced = force({
    id: 'spain-1', nation: 'spain', strength: 60000, turnStartStrength: 40000,
  });
  expectReject(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [reinforced] }) } })),
    /spain exceeded its army recruitment cap: 20000 men/,
  );
});

test('pass: reinforcing an existing force up to exactly the cap', () => {
  const reinforced = force({
    id: 'spain-1', nation: 'spain', strength: 55000, turnStartStrength: 40000,
  });
  expectPass(validateMove(defaults({ head: { forces: forcesMap({ spain: [reinforced] }) } })));
});

test('reject: admins are not exempt from the recruitment cap', () => {
  const levy = force({
    id: 'master-1700000000000-0', nation: 'france', name: 'Conscripts',
    strength: 40000, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectReject(
    validateMove(
      defaults({
        prAuthor: 'master',
        changedFiles: ['public/data/forces/france.json'],
        head: { forces: forcesMap({ france: [levy] }) },
      }),
    ),
    /france exceeded its army recruitment cap/,
  );
});

test('reject: force missing turnStartStrength (stale client bundle)', () => {
  // Without the anchor the cost model has nothing to subtract, so it is
  // mandatory server-side exactly like the turnStartLon/Lat anchors.
  const stale = force({ id: 'spain-1', nation: 'spain' });
  delete stale.turnStartStrength;
  expectReject(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [stale] }) } })),
    /missing turn-tracking fields \(.*turnStartStrength/,
  );
});

test('reject: negative strength (banking headroom by claiming a debt)', () => {
  const debt = force({ id: 'spain-1', nation: 'spain', strength: -50000, turnStartStrength: 40000 });
  expectReject(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [debt] }) } })),
    /missing turn-tracking fields/,
  );
});

test('reject: force missing turnStartBranch (stale client bundle)', () => {
  // The anchor is a bare number with no branch identity. Without
  // turnStartBranch every force reads as re-branded and bills its whole
  // strength — the entire standing order of battle charged to the cap —
  // so it is mandatory server-side exactly like the anchor itself.
  const stale = force({ id: 'spain-1', nation: 'spain' });
  delete stale.turnStartBranch;
  expectReject(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [stale] }) } })),
    /missing turn-tracking fields \(.*turnStartBranch\)/,
  );
});

test('reject: turnStartBranch that is not one of the two real branches', () => {
  // 'cavalry' buckets into the army pool by fallback, which silently
  // moves a navy anchor across pools. Only 'army' and 'navy' are taken.
  const bogus = force({ id: 'spain-1', nation: 'spain', turnStartBranch: 'cavalry' });
  expectReject(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [bogus] }) } })),
    /missing turn-tracking fields/,
  );
});

test('reject: turn.json missing turnNumber (both turn rules would fail open)', () => {
  // Read raw and left undefined, turnNumber fails open twice: nothing
  // ever equals it, so no force is "raised this turn" and every levy is
  // free to march; and it can never equal base's turnNumber, so anchor
  // conservation is skipped for every submission. Demand a real number.
  const turn = turnFile();
  delete turn.turnNumber;
  expectReject(
    validateMove(defaults({ head: { state: stateFile(), turn, forces: forcesMap() } })),
    /turn\.turnNumber is missing or invalid/,
  );
});

test('reject: an army re-branded into the navy lands its hulls in the navy pool', () => {
  // 40000 men "become" 40 ships. The bare subtraction scores
  // max(0, 40 - 40000) = 0 and hands spain 40 hulls against a cap of 1;
  // turnStartBranch says the anchor was earned in the army, so against
  // the navy this force is brand new and pays all 40.
  const rebranded = force({
    id: 'spain-1', nation: 'spain', branch: 'navy', name: 'Ex-1st Corps',
    strength: 40, turnStartStrength: 40000, turnStartBranch: 'army',
  });
  expectReject(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [rebranded] }) } })),
    /spain exceeded its navy recruitment cap: 40 ships raised or reinforced this turn, cap is 1 ships/,
  );
});

test('pass: an honest re-brand inside the cap is billed, not blocked', () => {
  // One ship's crew becomes a 15000-man corps: billed in full against the
  // army pool (exactly one month) and the navy anchor it left behind
  // stays in the navy bucket, so conservation sees no movement at all.
  const wasAShip = force({
    id: 'spain-1', nation: 'spain', branch: 'navy', name: 'San Juan',
    strength: 1, turnStartStrength: 1,
  });
  const nowACorps = force({
    id: 'spain-1', nation: 'spain', branch: 'army', name: 'San Juan Marines',
    strength: 15000, turnStartStrength: 1, turnStartBranch: 'navy',
  });
  expectPass(
    validateMove(
      defaults({
        base: { forces: forcesMap({ spain: [wasAShip] }) },
        head: { forces: forcesMap({ spain: [nowACorps] }) },
      }),
    ),
  );
});

// ────────────────────────────────────────────────────────────────────
// Population-derived recruitment (turn.json → populationByNation)
//
// The arithmetic is unit-tested in movement.test.mjs; these pin the
// WIRING — that the validator reads the table off head.turn, that absence
// of the table is not an error, and that the standing-army ceiling binds
// admins too.
//
// The default fixtures are unusually convenient here and the tests lean
// on it: stateFile() hands spain fids 0 and 2, and force() is 40,000 men
// anchored at 40,000 (so it spends nothing). A table putting spain at
// exactly 1,000,000 people therefore sets its ceiling to exactly 40,000 —
// the nation sits precisely ON its ceiling, and every case below is one
// man either side of that line.
//
// Two traps worth naming, because the next person to write a fixture here
// will hit both:
//   1. The table must go on BOTH base.turn and head.turn. turn.json is
//      admin-only, and a player submission whose base and head turn files
//      differ by so much as one key trips "turn.json cannot be changed by
//      players" at the very bottom of the validator, long before anything
//      about recruitment is scored. In production they are identical for
//      the same reason: the table is rewritten only on a turn advance,
//      which is itself an admin PR.
//   2. Nations are walked SORTED, so france is scored before spain — and
//      a nation missing from a table that exists resolves to 0 people,
//      i.e. a 3,000-man ceiling. The default france-1 is 40,000 men, so
//      any fixture where france SPENDS must give france a population or
//      it reports france's ceiling instead of whatever the test is about.
//      That is not a bug; it is fail-closed-on-contents, and the last
//      test in this section pins it deliberately.
// ────────────────────────────────────────────────────────────────────

/** defaults() with the same population table on both sides of turn.json.
 *  See trap 1 above — supplying it to head alone rewrites the meaning of
 *  every player-authored test into a file-scope rejection. */
function withPopulation(populationByNation, overrides = {}) {
  const { base = {}, head = {}, ...rest } = overrides;
  return defaults({
    base: { turn: turnFile({ populationByNation }), ...base },
    head: { turn: turnFile({ populationByNation }), ...head },
    ...rest,
  });
}

// spain at exactly 1,000,000 people: ceiling exactly 40,000, which is
// exactly what the default spain-1 already stands at.
const POP_AT_CEILING = { spain: 1_000_000, france: 1_000_000 };
// One person fewer: ceiling 39,999, and spain is over by a single man
// without having done anything at all.
const POP_ONE_SHORT = { spain: 999_999, france: 1_000_000 };

test('pass: a nation standing exactly on its ceiling, spending nothing', () => {
  // 40,000 men against a 40,000 ceiling. Nothing is raised, so the ceiling
  // test is never even reached — but this is the baseline the next three
  // tests move one man either side of.
  expectPass(validateMove(withPopulation(POP_AT_CEILING)));
});

test('pass: recruiting the last man the population supports lands exactly on the ceiling', () => {
  // 39,999 → 40,000 is a one-man raise that ends level with the ceiling.
  // The comparison is a strict `>`, so level is legal; `>=` would make the
  // ceiling unreachable and quietly cost every nation its last man.
  const topped = force({
    id: 'spain-1', nation: 'spain', strength: 40000, turnStartStrength: 39999,
  });
  expectPass(
    validateMove(withPopulation(POP_AT_CEILING, { head: { forces: forcesMap({ spain: [topped] }) } })),
  );
});

test('reject: one man past the ceiling, even though the monthly cap had room', () => {
  // The raise is 1 man against a monthly cap of 3,873 — comfortably
  // inside the flow rule, and rejected anyway on the stock rule. That
  // asymmetry is the operative UX fact: over the ceiling means no men at
  // all, not "recruit up to the ceiling", because trimming the raise
  // cannot fix a stock violation.
  const levy = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 1, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectReject(
    validateMove(
      withPopulation(POP_AT_CEILING, {
        head: { forces: forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), levy] }) },
      }),
    ),
    /^spain exceeded its standing army ceiling: 40001 men under arms, but a population of 1000000 supports at most 40000 — an army may never exceed 4% of the nation it is raised from$/,
  );
});

test('pass: NO BRICK — a nation already over its ceiling can still move, split and disband', () => {
  // The case the whole design bends around, at the wiring level. spain's
  // population slipped to 999,999 so its ceiling is 39,999 and its
  // untouched 40,000-man army is over it, having done nothing. If the
  // gate rejected on the stock alone, an ownership edit spain did not
  // make would delete spain from the game — no moves, no reorganisation,
  // no way to shrink back into compliance, and no turn advance either.
  // Each shape below spends 0 army budget, so none of them reach the
  // ceiling test at all.
  const marched = force({
    id: 'spain-1', nation: 'spain',
    lat: MOVED_600KM_LAT, lon: MOVED_600KM_LON,
    turnStartLat: 40.4, turnStartLon: -3.7, kmMovedThisTurn: 601,
  });
  expectPass(
    validateMove(withPopulation(POP_ONE_SHORT, { head: { forces: forcesMap({ spain: [marched] }) } })),
  );
  // Split: the anchor partitions, so neither half shows growth — and the
  // nation is no closer to compliance, which is fine. It is not blocked.
  const parent = force({ id: 'spain-1', nation: 'spain', strength: 25000, turnStartStrength: 25000 });
  const child = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: '1st Corps (detachment)',
    strength: 15000, turnStartStrength: 15000,
  });
  expectPass(
    validateMove(withPopulation(POP_ONE_SHORT, { head: { forces: forcesMap({ spain: [parent, child] }) } })),
  );
  // Disband: the way back under the ceiling has to stay open, or being
  // over it is permanent.
  expectPass(
    validateMove(withPopulation(POP_ONE_SHORT, { head: { forces: forcesMap({ spain: [] }) } })),
  );
});

test('reject: over the ceiling, raising one man is the thing that is actually refused', () => {
  // The other half of the no-brick case. spain may do everything except
  // grow, and the message reports the stock it broke rather than the flow
  // it happened to spend.
  const levy = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 1, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectReject(
    validateMove(
      withPopulation(POP_ONE_SHORT, {
        head: { forces: forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), levy] }) },
      }),
    ),
    /^spain exceeded its standing army ceiling: 40001 men under arms, but a population of 999999 supports at most 39999 —/,
  );
});

test('pass: the navy pool ignores the army ceiling entirely', () => {
  // spain is over its standing ceiling, and lays down a ship anyway. The
  // army's spend is 0 so the army iteration `continue`s before the ceiling
  // test; the navy has no ceiling of its own because hulls are limited by
  // yards and timber rather than by people.
  const ship = force({
    id: 'alice-1700000000000-1', nation: 'spain', branch: 'navy', name: 'San Juan',
    strength: 1, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectPass(
    validateMove(
      withPopulation(POP_ONE_SHORT, {
        head: { forces: forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), ship] }) },
      }),
    ),
  );
});

test('reject: the population-derived cap really replaces the flat 15000', () => {
  // sweden's real population on spain, to use a figure the shipped table
  // actually contains: 3,229,802 people buy 6,960 men a month, not 15,000.
  // A 7,000-man levy was legal yesterday and is not today — and the stock
  // is nowhere near the 129,192 ceiling, so this is the FLOW rule firing
  // in its own unchanged sentence with a new number in it.
  const levy = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 7000, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectReject(
    validateMove(
      withPopulation({ spain: 3229802, france: 3229802 }, {
        head: { forces: forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), levy] }) },
      }),
    ),
    /^spain exceeded its army recruitment cap: 7000 men raised or reinforced this turn, cap is 6960 men for a 1-month turn$/,
  );
});

test('pass: raising exactly the population-derived cap', () => {
  const levy = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 6960, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectPass(
    validateMove(
      withPopulation({ spain: 3229802, france: 3229802 }, {
        head: { forces: forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), levy] }) },
      }),
    ),
  );
});

test('pass: a turn.json with no populationByNation behaves exactly as it did before', () => {
  // FAIL OPEN ON ABSENCE, and this is the case that matters in
  // production: every turn.json written before this feature has no such
  // field, and rejecting on that would brick every submission in the game
  // until the next turn advance rewrote the file. The A/B is the whole
  // test — one identical fixture, scored twice, differing only in whether
  // the table exists.
  const levy = () => force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 15000, turnStartStrength: 0, createdAtTurn: 0,
  });
  const forces = () => forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), levy()] });
  // No table: the flat 15000 is intact, and the 55,000 men spain ends up
  // standing — which would break any plausible ceiling — go unremarked,
  // because an absent table means the rule is unenforced, not that spain
  // has no people.
  expectPass(validateMove(defaults({ head: { forces: forces() } })));
  // The same submission with a table present is scored on it.
  expectReject(
    validateMove(withPopulation({ spain: 3229802, france: 3229802 }, { head: { forces: forces() } })),
    /^spain exceeded its army recruitment cap: 15000 men raised or reinforced this turn, cap is 6960 men/,
  );
});

test('pass: a populationByNation that is not a table at all is absence, not zeroes', () => {
  // Worker parity, and the reason this guard exists on both sides. turn.json
  // is parsed unvalidated on both servers, so a hand-edited file can put
  // anything in this field, and the two gates have to answer identically or
  // the worker opens a PR that CI then refuses.
  //
  // `null` is the sharp one: it used to reach checkRaiseBudgets, where
  // `null[nation]` throws a TypeError — and validate-move.mjs calls
  // validateMove() with no try/catch, so the CI step died with a stack
  // trace instead of returning a verdict, while the worker's own shape
  // guard sailed past it.
  //
  // A string or an array is the quiet one: both index to undefined for
  // EVERY nation, which the `?? 0` inside checkRaiseBudgets turns into "0
  // people" — so a single malformed field would have declared all 78
  // nations over a 3,000-man ceiling at once. Neither is evidence about
  // anyone's population, so both land where the worker lands: unenforced.
  const levy = () => force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 15000, turnStartStrength: 0, createdAtTurn: 0,
  });
  const forces = () => forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), levy()] });
  for (const notATable of [null, 'sweden', 42, [['spain', 1000000]], true]) {
    expectPass(validateMove(withPopulation(notATable, { head: { forces: forces() } })));
  }
});

test('reject: admins are not exempt from the standing army ceiling', () => {
  // Same shape as the existing recruitment-cap exemption test. The admin
  // bypass is a FILE-SCOPE bypass; every universal invariant, this one
  // included, still runs. An admin who wants a bigger army has to move the
  // population, which is a state.json edit anyone can audit.
  const levy = force({
    id: 'master-1700000000000-0', nation: 'france', name: 'Conscripts',
    strength: 1, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectReject(
    validateMove(
      withPopulation(POP_AT_CEILING, {
        prAuthor: 'master',
        changedFiles: ['public/data/forces/france.json'],
        head: { forces: forcesMap({ france: [force({ id: 'france-1', nation: 'france' }), levy] }) },
      }),
    ),
    /^france exceeded its standing army ceiling: 40001 men under arms, but a population of 1000000 supports at most 40000 —/,
  );
});

test('reject: the table is read from HEAD, so an admin is scored on the table they are writing', () => {
  // head is refs/pull/N/merge — this PR already merged into main — so it
  // is the frame that will actually land, and a submission has to be
  // judged by the rules that will be in force once it does. Main still
  // says 3,229,802 (cap 6,960, which would have allowed this 5,000-man
  // levy); the submission rewrites the table to 1,500,000 (cap 4,743,
  // ceiling 60,000, which the 45,000 standing clears) and is refused on
  // its own new number. Same reasoning the file already applies to
  // lastTurnDays and turnNumber, and it costs no extra file read — the
  // CLI already parses turn.json whole.
  const levy = force({
    id: 'master-1700000000000-0', nation: 'spain', name: 'Levy',
    strength: 5000, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectReject(
    validateMove(
      defaults({
        base: { turn: turnFile({ populationByNation: { spain: 3229802, france: 3229802 } }) },
        head: {
          turn: turnFile({ populationByNation: { spain: 1_500_000, france: 1_500_000 } }),
          forces: forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), levy] }),
        },
        prAuthor: 'master',
        changedFiles: ['public/data/turn.json', 'public/data/forces/spain.json'],
      }),
    ),
    /^spain exceeded its army recruitment cap: 5000 men raised or reinforced this turn, cap is 4743 men for a 1-month turn$/,
  );
});

test('reject: a nation missing from a table that exists is 0 people, not unknown', () => {
  // FAIL CLOSED ON CONTENTS, and trap 2 from the section header made into
  // an assertion. The table is real but forgot france, so france resolves
  // to 0 — a 3,000-man ceiling under a 43,001-man army. This is the
  // behaviour that catches a nation silently dropped from the bake, and
  // it is also exactly what bites a fixture that gives spain a population
  // and lets france spend. Note the sorted walk: france is reported even
  // though spain is the nation the table names.
  const levy = force({
    id: 'master-1700000000000-0', nation: 'france', name: 'Conscripts',
    strength: 3001, turnStartStrength: 0, createdAtTurn: 0,
  });
  expectReject(
    validateMove(
      withPopulation({ spain: 3229802 }, {
        prAuthor: 'master',
        changedFiles: ['public/data/forces/france.json'],
        head: { forces: forcesMap({ france: [force({ id: 'france-1', nation: 'france' }), levy] }) },
      }),
    ),
    /^france exceeded its standing army ceiling: 43001 men under arms, but a population of 0 supports at most 3000 —/,
  );
});

// ────────────────────────────────────────────────────────────────────
// Anchor conservation — the gate that makes the client-asserted anchor
// safe. base.forces is main right now, head.forces the merged result, and
// every head force is paired to its base self BY ID: a nation's
// per-branch anchor total may not exceed what exactly those same forces
// were anchored at in base. Without this, every cap test above is
// advisory — the client picks the number the cap subtracts from.
//
// The scope is asymmetric and the tests below lean on both halves: HEAD
// narrows to the nation files this PR changed, BASE is indexed whole so a
// force that changed nation files (a rename, above) still finds itself.
// ────────────────────────────────────────────────────────────────────

test('reject: a new force claiming it already existed at turn start (free recruits)', () => {
  // The dodge the cap alone cannot see. strength == anchor, so raiseCost
  // is 0 and 15000 men land free; no createdAtTurn either, so nothing
  // marks it as new — except its id, which base never saw, so the anchor
  // it claims is funded by nothing at all.
  const ghost = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Phantom Levy',
    strength: 15000, turnStartStrength: 15000,
  });
  expectReject(
    validateMove(
      defaults({
        head: { forces: forcesMap({ spain: [force({ id: 'spain-1', nation: 'spain' }), ghost] }) },
      }),
    ),
    /^spain inflated its army turn-start strength: its anchors total 55000 men in this submission but the same forces were anchored at 40000 men at the start of the turn — anchors may be split or dropped within a turn, never invented or raised$/,
  );
});

test('reject: inflating an existing force\'s anchor to hide 20000 men of growth', () => {
  // Same 40000 → 60000 reinforcement the cap catches above, but with the
  // anchor dragged up alongside it so raiseCost sees no growth at all.
  const cooked = force({
    id: 'spain-1', nation: 'spain', strength: 60000, turnStartStrength: 60000,
  });
  expectReject(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [cooked] }) } })),
    /^spain inflated its army turn-start strength: its anchors total 60000 men/,
  );
});

test('pass: the same restamp passes when the submission advances the turn', () => {
  // Byte-identical fixture to the test above; the only difference is that
  // turnNumber moves. On a turn advance ADVANCE_TURN restamps every
  // anchor to current strength, which is an inflation by construction, so
  // the gate is skipped for that submission. turn.json is admin-only, so
  // a player can never reach this branch.
  const restamped = force({
    id: 'spain-1', nation: 'spain', strength: 60000, turnStartStrength: 60000,
  });
  expectPass(
    validateMove(
      defaults({
        head: {
          turn: turnFile({ turnNumber: 1 }),
          forces: forcesMap({ spain: [restamped] }),
        },
        prAuthor: 'master',
        changedFiles: ['public/data/turn.json', 'public/data/forces/spain.json'],
      }),
    ),
  );
});

// A colluding transfer — spain gifting france a 40000-man corps, anchor
// and all — is the one move id-pairing cannot reject on its own, because
// it is byte-identical to the rename above: an id that base holds, filed
// under a different nation. It is closed by interaction with the checks
// around it, and which one fires depends purely on whether the donor's
// removal has merged yet. Both orderings get their own test, because
// closing one and leaving the other open is not closing anything. (A
// player cannot do it in a single PR: their file scope is one file, so
// emptying spain.json and filling france.json cannot be the same PR.)

test('reject: colluding transfer while the donor still holds the id (duplicate-id check)', () => {
  // Ordering one — bob submits before spain's removal PR merges, so
  // spain-1 is in two nation files at once. The uniqueness check fires
  // long before conservation, which would have funded the anchor from
  // spain's still-present copy.
  const head = {
    forces: {
      spain: [force({ id: 'spain-1', nation: 'spain' })],
      france: [
        force({ id: 'france-1', nation: 'france', name: 'Grande Armée', commander: 'Bonaparte' }),
        force({ id: 'spain-1', nation: 'france', name: 'Defected Corps' }),
      ],
    },
  };
  expectReject(
    validateMove(
      defaults({
        head,
        prAuthor: 'bob',
        changedFiles: ['public/data/forces/france.json'],
      }),
    ),
    /^duplicate force id spain-1 across nation files$/,
  );
});

test('reject: colluding transfer after the donor\'s removal has merged (conservation)', () => {
  // Ordering two — spain's PR emptying spain.json landed first, so base no
  // longer holds spain-1 anywhere and the id funds nothing. France is the
  // nation named because only head nations are walked, and the walk is
  // sorted.
  const head = {
    forces: {
      spain: [],
      france: [
        force({ id: 'france-1', nation: 'france', name: 'Grande Armée', commander: 'Bonaparte' }),
        force({ id: 'spain-1', nation: 'france', name: 'Defected Corps' }),
      ],
    },
  };
  expectReject(
    validateMove(
      defaults({
        base: { forces: forcesMap({ spain: [] }) },
        head,
        prAuthor: 'bob',
        changedFiles: ['public/data/forces/france.json'],
      }),
    ),
    /^france inflated its army turn-start strength: its anchors total 80000 men in this submission but the same forces were anchored at 40000 men/,
  );
});

test('pass: a stale copy of another nation\'s file is not read as inflation', () => {
  // base is main RIGHT NOW (the workflow checks out base.ref); head is
  // refs/pull/N/merge, which GitHub recomputes asynchronously and so can
  // sit one merge behind. France disbanded a force in between, so base no
  // longer holds france-1 while the stale merge result still does — an
  // allowance of 0 against an anchor alice never touched. Nothing in this
  // PR changes france.json, so narrowing HEAD to changedFiles is what
  // keeps alice from being rejected in bob's name.
  const stale = forcesMap({ france: [force({ id: 'france-1', nation: 'france' })] });
  const emptied = forcesMap({ france: [] });
  expectPass(
    validateMove(
      defaults({
        base: { forces: emptied },
        head: { forces: stale },
        changedFiles: ['public/data/forces/spain.json'],
      }),
    ),
  );
});

test('reject: scoping to changed files still catches inflation in a changed file', () => {
  // The other side of the same narrowing: spain.json IS in the list, so
  // the ghost levy is scored exactly as before. Staleness elsewhere must
  // not become a way to smuggle anchors through the file you did change.
  const ghost = force({
    id: 'alice-1700000000000-0', nation: 'spain', name: 'Phantom Levy',
    strength: 15000, turnStartStrength: 15000,
  });
  expectReject(
    validateMove(
      defaults({
        base: { forces: forcesMap({ france: [] }) },
        head: {
          forces: forcesMap({
            spain: [force({ id: 'spain-1', nation: 'spain' }), ghost],
            france: [force({ id: 'france-1', nation: 'france' })],
          }),
        },
        changedFiles: ['public/data/forces/spain.json'],
      }),
    ),
    /^spain inflated its army turn-start strength/,
  );
});

test('reject: branch that is not one of the two real branches (worker parity)', () => {
  // The worker rejects this on submit; this file used to wave it through,
  // and anything it waves through lands on main, is read back into every
  // client's snapshot, and bounces EVERY player's next submission off the
  // worker's guard. One hand-crafted PR, game-wide denial of service.
  const bogus = force({
    id: 'spain-1', nation: 'spain', branch: 'cavalry', turnStartBranch: 'army',
    strength: 100, turnStartStrength: 40000,
  });
  expectReject(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [bogus] }) } })),
    /missing turn-tracking fields/,
  );
});

test('reject: non-numeric lat slips the displacement check (worker parity)', () => {
  // haversineKm(null, ...) is NaN and `NaN > budget` is false, so a force
  // with no real position passed every movement test below. The worker
  // demands numbers; so does this now.
  const nowhere = force({ id: 'spain-1', nation: 'spain', lat: null });
  expectReject(
    validateMove(defaults({ head: { forces: forcesMap({ spain: [nowhere] }) } })),
    /missing turn-tracking fields/,
  );
});

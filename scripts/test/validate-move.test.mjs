// Adversarial tests for the move validator. Every test is a single
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
  return {
    id: 1,
    nation: 'spain',
    branch: 'army',
    name: '1st Corps',
    strength: 40000,
    commander: 'Castaños',
    lon: -3.7,
    lat: 40.4,
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    ownerships: [
      [0, 'spain'],
      [1, 'france'],
      [2, 'spain'],
    ],
    forces: [
      force({ id: 1, nation: 'spain' }),
      force({ id: 2, nation: 'france', name: 'Grande Armée', commander: 'Bonaparte' }),
    ],
    nextForceId: 3,
    countries: [
      { name: 'spain', color: '#1F4E9C' },
      { name: 'france', color: '#D7837F' },
    ],
    ...overrides,
  };
}

const PERMS = {
  master: { role: 'admin' },
  alice: { role: 'player', nation: 'spain' },
  bob: { role: 'player', nation: 'france' },
  // Mixed-case nation in perm.json — must still match against lowercase state.
  carol: { role: 'player', nation: 'Spain' },
  // A registered user with no nation — borked entry.
  dangling: { role: 'player' },
};

function defaults(overrides = {}) {
  const base = state();
  return {
    baseState: base,
    headState: state(),
    perms: PERMS,
    prAuthor: 'alice',
    changedFiles: ['public/data/state.json'],
    mergeable: true,
    ...overrides,
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
// Authorization: no-permission users must get nothing
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
// File scope: players are quarantined to state.json
// ────────────────────────────────────────────────────────────────────

test('reject: player tries to edit perm.json (privilege escalation)', () => {
  expectReject(
    validateMove(
      defaults({
        changedFiles: ['public/data/state.json', 'public/data/perm.json'],
      }),
    ),
    /modifies files outside public\/data\/state\.json/,
  );
});

test('reject: player tries to edit a workflow file', () => {
  expectReject(
    validateMove(
      defaults({
        changedFiles: ['public/data/state.json', '.github/workflows/validate-and-merge.yml'],
      }),
    ),
    /modifies files outside/,
  );
});

test('reject: player tries to add a brand-new file', () => {
  expectReject(
    validateMove(
      defaults({
        changedFiles: ['public/data/state.json', 'src/payload.ts'],
      }),
    ),
    /modifies files outside/,
  );
});

test('reject: player tries to edit only perm.json (no state.json change)', () => {
  expectReject(
    validateMove(
      defaults({
        changedFiles: ['public/data/perm.json'],
      }),
    ),
    /modifies files outside/,
  );
});

// ────────────────────────────────────────────────────────────────────
// Border integrity: only admins can change ownership / countries
// ────────────────────────────────────────────────────────────────────

test('reject: player tries to steal a province (change ownership)', () => {
  const head = state({
    ownerships: [
      [0, 'spain'],
      [1, 'spain'], // was france — alice annexes France's province
      [2, 'spain'],
    ],
  });
  expectReject(validateMove(defaults({ headState: head })), /ownership cannot be changed/);
});

test('reject: player adds a new country', () => {
  const head = state({
    countries: [
      { name: 'spain', color: '#1F4E9C' },
      { name: 'france', color: '#D7837F' },
      { name: 'wakanda', color: '#000000' },
    ],
  });
  expectReject(validateMove(defaults({ headState: head })), /country list/);
});

test('reject: player renames an existing country', () => {
  const head = state({
    countries: [
      { name: 'spain-empire', color: '#1F4E9C' },
      { name: 'france', color: '#D7837F' },
    ],
  });
  expectReject(validateMove(defaults({ headState: head })), /country list/);
});

test('reject: player recolors an existing country', () => {
  const head = state({
    countries: [
      { name: 'spain', color: '#FF00FF' }, // changed
      { name: 'france', color: '#D7837F' },
    ],
  });
  expectReject(validateMove(defaults({ headState: head })), /country list/);
});

// ────────────────────────────────────────────────────────────────────
// Force integrity: players can only touch their own
// ────────────────────────────────────────────────────────────────────

test('reject: player removes another nation\'s force', () => {
  const head = state({
    forces: [force({ id: 1, nation: 'spain' })], // dropped force #2 (france)
  });
  expectReject(validateMove(defaults({ headState: head })), /force #2.*not owned by spain/);
});

test('reject: player moves another nation\'s force', () => {
  const head = state({
    forces: [
      force({ id: 1, nation: 'spain' }),
      force({ id: 2, nation: 'france', name: 'Grande Armée', commander: 'Bonaparte', lat: 0, lon: 0 }),
    ],
  });
  expectReject(validateMove(defaults({ headState: head })), /force #2 edited but nation must be spain/);
});

test('reject: player renames another nation\'s force', () => {
  const head = state({
    forces: [
      force({ id: 1, nation: 'spain' }),
      force({ id: 2, nation: 'france', name: 'Comically Renamed', commander: 'Bonaparte' }),
    ],
  });
  expectReject(validateMove(defaults({ headState: head })), /force #2 edited/);
});

test('reject: player changes another nation\'s force strength', () => {
  const head = state({
    forces: [
      force({ id: 1, nation: 'spain' }),
      force({ id: 2, nation: 'france', name: 'Grande Armée', commander: 'Bonaparte', strength: 1 }),
    ],
  });
  expectReject(validateMove(defaults({ headState: head })), /force #2 edited/);
});

test('reject: player adds a force claiming another nation', () => {
  const head = state({
    forces: [
      force({ id: 1, nation: 'spain' }),
      force({ id: 2, nation: 'france', name: 'Grande Armée', commander: 'Bonaparte' }),
      force({ id: 3, nation: 'france', name: 'Phantom Army', strength: 999999 }),
    ],
    nextForceId: 4,
  });
  expectReject(validateMove(defaults({ headState: head })), /force #3.*not owned by spain/);
});

test('reject: player tries to convert enemy force to their nation (nation swap)', () => {
  const head = state({
    forces: [
      force({ id: 1, nation: 'spain' }),
      // bob (france) tries to take over force #2 by relabeling it spanish
      force({ id: 2, nation: 'spain', name: 'Grande Armée', commander: 'Bonaparte' }),
    ],
  });
  expectReject(
    validateMove(defaults({ headState: head, prAuthor: 'bob' })),
    /force #2 edited but nation must be france/,
  );
});

test('reject: duplicate force id (last-wins JSON parse trick)', () => {
  // Two entries with id=2: one keeps the original (france), the other
  // claims it for spain. JSON.parse keeps the last; new Map() dedupes.
  // The duplicate-id guard catches it before per-force checks run.
  const head = state({
    forces: [
      force({ id: 1, nation: 'spain' }),
      force({ id: 2, nation: 'france', name: 'Grande Armée', commander: 'Bonaparte' }),
      force({ id: 2, nation: 'spain', name: 'Decoy' }),
    ],
  });
  expectReject(validateMove(defaults({ headState: head })), /duplicate force id/);
});

test('reject: nextForceId not strictly greater than max id (collision risk)', () => {
  const head = state({
    forces: [
      force({ id: 1, nation: 'spain' }),
      force({ id: 2, nation: 'france', name: 'Grande Armée', commander: 'Bonaparte' }),
      force({ id: 5, nation: 'spain', name: 'Reserve' }),
    ],
    nextForceId: 5, // should be > 5
  });
  expectReject(validateMove(defaults({ headState: head })), /nextForceId/);
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
// Legitimate paths must pass — no false positives
// ────────────────────────────────────────────────────────────────────

test('pass: player legitimately moves their own force', () => {
  const head = state({
    forces: [
      force({ id: 1, nation: 'spain', lat: 41, lon: -4 }),
      force({ id: 2, nation: 'france', name: 'Grande Armée', commander: 'Bonaparte' }),
    ],
  });
  expectPass(validateMove(defaults({ headState: head })));
});

test('pass: player adds a new force of their own nation', () => {
  const head = state({
    forces: [
      force({ id: 1, nation: 'spain' }),
      force({ id: 2, nation: 'france', name: 'Grande Armée', commander: 'Bonaparte' }),
      force({ id: 3, nation: 'spain', name: '2nd Corps' }),
    ],
    nextForceId: 4,
  });
  expectPass(validateMove(defaults({ headState: head })));
});

test('pass: player removes one of their own forces', () => {
  const head = state({
    forces: [force({ id: 2, nation: 'france', name: 'Grande Armée', commander: 'Bonaparte' })],
  });
  expectPass(validateMove(defaults({ headState: head })));
});

test('pass: case-insensitive nation match (perm.json has TitleCase)', () => {
  // Carol is registered as "Spain" — state is "spain". Should still match.
  const head = state({
    forces: [
      force({ id: 1, nation: 'spain', lat: 42 }),
      force({ id: 2, nation: 'france', name: 'Grande Armée', commander: 'Bonaparte' }),
    ],
  });
  expectPass(validateMove(defaults({ headState: head, prAuthor: 'carol' })));
});

test('pass: empty PR (no diff) is technically valid — diff check is upstream', () => {
  // The submit modal short-circuits empty PRs, but if one slips through
  // the validator should still pass (no malicious change).
  expectPass(validateMove(defaults()));
});

// ────────────────────────────────────────────────────────────────────
// Admin bypass — master can do anything
// ────────────────────────────────────────────────────────────────────

test('pass: admin moves an enemy force', () => {
  const head = state({
    forces: [
      force({ id: 1, nation: 'spain' }),
      force({ id: 2, nation: 'france', name: 'Grande Armée', commander: 'Bonaparte', lat: 0, lon: 0 }),
    ],
  });
  expectPass(validateMove(defaults({ headState: head, prAuthor: 'master' })));
});

test('pass: admin changes ownership', () => {
  const head = state({
    ownerships: [
      [0, 'france'], // re-assign Spanish provinces
      [1, 'france'],
      [2, 'france'],
    ],
  });
  expectPass(validateMove(defaults({ headState: head, prAuthor: 'master' })));
});

test('pass: admin renames / recolors / adds countries', () => {
  const head = state({
    countries: [
      { name: 'spain-empire', color: '#FF0000' },
      { name: 'france', color: '#D7837F' },
      { name: 'wakanda', color: '#000000' },
    ],
  });
  expectPass(validateMove(defaults({ headState: head, prAuthor: 'master' })));
});

test('pass: admin edits perm.json alongside state.json', () => {
  expectPass(
    validateMove(
      defaults({
        prAuthor: 'master',
        changedFiles: ['public/data/state.json', 'public/data/perm.json'],
      }),
    ),
  );
});

test('pass: admin perm-only PR (no state.json edits)', () => {
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
// Admin still subject to the mergeability gate
// ────────────────────────────────────────────────────────────────────

test('reject: admin PR with merge conflict still blocked', () => {
  expectReject(
    validateMove(defaults({ prAuthor: 'master', mergeable: false })),
    /merge conflict/,
  );
});

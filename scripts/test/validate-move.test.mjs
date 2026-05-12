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
  return {
    id: 'seed-0-0',
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

function stateFile(overrides = {}) {
  return {
    appVersion: 'theatrum/v7',
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
  return {
    base: { state: stateFile(), forces: forcesMap() },
    head: { state: stateFile(), forces: forcesMap() },
    perms: PERMS,
    prAuthor: 'alice',
    changedFiles: ['public/data/forces/spain.json'],
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
  const head = {
    state: stateFile(),
    forces: {
      ...forcesMap(),
      spain: [
        force({ id: 'spain-1', nation: 'spain' }),
        force({ id: 'alice-123-0', nation: 'spain', name: '2nd Corps' }),
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
  // login, so no collision.
  const head = {
    state: stateFile(),
    forces: {
      ...forcesMap(),
      spain: [
        force({ id: 'spain-1', nation: 'spain' }),
        force({ id: 'alice-1715551200000-0', nation: 'spain', name: 'Reserve' }),
        force({ id: 'carol-1715551200001-0', nation: 'spain', name: 'Aragón' }),
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

test('pass: admin renames a country (state.json + force file moved)', () => {
  const head = {
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
  expectPass(
    validateMove(
      defaults({
        head,
        prAuthor: 'master',
        changedFiles: [
          'public/data/state.json',
          'public/data/forces/spain.json',
          'public/data/forces/spain-empire.json',
        ],
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

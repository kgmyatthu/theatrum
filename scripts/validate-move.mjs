// Validator for player-submitted move PRs. Runs inside the
// validate-and-merge workflow. Outputs `valid=true|false` and a `reason`
// to $GITHUB_OUTPUT; the workflow comments + merges accordingly.
//
// I/O is handled here; the decision logic lives in lib/validate-move-core.mjs
// so it's independently testable without gh CLI / fs fixtures.
//
// Inputs (env): PR_AUTHOR, PR_NUMBER, GITHUB_REPOSITORY, GITHUB_OUTPUT, GH_TOKEN
// Reads:
//   ./base/public/data/perm.json           (TRUSTED — main's perm.json)
//   ./base/public/data/state.json          (TRUSTED — main's state.json)
//   ./base/public/data/forces/<nation>.json  (TRUSTED — main's forces, per nation)
//   ./head/public/data/state.json          (proposed)
//   ./head/public/data/forces/<nation>.json  (proposed, per nation)
//   gh api repos/.../pulls/<n>             (mergeability)
//   gh api repos/.../pulls/<n>/files       (changed file list)

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { validateMove, FORCES_SUFFIX } from './lib/validate-move-core.mjs';

const PR_AUTHOR = process.env.PR_AUTHOR;
const PR_NUMBER = process.env.PR_NUMBER;
const REPO = process.env.GITHUB_REPOSITORY;
const BASE = './base';
const HEAD = './head';

function gh(p) {
  return execSync(`gh api ${p} --paginate`, { encoding: 'utf-8' });
}

function output(key, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read a state-and-forces tree from a checkout root (base/ or head/).
 * Returns { state, forces } where forces is { <nation>: Force[] }.
 *
 * Missing state.json or missing forces/ directory is fine for the head
 * (e.g. admin perm-only PRs don't touch them) — fall back to {} and let
 * the validator's structural checks compare apples-to-apples.
 */
function readStateAndForces(root) {
  const statePath = `${root}/public/data/state.json`;
  const state = fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf-8'))
    : {};
  const forces = {};
  const forcesDir = `${root}/public/data/forces`;
  if (fs.existsSync(forcesDir)) {
    for (const filename of fs.readdirSync(forcesDir)) {
      if (!filename.endsWith(FORCES_SUFFIX)) continue;
      const nation = filename.slice(0, -FORCES_SUFFIX.length);
      forces[nation] = JSON.parse(
        fs.readFileSync(path.join(forcesDir, filename), 'utf-8'),
      );
    }
  }
  return { state, forces };
}

// Resolve mergeability with retries — GitHub can return null while the
// background mergeability check is still running.
let pr;
let mergeable = null;
for (let i = 0; i < 5; i++) {
  pr = JSON.parse(gh(`repos/${REPO}/pulls/${PR_NUMBER}`));
  if (pr.mergeable !== null) {
    mergeable = pr.mergeable_state === 'dirty' ? false : pr.mergeable;
    break;
  }
  await sleep(2000);
}
const prBody = pr?.body ?? '';

const files = JSON.parse(gh(`repos/${REPO}/pulls/${PR_NUMBER}/files`));
const changedFiles = files.map((f) => f.filename);

const perms = JSON.parse(fs.readFileSync(`${BASE}/public/data/perm.json`, 'utf-8'));
const base = readStateAndForces(BASE);
// Head may be missing files the PR didn't touch — but the actions/checkout
// step always pulls the full PR branch, so files unchanged from main are
// still present. Use whatever is there; fall back to base values if a
// structural file is missing entirely.
const headRaw = readStateAndForces(HEAD);
const head = {
  state: Object.keys(headRaw.state).length > 0 ? headRaw.state : base.state,
  forces: Object.keys(headRaw.forces).length > 0 ? headRaw.forces : base.forces,
};

const result = validateMove({
  base,
  head,
  perms,
  prAuthor: PR_AUTHOR,
  prBody,
  changedFiles,
  mergeable,
});

if (result.valid) {
  console.log(`PASS: ${result.note ?? ''}`);
  output('valid', 'true');
} else {
  console.log(`REJECT: ${result.reason}`);
  output('valid', 'false');
  output('reason', result.reason);
}

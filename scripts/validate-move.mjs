// Validator for player-submitted move PRs. Runs inside the
// validate-and-merge workflow. Outputs `valid=true|false` and a `reason`
// to $GITHUB_OUTPUT; the workflow comments + merges accordingly.
//
// I/O is handled here; the decision logic lives in lib/validate-move-core.mjs
// so it's independently testable without gh CLI / fs fixtures.
//
// Inputs (env): PR_AUTHOR, PR_NUMBER, GITHUB_REPOSITORY, GITHUB_OUTPUT, GH_TOKEN
// Reads:
//   ./base/public/data/perm.json     (TRUSTED — main's perm.json)
//   ./base/public/data/state.json    (TRUSTED — main's state.json)
//   ./head/public/data/state.json    (proposed)
//   gh api repos/.../pulls/<n>       (mergeability)
//   gh api repos/.../pulls/<n>/files (changed file list)

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { validateMove } from './lib/validate-move-core.mjs';

const PR_AUTHOR = process.env.PR_AUTHOR;
const PR_NUMBER = process.env.PR_NUMBER;
const REPO = process.env.GITHUB_REPOSITORY;
const BASE = './base';
const HEAD = './head';

function gh(path) {
  return execSync(`gh api ${path} --paginate`, { encoding: 'utf-8' });
}

function output(key, value) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const baseState = JSON.parse(fs.readFileSync(`${BASE}/public/data/state.json`, 'utf-8'));
// Head state may be absent if the PR doesn't touch state.json (admin
// perm-only edit). Fall back to base so structural checks are no-ops.
let headState = baseState;
const headStatePath = `${HEAD}/public/data/state.json`;
if (fs.existsSync(headStatePath)) {
  headState = JSON.parse(fs.readFileSync(headStatePath, 'utf-8'));
}

const result = validateMove({
  baseState,
  headState,
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

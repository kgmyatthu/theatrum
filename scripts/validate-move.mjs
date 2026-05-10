// Validator for player-submitted move PRs. Runs inside the
// validate-and-merge workflow. Outputs `valid=true|false` and a `reason`
// to $GITHUB_OUTPUT; the workflow comments + merges accordingly.
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

function fail(reason) {
  console.log(`REJECT: ${reason}`);
  output('valid', 'false');
  output('reason', reason);
  process.exit(0);
}

function pass(note) {
  console.log(`PASS: ${note}`);
  output('valid', 'true');
  process.exit(0);
}

function deepEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Step 1: mergeability — reject conflicts up front.
let pr;
for (let i = 0; i < 5; i++) {
  pr = JSON.parse(gh(`repos/${REPO}/pulls/${PR_NUMBER}`));
  if (pr.mergeable !== null) break;
  await sleep(2000);
}
if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
  fail('merge conflict against main — refresh the latest state and resubmit');
}
if (pr.mergeable === null) {
  fail('mergeability could not be determined; please retry');
}

// Step 2: author must be a registered user (perm.json read from BASE — trusted).
const perms = JSON.parse(fs.readFileSync(`${BASE}/public/data/perm.json`, 'utf-8'));
const user = perms[PR_AUTHOR];
if (!user) fail(`@${PR_AUTHOR} is not registered in perm.json`);

// Admins may pass without further checks.
if (user.role === 'admin') pass(`admin @${PR_AUTHOR}`);

if (user.role !== 'player' || !user.nation) {
  fail(`@${PR_AUTHOR} has no playable role assigned`);
}
const playerNation = user.nation;

// Step 3: only public/data/state.json may change.
const files = JSON.parse(gh(`repos/${REPO}/pulls/${PR_NUMBER}/files`));
const changed = files.map((f) => f.filename);
const allowed = new Set(['public/data/state.json']);
const disallowed = changed.filter((p) => !allowed.has(p));
if (disallowed.length > 0) {
  fail(`PR modifies files outside public/data/state.json: ${disallowed.join(', ')}`);
}

// Step 4: structural diff of state.json.
const baseState = JSON.parse(fs.readFileSync(`${BASE}/public/data/state.json`, 'utf-8'));
const headState = JSON.parse(fs.readFileSync(`${HEAD}/public/data/state.json`, 'utf-8'));

if (!deepEq(baseState.ownerships, headState.ownerships)) {
  fail('province ownership cannot be changed by players');
}
if (!deepEq(baseState.countries, headState.countries)) {
  fail('country list (names/colors) cannot be changed by players');
}
if (baseState.provinceFillOpacity !== headState.provinceFillOpacity) {
  fail('display settings cannot be changed by players');
}

const baseForces = new Map(baseState.forces.map((f) => [f.id, f]));
const headForces = new Map(headState.forces.map((f) => [f.id, f]));

// Removed / modified forces
for (const [id, base] of baseForces) {
  const head = headForces.get(id);
  if (!head) {
    if (base.nation !== playerNation) {
      fail(`force #${id} (${base.nation}: ${base.name}) removed; not owned by ${playerNation}`);
    }
  } else if (!deepEq(base, head)) {
    if (base.nation !== playerNation || head.nation !== playerNation) {
      fail(
        `force #${id} edited but nation must be ${playerNation} ` +
          `before AND after (was ${base.nation}, now ${head.nation})`,
      );
    }
  }
}

// Added forces
for (const [id, head] of headForces) {
  if (baseForces.has(id)) continue;
  if (head.nation !== playerNation) {
    fail(`force #${id} (${head.nation}: ${head.name}) added; not owned by ${playerNation}`);
  }
}

// Consistency: nextForceId must be > all existing ids
const maxId = Math.max(0, ...headState.forces.map((f) => f.id));
if (headState.nextForceId <= maxId) {
  fail(`nextForceId (${headState.nextForceId}) must be > max(force.id) (${maxId})`);
}

pass(`player @${PR_AUTHOR} (${playerNation}) — force changes only`);

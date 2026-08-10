// One-shot baker for the initial state files.
//
// The runtime state of the game is split across:
//   public/data/state.json            - appVersion, ownerships, countries
//   public/data/turn.json             - currentDate, lastTurnDays, turnNumber
//   public/data/forces/<nation>.json  - per-nation force list, one file per
//                                       country that has at least one force
//
// Why split: under the old monolithic state.json, two players submitting
// concurrently both rewrote the entire file. A stale baseline from one
// player could roll back another's work, leading to confusing "you
// removed force X" validator rejections for moves they never intended.
// File-per-nation contains the blast radius: two players in different
// nations touch different files (git auto-merges); two in the same
// nation touch the same file but with self-namespacing IDs that don't
// collide. Splitting turn.json from state.json applies the same logic:
// an admin advancing the turn no longer rewrites the same file that
// ownership / country-rename edits live in, so the two streams can
// progress in parallel without merge contention.
//
// Factory inputs:
//   provinces.geojson  → ownership (each feature's properties.owner)
//   owners.json        → country names
//   palette.json       → country colors
//   seed_forces.json   → starting army/navy positions
//
// Run with: node scripts/bake-state.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '../public/data');
const GEOJSON = path.join(DATA, 'provinces.geojson');
const SEED_FORCES = path.join(DATA, 'seed_forces.json');
const OWNERS = path.join(DATA, 'owners.json');
const PALETTE = path.join(DATA, 'palette.json');
const STATE_OUT = path.join(DATA, 'state.json');
const TURN_OUT = path.join(DATA, 'turn.json');
const FORCES_OUT = path.join(DATA, 'forces');

const provinces = JSON.parse(fs.readFileSync(GEOJSON, 'utf-8'));
const seedForces = JSON.parse(fs.readFileSync(SEED_FORCES, 'utf-8'));
const ownerNames = JSON.parse(fs.readFileSync(OWNERS, 'utf-8'));
const palette = JSON.parse(fs.readFileSync(PALETTE, 'utf-8'));

const lc = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : s);

// _fid is the feature's array index (assigned at runtime in BOOTSTRAP_DATA).
const ownerships = provinces.features.map((f, i) => [i, lc(f.properties.owner)]);

// Mint deterministic seed IDs (`seed-0-<seq>`) so re-running the bake
// produces identical IDs every time and the validator's "force IDs must
// be strings" gate is never tripped on a fresh bake. Also seed the
// turn-tracking fields: a fresh force sits at its placement spot with
// a full movement budget, so turnStart == current and kmMovedThisTurn = 0.
// turnStartStrength is the recruitment analogue of the turnStartLon/Lat
// movement anchors — seeding it to the force's own strength means the
// primordial order of battle counts as zero growth against the raising
// cap, rather than reading as if every seed force were recruited on
// turn 0. The server rejects any force missing it, so a re-bake must
// emit it or the baked files are dead on arrival. turnStartBranch is its
// twin — the pool that anchor was earned in — and seeds to the force's own
// branch, i.e. "has not been re-branded this turn"; it is equally mandatory
// server-side.
let seedSeq = 0;
for (const f of seedForces) {
  f.id = `seed-0-${seedSeq++}`;
  f.nation = lc(f.nation);
  f.turnStartLon = f.lon;
  f.turnStartLat = f.lat;
  f.turnStartStrength = f.strength;
  f.turnStartBranch = f.branch;
  f.kmMovedThisTurn = 0;
}

// Group seed forces by canonical nation.
const byNation = new Map();
for (const f of seedForces) {
  if (!byNation.has(f.nation)) byNation.set(f.nation, []);
  byNation.get(f.nation).push(f);
}

const countries = ownerNames
  .filter((name) => typeof palette[name] === 'string')
  .map((name) => ({ name: lc(name), color: palette[name] }));

const missing = ownerNames.filter((n) => typeof palette[n] !== 'string');
if (missing.length > 0) {
  console.warn(`WARN: missing palette entries for: ${missing.join(', ')}`);
}

const state = {
  appVersion: 'theatrum/v9',
  ownerships,
  countries,
};

// Initial turn. Clock starts at 1683-01-01 (province ownership map is
// 1680-era; the three-year gap leaves room for early 1680s deployment
// without rewriting the map). The starter budget (lastTurnDays = 30)
// lets players deploy + reposition forces on day one. Admins bump
// these from the in-app "Advance Turn" control, which writes turn.json
// without disturbing state.json.
const turn = {
  appVersion: 'theatrum/v9',
  currentDate: '1683-01-01',
  lastTurnDays: 30,
  turnNumber: 0,
};

// Pretty-printed: keeps line-based git diffs cheap so concurrent player
// PRs against the same nation file have lower merge-conflict odds.
fs.writeFileSync(STATE_OUT, JSON.stringify(state, null, 2) + '\n');
fs.writeFileSync(TURN_OUT, JSON.stringify(turn, null, 2) + '\n');
fs.mkdirSync(FORCES_OUT, { recursive: true });
for (const [nation, forces] of byNation) {
  fs.writeFileSync(
    path.join(FORCES_OUT, `${nation}.json`),
    JSON.stringify(forces, null, 2) + '\n',
  );
}

console.log(`Wrote ${STATE_OUT}`);
console.log(`  countries:  ${countries.length}`);
console.log(`  ownerships: ${ownerships.length}`);
console.log(`Wrote ${TURN_OUT} (currentDate=${turn.currentDate}, lastTurnDays=${turn.lastTurnDays}, turnNumber=${turn.turnNumber})`);
console.log(`Wrote ${byNation.size} per-nation force files in ${FORCES_OUT}:`);
for (const [nation, forces] of byNation) {
  console.log(`  ${forces.length.toString().padStart(3)}  forces/${nation}.json`);
}

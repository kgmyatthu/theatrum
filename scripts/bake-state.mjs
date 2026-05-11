// One-shot baker for public/data/state.json.
//
// state.json is the single runtime source of truth: country list,
// ownership map, forces. This script assembles the *initial* state.json
// from the factory inputs:
//   - provinces.geojson  → ownership (each feature's properties.owner)
//   - owners.json        → country names
//   - palette.json       → country colors
//   - seed_forces.json   → starting army/navy positions
//
// The output matches the AppSnapshot v4 shape that the app's
// "Export JSON" button produces — so any export can drop in here as a
// 1:1 replacement.
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
const OUT = path.join(DATA, 'state.json');

const provinces = JSON.parse(fs.readFileSync(GEOJSON, 'utf-8'));
const forces = JSON.parse(fs.readFileSync(SEED_FORCES, 'utf-8'));
const ownerNames = JSON.parse(fs.readFileSync(OWNERS, 'utf-8'));
const palette = JSON.parse(fs.readFileSync(PALETTE, 'utf-8'));

// Country / nation names are stored canonically as lowercase so the
// runtime palette[name] / owners.includes(name) lookups never miss.
const lc = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : s);

// _fid is the feature's array index (assigned at runtime in BOOTSTRAP_DATA).
const ownerships = provinces.features.map((f, i) => [i, lc(f.properties.owner)]);

// Mint deterministic IDs for the seed forces in the new ${author}-${epochMs}-${seq}
// shape. We use author='seed' and a fixed sentinel epoch (0) so re-running the
// bake produces identical IDs every time — and so the validator's "force IDs
// must be strings, not numbers" schema gate never trips on a fresh bake.
let seedSeq = 0;
for (const f of forces) {
  f.id = `seed-0-${seedSeq++}`;
  f.nation = lc(f.nation);
}

const countries = ownerNames
  .filter((name) => typeof palette[name] === 'string')
  .map((name) => ({ name: lc(name), color: palette[name] }));

const missing = ownerNames.filter((n) => typeof palette[n] !== 'string');
if (missing.length > 0) {
  console.warn(`WARN: missing palette entries for: ${missing.join(', ')}`);
}

const snapshot = {
  appVersion: 'theatrum/v6',
  ownerships,
  forces,
  countries,
};

// Pretty-printed: keeps line-based git diffs cheap so concurrent player
// PRs against state.json have lower merge-conflict odds.
fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));

console.log(`Wrote ${OUT}`);
console.log(`  ownerships: ${ownerships.length}`);
console.log(`  countries:  ${countries.length}`);
console.log(`  forces:     ${forces.length}`);

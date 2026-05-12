// One-shot migration from v6 (monolithic state.json) to v7 (state.json +
// per-nation force files).
//
// Reads:   public/data/state.json   (v6 — appVersion, ownerships, forces, countries)
// Writes:  public/data/state.json   (v7 — appVersion, ownerships, countries only)
//          public/data/forces/<nation>.json   (one per nation that has forces)
//
// Why: under v6, a player loading the page at T0, adding a force, and
// submitting at T1 sent their full state.json snapshot — including any
// stale (T0 baseline) values for OTHER nations. Concurrent merges in
// (T0, T1] would get rolled back, the validator would reject, and the
// player saw a confusing "you removed force X" error for a move they
// never made. Splitting forces into per-nation files means:
//   - cross-nation concurrent submits no longer touch the same file
//   - the worker can scope the commit to the player's own file
//   - the validator's file-scope check becomes trivially correct
//   - country renames become atomic file-renames

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '../public/data');
const STATE = path.join(DATA, 'state.json');
const FORCES = path.join(DATA, 'forces');

const lc = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : s);

const before = JSON.parse(fs.readFileSync(STATE, 'utf-8'));

// Group forces by canonical (lowercase) nation. Each force keeps its
// own `nation` field so the per-file content is self-describing — the
// validator cross-checks filename vs force.nation as a sanity guard.
const byNation = new Map();
for (const f of before.forces ?? []) {
  const nation = lc(f.nation);
  if (!nation) continue;
  if (!byNation.has(nation)) byNation.set(nation, []);
  byNation.get(nation).push({ ...f, nation });
}

// Ensure the forces/ directory exists.
fs.mkdirSync(FORCES, { recursive: true });

// Write per-nation files. Keep insertion order (which matches state.json's
// original force order) so diffs against the migration commit are minimal.
for (const [nation, forces] of byNation) {
  const file = path.join(FORCES, `${nation}.json`);
  fs.writeFileSync(file, JSON.stringify(forces, null, 2) + '\n');
}

// Rewrite state.json without `forces` (and without `nextForceId` if it's
// somehow still there). Bump appVersion to theatrum/v7 — the validator
// and client both gate on this.
const after = {
  appVersion: 'theatrum/v7',
  ownerships: before.ownerships,
  countries: before.countries,
};
fs.writeFileSync(STATE, JSON.stringify(after, null, 2) + '\n');

console.log(`Wrote ${STATE}`);
console.log(`  countries:  ${after.countries.length}`);
console.log(`  ownerships: ${after.ownerships.length}`);
console.log(`Wrote ${byNation.size} per-nation force files in ${FORCES}:`);
for (const [nation, forces] of byNation) {
  console.log(`  ${forces.length.toString().padStart(3)}  forces/${nation}.json`);
}

// Pure 3-way merge for per-nation force arrays. Used server-side by the
// worker to layer a player's intent (snapshot - baseline) onto current
// main, so concurrent edits from other players in the same nation don't
// get rolled back.
//
// Why 3-way merge: the player's snapshot is a complete forces array,
// not a delta. Without their baseline, the worker can't distinguish
// "force F is at position X because the player moved it" from "force F
// is at position X because that's where it was when they loaded".
//   - baseline = snapshot at bootstrap (what the player started from)
//   - snapshot = what the player is submitting now
//   - main     = current state on origin/main (may have moved)
// Merge rules (by force id):
//   - in snapshot but not in baseline → player ADDED it    (apply unless main already has the id)
//   - in baseline but not in snapshot → player REMOVED it  (drop from main)
//   - in both, content differs        → player EDITED it   (replace in main if present)
//   - in both, content identical      → no intent          (preserve main's version)
//
// This file is dependency-free so it can be imported by the worker
// (Cloudflare Workers runtime) and exercised by node:test in CI.

/**
 * @param {Array<{id: string, [k: string]: unknown}>} baselineForces
 * @param {Array<{id: string, [k: string]: unknown}>} snapshotForces
 * @param {Array<{id: string, [k: string]: unknown}>} mainForces
 * @returns {Array<{id: string, [k: string]: unknown}>} merged forces array
 */
export function rebaseForceFile(baselineForces, snapshotForces, mainForces) {
  const baseline = new Map(baselineForces.map((f) => [f.id, f]));
  const snapshot = new Map(snapshotForces.map((f) => [f.id, f]));
  const merged = new Map(mainForces.map((f) => [f.id, f]));

  // Removals first — anything the player took out should not be
  // resurrected by a later step.
  for (const id of baseline.keys()) {
    if (!snapshot.has(id)) merged.delete(id);
  }

  for (const [id, snapForce] of snapshot) {
    const baseForce = baseline.get(id);
    if (!baseForce) {
      // Player ADDED. Skip if main already has this id (someone else
      // beat us to it with the same deterministic id — vanishingly
      // unlikely, but be safe).
      if (!merged.has(id)) merged.set(id, snapForce);
      continue;
    }
    // Player EDITED if content changed.
    if (JSON.stringify(baseForce) !== JSON.stringify(snapForce)) {
      // Replace only if main still has the force. If main dropped it
      // (another player removed it after the baseline was taken), the
      // edit is moot — the force is gone.
      if (merged.has(id)) merged.set(id, snapForce);
    }
    // Unchanged in player's snapshot → preserve main's version (which
    // is already in `merged`).
  }

  return [...merged.values()];
}

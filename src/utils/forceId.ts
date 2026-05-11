// Force IDs are minted client-side, no shared counter. Format:
//   `${login}-${epochMs}-${seq}`
//
// - login         disambiguates across users (self-namespacing). Two
//                 players adding armies at the same instant never collide.
// - epochMs       creation time, sortable, debuggable.
// - seq           per-page-session monotonic counter, guards against two
//                 adds in the same millisecond by the same user.
//
// Deterministic: same inputs → same output. No randomness, no hashing —
// the components are visible in the ID so we can trace it back to who
// added what and when.

let sessionSeq = 0;

/** Mint a new force ID for a logged-in user. */
export function mintForceId(login: string): string {
  return `${login}-${Date.now()}-${sessionSeq++}`;
}

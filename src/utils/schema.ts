/**
 * The on-disk shape contract for state.json. Bumped whenever the file
 * shape changes in a way an older client can't safely round-trip:
 *   - new required field
 *   - existing field's type or interpretation changes
 *   - field removed
 *
 * The validator rejects submissions whose appVersion doesn't match, and
 * the client surfaces a "your browser is stale; refresh" modal when it
 * sees a newer SCHEMA_VERSION on main than the one it was compiled with.
 *
 * Keep in sync with:
 *   scripts/lib/validate-move-core.mjs  (server-side gate)
 *   scripts/bake-state.mjs              (initial bake output)
 */
export const SCHEMA_VERSION = 'theatrum/v6';

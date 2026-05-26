// Pure decision logic for the move validator. The CLI wrapper
// (scripts/validate-move.mjs) gathers I/O — gh API calls, fs reads —
// and hands all inputs to validateMove() below, which is deterministic
// and independently testable. Keep this file dependency-free (the one
// imported helper, movement.mjs, is also dependency-free).

import {
  budgetForBranch,
  haversineKm,
  MOVEMENT_TOLERANCE_KM,
} from './movement.mjs';
//
// v9 data layout (file-per-nation, plus per-concern global files):
//   public/data/state.json            — { appVersion, ownerships, countries }
//   public/data/turn.json             — { appVersion, currentDate, lastTurnDays, turnNumber }
//   public/data/forces/<nation>.json  — Force[]  (only created when non-empty)
//   public/data/perm.json             — admin-only
//
// File-scope rules:
//   Non-admin player : may only touch forces/<their-nation>.json
//   Admin            : may touch state.json, turn.json, perm.json, and any forces/*.json
//
// Cross-file invariants enforced for everyone (admins included):
//   - state.json.appVersion === SCHEMA_VERSION
//   - turn.json.appVersion === SCHEMA_VERSION
//   - every force in forces/<nation>.json has nation === <nation>
//   - force IDs are unique across all nation files
//
// Bumped when the on-disk shape of state.json or forces/*.json changes
// in a way an older client can't safely round-trip. Mirrors the constant
// in src/utils/schema.ts and worker/src/index.ts.
const SCHEMA_VERSION = 'theatrum/v9';

const PERM_FILE = 'public/data/perm.json';
const STATE_FILE = 'public/data/state.json';
const TURN_FILE = 'public/data/turn.json';
const FORCES_PREFIX = 'public/data/forces/';
const FORCES_SUFFIX = '.json';

const lc = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

// Bot-authored PRs (the worker submits as the App) carry the verified
// submitter login as a marker in the PR body. Format:
//   <!-- theatrum-submitter: <login> -->
const SUBMITTER_MARKER = /<!--\s*theatrum-submitter:\s*([A-Za-z0-9-]+)\s*-->/;

function resolveSubmitter(prAuthor, prBody) {
  if (typeof prAuthor === 'string' && prAuthor.endsWith('[bot]')) {
    const m = (prBody ?? '').match(SUBMITTER_MARKER);
    return m ? m[1] : null;
  }
  return prAuthor;
}

/** Convert "public/data/forces/spain.json" → "spain". Returns null if not
 *  in the forces directory or not a .json file. */
function nationFromForcePath(p) {
  if (!p.startsWith(FORCES_PREFIX) || !p.endsWith(FORCES_SUFFIX)) return null;
  return p.slice(FORCES_PREFIX.length, -FORCES_SUFFIX.length);
}

/**
 * @param {{
 *   base: { state: object, turn: object, forces: Record<string, object[]> },
 *   head: { state: object, turn: object, forces: Record<string, object[]> },
 *   perms: Record<string, { role: 'admin' | 'player', nation?: string }>,
 *   prAuthor: string,
 *   prBody?: string,
 *   changedFiles: string[],
 *   mergeable: boolean | null,
 * }} inputs
 * @returns {{ valid: true, note?: string } | { valid: false, reason: string }}
 */
export function validateMove(inputs) {
  const { base, head, perms, prAuthor, prBody, changedFiles, mergeable } = inputs;

  // ── Mergeability gate ────────────────────────────────────────────────
  if (mergeable === false) {
    return {
      valid: false,
      reason: 'merge conflict against main — refresh the latest state and resubmit',
    };
  }
  if (mergeable !== true) {
    return { valid: false, reason: 'mergeability could not be determined; please retry' };
  }

  // ── Schema gate ─────────────────────────────────────────────────────
  // Runs before admin bypass so an admin's stale browser-cached client
  // can't accidentally regress the file shape (e.g. write back v6
  // monolithic state.json after we cut over to v7). turn.json and
  // state.json both carry appVersion so either side can detect drift.
  if (head.state.appVersion !== SCHEMA_VERSION) {
    return {
      valid: false,
      reason: `appVersion mismatch in state.json — expected ${SCHEMA_VERSION}, got ${head.state.appVersion ?? '(missing)'}. Your client is stale; hard-refresh the page.`,
    };
  }
  if (head.turn?.appVersion !== SCHEMA_VERSION) {
    return {
      valid: false,
      reason: `appVersion mismatch in turn.json — expected ${SCHEMA_VERSION}, got ${head.turn?.appVersion ?? '(missing)'}. Your client is stale; hard-refresh the page.`,
    };
  }

  // Force shape invariants (universal — admins included):
  //   1. Every force has a string id.
  //   2. Every force's nation matches the file it lives in.
  //   3. Force ids are unique across all nation files.
  // Filename → nation consistency is what keeps the file-scope check
  // meaningful: without it, a player could put a force with nation X in
  // forces/<their-nation>.json and impersonate X.
  const seenIds = new Set();
  for (const [nation, forces] of Object.entries(head.forces)) {
    for (const f of forces) {
      if (typeof f.id !== 'string') {
        return {
          valid: false,
          reason: `force id ${JSON.stringify(f.id)} in forces/${nation}.json is not a string. Your client is stale; hard-refresh the page.`,
        };
      }
      if (lc(f.nation) !== nation) {
        return {
          valid: false,
          reason: `force ${f.id} in forces/${nation}.json declares nation "${f.nation}"; must match filename`,
        };
      }
      if (seenIds.has(f.id)) {
        return { valid: false, reason: `duplicate force id ${f.id} across nation files` };
      }
      seenIds.add(f.id);
    }
  }

  // Every nation file in head must correspond to a country in state.json.
  // Catches orphans from an admin who removed a country but left its file.
  const knownCountries = new Set(head.state.countries.map((c) => lc(c.name)));
  for (const nation of Object.keys(head.forces)) {
    if (!knownCountries.has(nation)) {
      return {
        valid: false,
        reason: `forces/${nation}.json exists but ${nation} is not in state.json countries`,
      };
    }
  }

  // ── Per-force movement budget (universal) ───────────────────────────
  // Two checks per force:
  //   1. kmMovedThisTurn ≤ branch budget for turn.lastTurnDays.
  //   2. straight-line displacement (turnStart → current) ≤ kmMovedThisTurn.
  //      Catches a cheating client that lies about its path length —
  //      you can't have moved less far than the displacement.
  // Tolerance MOVEMENT_TOLERANCE_KM absorbs JSON round-trip float drift.
  const lastTurnDays = head.turn?.lastTurnDays;
  if (typeof lastTurnDays !== 'number' || lastTurnDays < 0) {
    return {
      valid: false,
      reason: `turn.lastTurnDays is missing or invalid (${lastTurnDays}). Your client is stale; hard-refresh the page.`,
    };
  }
  for (const [nation, forces] of Object.entries(head.forces)) {
    for (const f of forces) {
      // Reject pre-turn forces — every force must carry its turn-tracking
      // fields. Clients on older bundles get rejected here.
      if (
        typeof f.turnStartLon !== 'number' ||
        typeof f.turnStartLat !== 'number' ||
        typeof f.kmMovedThisTurn !== 'number'
      ) {
        return {
          valid: false,
          reason: `force ${f.id} in forces/${nation}.json is missing turn-tracking fields (turnStartLon, turnStartLat, kmMovedThisTurn). Hard-refresh the page.`,
        };
      }
      const budget = budgetForBranch(f.branch, lastTurnDays);
      if (f.kmMovedThisTurn > budget + MOVEMENT_TOLERANCE_KM) {
        return {
          valid: false,
          reason: `force ${f.id} (${f.branch}) in forces/${nation}.json exceeded movement budget: ${Math.round(f.kmMovedThisTurn)} km moved, budget is ${budget} km this turn`,
        };
      }
      const displacement = haversineKm(f.turnStartLat, f.turnStartLon, f.lat, f.lon);
      if (displacement > f.kmMovedThisTurn + MOVEMENT_TOLERANCE_KM) {
        return {
          valid: false,
          reason: `force ${f.id} in forces/${nation}.json displacement (${Math.round(displacement)} km) exceeds reported movement (${Math.round(f.kmMovedThisTurn)} km) — refresh the page`,
        };
      }
    }
  }

  // ── Resolve submitter ────────────────────────────────────────────────
  const submitter = resolveSubmitter(prAuthor, prBody);
  if (!submitter) {
    return {
      valid: false,
      reason: `bot-authored PR missing the theatrum-submitter marker in the body`,
    };
  }

  const user = perms[submitter];
  if (!user) return { valid: false, reason: `@${submitter} is not registered in perm.json` };

  // Admins skip the per-role file-scope check. They still passed every
  // universal invariant above.
  if (user.role === 'admin') return { valid: true, note: `admin @${submitter}` };

  if (user.role !== 'player' || !user.nation) {
    return { valid: false, reason: `@${submitter} has no playable role assigned` };
  }
  const playerNation = lc(user.nation);
  const playerFile = `${FORCES_PREFIX}${playerNation}${FORCES_SUFFIX}`;

  // ── Non-admin file scope ─────────────────────────────────────────────
  // The only file a player may touch is their own nation's force file.
  // Everything else (state.json, perm.json, other nation files, workflow
  // files, source code, etc.) is off-limits.
  const disallowed = changedFiles.filter((p) => p !== playerFile);
  if (disallowed.length > 0) {
    return {
      valid: false,
      reason: `PR modifies files outside ${playerFile}: ${disallowed.join(', ')}`,
    };
  }

  // Belt-and-suspenders for the case where changedFiles is empty (admin
  // edge case shouldn't apply here, but be explicit): if any non-allowed
  // file actually differs between base and head, reject. With the file-
  // scope check above this is normally unreachable, but it guards
  // against a CI configuration where changedFiles is misreported.
  if (JSON.stringify(base.state) !== JSON.stringify(head.state)) {
    return { valid: false, reason: `state.json cannot be changed by players` };
  }
  if (JSON.stringify(base.turn) !== JSON.stringify(head.turn)) {
    return { valid: false, reason: `turn.json cannot be changed by players` };
  }

  return { valid: true, note: `player @${submitter} (${playerNation}) — force changes only` };
}

// Re-exports for the CLI to share constants without parsing the file twice.
export {
  SCHEMA_VERSION,
  PERM_FILE,
  STATE_FILE,
  TURN_FILE,
  FORCES_PREFIX,
  FORCES_SUFFIX,
  nationFromForcePath,
};

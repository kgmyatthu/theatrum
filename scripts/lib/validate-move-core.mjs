// Pure decision logic for the move validator. The CLI wrapper
// (scripts/validate-move.mjs) gathers I/O — gh API calls, fs reads —
// and hands all inputs to validateMove() below, which is deterministic
// and independently testable. Keep this file dependency-free.

const ALLOWED_NON_ADMIN_FILES = new Set(['public/data/state.json']);

const lc = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Bot-authored PRs (the worker submits as the App) carry the verified
// submitter login as a marker in the PR body. Format:
//   <!-- theatrum-submitter: <login> -->
const SUBMITTER_MARKER = /<!--\s*theatrum-submitter:\s*([A-Za-z0-9-]+)\s*-->/;

/**
 * Resolve the effective submitter for a PR. For bot-authored PRs we
 * trust the body marker (only our worker can produce these PRs); for
 * any other author we use the GitHub-reported login as-is.
 *
 * Returns null when the PR was bot-authored but the marker is missing
 * or malformed — caller should reject.
 */
function resolveSubmitter(prAuthor, prBody) {
  if (typeof prAuthor === 'string' && prAuthor.endsWith('[bot]')) {
    const m = (prBody ?? '').match(SUBMITTER_MARKER);
    return m ? m[1] : null;
  }
  return prAuthor;
}

/**
 * @param {{
 *   baseState: { ownerships: Array<[number, string]>, forces: Array<object>, countries: Array<{name:string,color:string}> },
 *   headState: { ownerships: Array<[number, string]>, forces: Array<object>, countries: Array<{name:string,color:string}> },
 *   perms: Record<string, { role: 'admin' | 'player', nation?: string }>,
 *   prAuthor: string,
 *   prBody?: string,
 *   changedFiles: string[],
 *   mergeable: boolean | null,
 * }} inputs
 * @returns {{ valid: true, note?: string } | { valid: false, reason: string }}
 */
export function validateMove(inputs) {
  const { baseState, headState, perms, prAuthor, prBody, changedFiles, mergeable } = inputs;

  // Mergeability — null/undefined means GitHub couldn't determine.
  if (mergeable === false) {
    return {
      valid: false,
      reason: 'merge conflict against main — refresh the latest state and resubmit',
    };
  }
  if (mergeable !== true) {
    return { valid: false, reason: 'mergeability could not be determined; please retry' };
  }

  // Resolve the effective submitter. For bot-authored PRs (the worker
  // submitting as the App), the GitHub-reported author is the bot — the
  // real submitter is in the PR body marker. The marker is trusted only
  // when the PR is bot-authored, since only our worker can author PRs
  // as the App on this repo.
  const submitter = resolveSubmitter(prAuthor, prBody);
  if (!submitter) {
    return {
      valid: false,
      reason: `bot-authored PR missing the theatrum-submitter marker in the body`,
    };
  }

  // Submitter must be in perm.json.
  const user = perms[submitter];
  if (!user) return { valid: false, reason: `@${submitter} is not registered in perm.json` };

  // Admins skip every other check — they own the source of truth.
  if (user.role === 'admin') return { valid: true, note: `admin @${submitter}` };

  if (user.role !== 'player' || !user.nation) {
    return { valid: false, reason: `@${submitter} has no playable role assigned` };
  }
  const playerNation = lc(user.nation);

  // Non-admin PRs may only touch state.json.
  const disallowed = changedFiles.filter((p) => !ALLOWED_NON_ADMIN_FILES.has(p));
  if (disallowed.length > 0) {
    return {
      valid: false,
      reason: `PR modifies files outside public/data/state.json: ${disallowed.join(', ')}`,
    };
  }

  // Players can't change borders or the country list.
  if (!deepEq(baseState.ownerships, headState.ownerships)) {
    return { valid: false, reason: 'province ownership cannot be changed by players' };
  }
  if (!deepEq(baseState.countries, headState.countries)) {
    return {
      valid: false,
      reason: 'country list (names/colors) cannot be changed by players',
    };
  }

  // Defense in depth: reject duplicate ids in head.forces. JSON.parse keeps
  // the last duplicate, which `new Map(...)` would also coalesce — both can
  // mask a "swap an enemy force's nation by adding a same-id entry" attempt
  // before the per-force checks below.
  const seen = new Set();
  const dups = new Set();
  for (const f of headState.forces) {
    if (seen.has(f.id)) dups.add(f.id);
    seen.add(f.id);
  }
  if (dups.size > 0) {
    return { valid: false, reason: `duplicate force id(s) in head: ${[...dups].join(', ')}` };
  }

  const baseForces = new Map(baseState.forces.map((f) => [f.id, f]));
  const headForces = new Map(headState.forces.map((f) => [f.id, f]));

  // Removed / modified forces.
  for (const [id, base] of baseForces) {
    const head = headForces.get(id);
    if (!head) {
      if (lc(base.nation) !== playerNation) {
        return {
          valid: false,
          reason: `force #${id} (${base.nation}: ${base.name}) removed; not owned by ${playerNation}`,
        };
      }
    } else if (!deepEq(base, head)) {
      // Nation must match player BEFORE AND AFTER the edit — catches both
      // "edit enemy force" and "convert enemy force to my nation" attacks.
      if (lc(base.nation) !== playerNation || lc(head.nation) !== playerNation) {
        return {
          valid: false,
          reason:
            `force #${id} edited but nation must be ${playerNation} ` +
            `before AND after (was ${base.nation}, now ${head.nation})`,
        };
      }
    }
  }

  // Added forces.
  for (const [id, head] of headForces) {
    if (baseForces.has(id)) continue;
    if (lc(head.nation) !== playerNation) {
      return {
        valid: false,
        reason: `force #${id} (${head.nation}: ${head.name}) added; not owned by ${playerNation}`,
      };
    }
  }

  return { valid: true, note: `player @${submitter} (${playerNation}) — force changes only` };
}

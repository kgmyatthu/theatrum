// Pure decision logic for the move validator. The CLI wrapper
// (scripts/validate-move.mjs) gathers I/O — gh API calls, fs reads —
// and hands all inputs to validateMove() below, which is deterministic
// and independently testable. Keep this file dependency-free (the one
// imported helper, movement.mjs, is also dependency-free).

import {
  budgetForBranch,
  checkAnchorConservation,
  checkRaiseBudgets,
  haversineKm,
  MOVEMENT_TOLERANCE_KM,
} from './movement.mjs';
//
// v10 data layout (file-per-nation, plus per-concern global files):
//   public/data/state.json            — { appVersion, ownerships, countries }
//   public/data/turn.json             — { appVersion, currentDate, lastTurnDays, turnNumber, populationByNation }
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
const SCHEMA_VERSION = 'theatrum/v10';

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
  // turnNumber gets the same guard as lastTurnDays because it is load-
  // bearing twice over: it arms the newly-raised movement lock below, and
  // it decides whether the anchor-conservation gate runs at all. Read raw
  // and left undefined it fails OPEN in both places — nothing equals
  // undefined, so no force is ever "raised this turn" and every regiment
  // levied this turn is free to march. Demand a real number up front and
  // both call sites can stop re-testing the type.
  const currentTurnNumber = head.turn?.turnNumber;
  if (typeof currentTurnNumber !== 'number') {
    return {
      valid: false,
      reason: `turn.turnNumber is missing or invalid (${currentTurnNumber}). Your client is stale; hard-refresh the page.`,
    };
  }
  for (const [nation, forces] of Object.entries(head.forces)) {
    for (const f of forces) {
      // Reject pre-turn forces — every force must carry its turn-tracking
      // fields. Clients on older bundles get rejected here.
      // strength/turnStartStrength are mandatory for the same reason the
      // position anchors are: the raise-budget gate below subtracts them,
      // and a missing or NaN operand would silently price recruitment at
      // zero. Negative strength is rejected too — it would let a nation
      // bank headroom by claiming a debt.
      // turnStartBranch is mandatory for the same reason and must be one
      // of the two real branches: it is the anchor's branch identity, and
      // both gates below key off it — raiseCost compares it against the
      // current branch to bill a re-brand in full, and the conservation
      // sums bucket by it. A missing or bogus value lands the anchor in
      // the army pool by fallback, which silently moves a navy anchor
      // between pools.
      // lat/lon and branch are here to close a worker-vs-validator gap
      // rather than for arithmetic of our own: the worker rejects both,
      // this file did not, and anything this file waves through lands on
      // main — where it is read back into every client's snapshot and
      // bounces EVERY player's next submission off the worker's guard.
      // A single hand-crafted PR carrying branch:'cavalry' was enough to
      // brick submissions game-wide. (A bad lat/lon also slips the
      // displacement check below, since NaN > x is false.) The message is
      // left as-is: it names the fields that motivated it, not every
      // field tested, and it is asserted verbatim on both sides.
      if (
        typeof f.turnStartLon !== 'number' ||
        typeof f.turnStartLat !== 'number' ||
        typeof f.kmMovedThisTurn !== 'number' ||
        typeof f.lat !== 'number' ||
        typeof f.lon !== 'number' ||
        !Number.isFinite(f.strength) ||
        f.strength < 0 ||
        !Number.isFinite(f.turnStartStrength) ||
        f.turnStartStrength < 0 ||
        (f.turnStartBranch !== 'army' && f.turnStartBranch !== 'navy') ||
        (f.branch !== 'army' && f.branch !== 'navy')
      ) {
        return {
          valid: false,
          reason: `force ${f.id} in forces/${nation}.json is missing turn-tracking fields (turnStartLon, turnStartLat, kmMovedThisTurn, strength, turnStartStrength, turnStartBranch). Hard-refresh the page.`,
        };
      }
      // Newly raised forces can't move at all during the turn they were
      // raised on. createdAtTurn is optional for back-compat with seed
      // forces baked without it — those are treated as primordial, which
      // the strict equality gives for free now that currentTurnNumber is
      // guaranteed a number: undefined never equals it.
      const justRaised = f.createdAtTurn === currentTurnNumber;
      if (justRaised && f.kmMovedThisTurn > MOVEMENT_TOLERANCE_KM) {
        return {
          valid: false,
          reason: `force ${f.id} in forces/${nation}.json was raised this turn and cannot move until the next turn`,
        };
      }
      const budget = justRaised ? 0 : budgetForBranch(f.branch, lastTurnDays);
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

  // ── Per-nation raise budget (universal) ─────────────────────────────
  // Sits outside the loop above because it is a per-nation sum, not a
  // per-force test: head.forces is already the complete
  // Record<nation, Force[]>, and the checker needs to see every force a
  // nation owns or it under-counts what that nation spent. That whole-
  // record recomputation is also what makes the cap cumulative across
  // several PRs inside one turn without storing a counter anywhere.
  // Runs after the missing-fields guard above has vetted strength and
  // turnStartStrength on every force, since the checker assumes numbers.
  //
  // Population is read from head.turn rather than base.turn for the same
  // reason lastTurnDays and turnNumber are: head is refs/pull/N/merge —
  // this PR already merged into main — so it is the frame that will
  // actually land, and a submission has to be judged against the rules
  // that will be in force once it does. It needs no new file read; the
  // CLI already parses turn.json whole and hands it over. It is anchored
  // at turn start by construction, since turn.json is written only on a
  // turn advance and players are blocked from touching its fields; the
  // ponytail note on that admin-asserted number (and the upgrade path to
  // recomputing it from ownerships) lives on checkRaiseBudgets itself.
  //
  // Deliberately NOT guarded the way lastTurnDays (:156-162) and
  // turnNumber (:170-176) are above, and the asymmetry is the point.
  // Those two are arithmetic this file cannot proceed without — absent,
  // they price every movement budget at NaN — so they are worth a stale-
  // client rejection. populationByNation is instead a rule that may
  // legitimately not exist yet: any turn.json written before this feature
  // simply has no such field, and rejecting on that would brick every
  // submission in the game until the next turn advance rewrote the file.
  // So absence fails OPEN: undefined reaches checkRaiseBudgets, the
  // monthly cap reverts to the flat MEN_PER_MONTH and the standing
  // ceiling to Infinity, which is bit-for-bit today's behaviour. Open on
  // ABSENCE only — a table that IS present fails CLOSED on its contents,
  // a nation missing from it resolving to 0 (and so to the 3000 floor)
  // inside checkRaiseBudgets rather than back to undefined.
  //
  // A value that is not a table AT ALL counts as absence, and this guard
  // is the exact mirror of the one the worker applies to the same field
  // (worker/src/index.ts, `effectivePopulation`) — the two gates have to
  // refuse and accept identical inputs, and without it they do not. Two
  // concrete divergences it closes, both on a turn.json that was
  // hand-edited rather than written by the worker: `null` reaches
  // checkRaiseBudgets, `null[nation]` throws a TypeError, and this file's
  // CLI has no try/catch — so instead of a clean REJECT the whole CI step
  // dies with a stack trace while the worker sails on. And a string or an
  // array indexes to undefined for EVERY nation, resolving all of them to
  // 0 people and a 3000-man ceiling, so CI would reject the entire game
  // as over-mobilised on submissions the worker had already accepted.
  // Both now land where the worker lands: unenforced.
  const rawPopulation = head.turn?.populationByNation;
  const populationByNation =
    typeof rawPopulation === 'object' && rawPopulation !== null && !Array.isArray(rawPopulation)
      ? rawPopulation
      : undefined;
  const overCap = checkRaiseBudgets(head.forces, lastTurnDays, populationByNation);
  if (overCap) {
    // Already a finished sentence, and the violation belongs to a nation
    // rather than any one force, so it gets no force/file prefix.
    return { valid: false, reason: overCap };
  }

  // ── Anchor conservation (universal) ─────────────────────────────────
  // The cap above is only as honest as the anchors it subtracts from, and
  // those anchors are asserted by the client. This is what makes them
  // safe: every head force is paired to its base self BY ID, and a
  // nation's per-branch anchor total may not exceed what exactly those
  // forces were anchored at in base. A force base never saw funds none of
  // that total, so a fabricated anchor — invented on an injected force,
  // edited upward to zero out that force's own growth, or freed up by a
  // mauled force and then spent a second time on a new one — has nowhere
  // to have come from.
  //
  // SCOPE is asymmetric on purpose: HEAD is narrowed to the nation files
  // this PR changes, BASE is passed whole.
  //
  // HEAD narrows because base and head are not two views of one commit.
  // base.forces is main RIGHT NOW (the workflow checks out base.ref);
  // head.forces is refs/pull/N/merge — this PR already merged into main,
  // NOT the raw PR branch. That normally leaves an untouched file
  // identical on both sides, but GitHub computes the merge ref
  // asynchronously and does not re-cut it in step with our checkout, so it
  // can sit one merge behind, and the drift runs the wrong way the moment
  // another nation disbands a force: base no longer holds that id, the
  // stale merge result still does, its allowance is 0, and an innocent
  // player is rejected in a third party's name. Narrowing costs nothing,
  // because anything this submission forges shows up as a changed file by
  // construction.
  //
  // BASE must NOT be narrowed by the same list — that is the one place
  // id-pairing gets silently unbuilt. A renamed force's base entry lives
  // under the OLD nation, and the old nation never survives into `touched`
  // below: the `head.forces[n]` guard drops it precisely because its file
  // is now empty or gone. Index base from that subset and RENAME_COUNTRY —
  // which rewrites force.nation and so carries whole ids from
  // forces/spain.json into forces/hispania.json — reads every one of those
  // ids as freshly invented against an allowance of 0, and a shipped admin
  // feature becomes unsubmittable mid-turn. Base is content main already
  // accepted, so there is nothing to be gained by looking at less of it.
  //
  // EXCEPTION — the one hole in an otherwise total check: when the turn
  // advances, every anchor is SUPPOSED to jump up to its force's current
  // strength, so a submission that changes turnNumber skips the gate
  // entirely. That is safe only because turn.json is admin-only: a player
  // who edits it trips the file-scope check below, and a player who merely
  // carries a stale copy (branched before an advance, so turn.json is not
  // in changedFiles at all) trips the base/head turn compare at the very
  // bottom. base.turn is trusted, so if it somehow has no turnNumber the
  // repo is broken rather than under attack and the comparison skips.
  if (currentTurnNumber === base.turn?.turnNumber) {
    const touched = {};
    for (const p of changedFiles) {
      const n = nationFromForcePath(p);
      if (n && head.forces[n]) touched[n] = head.forces[n];
    }
    // No force file in the list means either nothing to conserve or a CI
    // that misreported changedFiles — the same worry the belt-and-
    // suspenders compares at the bottom carry. Over-check rather than
    // skip: PRs with no force edits are admin-only and rare.
    const scope = Object.keys(touched).length > 0 ? touched : head.forces;
    const inflated = checkAnchorConservation(base.forces, scope);
    if (inflated) {
      // Same shape as overCap: a finished, nation-level sentence.
      return { valid: false, reason: inflated };
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

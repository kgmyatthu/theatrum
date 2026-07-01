import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot } from '@/types';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { buildSnapshot } from '@/utils/snapshot';
import { fetchLiveDataFresh, listForceNations } from '@/utils/liveData';
import { fetchLiveSnapshot } from '@/utils/fetchSnapshot';
import { SCHEMA_VERSION } from '@/utils/schema';

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// Imperative handle for components outside this hook (e.g. the submit
// modal) to talk to the refresh loop. Set when the hook mounts.
type SyncBaselineFn = (snapshot: AppSnapshot) => void;
type SetSubmittingFn = (submitting: boolean) => void;
type FlagStaleFn = (remoteVersion: string | undefined) => void;
type GetBaselineFn = () => AppSnapshot | null;
const handle = {
  syncBaseline: ((_s: AppSnapshot) => {}) as SyncBaselineFn,
  setSubmitting: ((_b: boolean) => {}) as SetSubmittingFn,
  flagStale: ((_v: string | undefined) => {}) as FlagStaleFn,
  getBaseline: (() => null) as GetBaselineFn,
};

/** Call after dispatching APPLY_SNAPSHOT so useStateRefresh updates its
 *  baseline in lockstep. No-op when the hook isn't mounted. */
export function syncStateRefreshBaseline(snapshot: AppSnapshot): void {
  handle.syncBaseline(snapshot);
}

/**
 * Pause / resume the refresh loop. Used by the submit modal: while a
 * PR is in flight, upstream drift would otherwise look like a concurrent
 * conflict (the user's local edits haven't been APPLY_SNAPSHOTted yet,
 * so they'd false-positive against any remote change). The validator
 * already rejects truly conflicting submissions, so silencing this hook
 * during submit is safe.
 */
export function setStateRefreshSubmitting(submitting: boolean): void {
  handle.setSubmitting(submitting);
}

/**
 * Called by the bootstrap loader the moment it sees a snapshot whose
 * appVersion doesn't match our compiled-in SCHEMA_VERSION. Surfaces the
 * stale-client modal at page load instead of waiting for the 30-min poll.
 */
export function flagStaleClientFromSnapshot(snapshot: AppSnapshot): void {
  handle.flagStale(snapshot.appVersion);
}

/**
 * Returns the snapshot we last saw on main (bootstrap or last poll-sync),
 * which is the baseline the player has been editing against. The submit
 * modal sends this to the worker so it can compute the player's true
 * intent (snapshot - baseline) and apply that on top of current main —
 * preventing stale-rollback rejections from concurrent player edits.
 *
 * Returns null if called before bootstrap.
 */
export function getStateRefreshBaseline(): AppSnapshot | null {
  return handle.getBaseline();
}

/**
 * Polls main's state.json every REFRESH_INTERVAL_MS and reconciles with local state:
 *
 *   remote == baseline → nothing changed upstream, ignore.
 *   remote != baseline AND no local edits → silently APPLY_SNAPSHOT
 *     and update the baseline. Borders / forces re-render with the
 *     latest moves.
 *   remote != baseline AND local has pending edits → raise a conflict.
 *     The user has to refresh and re-do their edits.
 *
 * "Local edits" = current snapshot differs from baseline OR
 * pendingUserAdds (admin-only perm.json staging) is non-empty.
 *
 * Polling stops once a conflict is raised — the user must refresh
 * to clear it. Module-level SHA cache in liveData is bypassed via
 * fetchLiveDataFresh so we actually pick up new commits.
 */
export function useStateRefresh(): { conflict: boolean; stale: boolean } {
  const dispatch = useAppDispatch();
  const state = useAppState();
  const [conflict, setConflict] = useState(false);
  const [stale, setStale] = useState(false);

  const baselineRef = useRef<string | null>(null);
  const conflictRef = useRef(false);
  const staleRef = useRef(false);
  const submittingRef = useRef(false);
  // Keep a live ref to the latest state so the interval callback (which
  // closes over `state` from when it was set up) reads fresh values.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Capture the bootstrap snapshot as baseline once data has loaded.
  useEffect(() => {
    if (!state.loaded || baselineRef.current !== null || !state.provinces) return;
    const snap = buildSnapshot({
      provinces: state.provinces,
      forces: state.forces,
      palette: state.palette,
      owners: state.owners,
      currentDate: state.currentDate,
      lastTurnDays: state.lastTurnDays,
      turnNumber: state.turnNumber,
    });
    baselineRef.current = JSON.stringify(snap);
  }, [
    state.loaded,
    state.provinces,
    state.forces,
    state.palette,
    state.owners,
  ]);

  // Wire the imperative handle so external callers (the submit modal)
  // can advance the baseline after dispatching APPLY_SNAPSHOT and
  // gate the polling loop while a submission is in flight.
  useEffect(() => {
    handle.syncBaseline = (snapshot) => {
      baselineRef.current = JSON.stringify(snapshot);
      // A successful sync resolves any prior conflict for free.
      conflictRef.current = false;
      setConflict(false);
    };
    handle.setSubmitting = (b) => {
      submittingRef.current = b;
    };
    handle.flagStale = (remoteVersion) => {
      if (staleRef.current) return; // idempotent
      if (remoteVersion === SCHEMA_VERSION) return;
      staleRef.current = true;
      setStale(true);
    };
    handle.getBaseline = () => {
      const raw = baselineRef.current;
      return raw === null ? null : (JSON.parse(raw) as AppSnapshot);
    };
    return () => {
      handle.syncBaseline = () => {};
      handle.setSubmitting = () => {};
      handle.flagStale = () => {};
      handle.getBaseline = () => null;
    };
  }, []);

  useEffect(() => {
    if (!state.loaded) return;

    const tick = async (): Promise<void> => {
      if (conflictRef.current) return;
      // While a PR is in flight, drift detection is the validator's job —
      // the modal will fetch fresh state.json on merge and resync the
      // baseline. Silence here so we don't pop a conflict modal over the
      // already-open submit modal.
      if (submittingRef.current) return;
      if (!baselineRef.current) return;

      let remote: AppSnapshot;
      try {
        remote = await fetchLiveSnapshot(fetchLiveDataFresh, () => listForceNations(true));
      } catch (err) {
        // Transient — try again next tick.
        // eslint-disable-next-line no-console
        console.warn('State refresh failed:', err);
        return;
      }

      // Schema-bump detection — main moved to a version this bundle
      // doesn't know how to round-trip. Surface the refresh prompt and
      // bail before we apply anything; the user's edits would just get
      // rejected by the validator's schema gate anyway.
      if (remote.appVersion !== SCHEMA_VERSION) {
        if (!staleRef.current) {
          staleRef.current = true;
          setStale(true);
        }
        return;
      }

      const remoteJson = JSON.stringify(remote);
      if (remoteJson === baselineRef.current) return;

      const cur = stateRef.current;
      if (!cur.provinces) return;

      const localSnap = buildSnapshot({
        provinces: cur.provinces,
        forces: cur.forces,
        palette: cur.palette,
        owners: cur.owners,
        currentDate: cur.currentDate,
        lastTurnDays: cur.lastTurnDays,
        turnNumber: cur.turnNumber,
      });
      const hasLocalEdits =
        JSON.stringify(localSnap) !== baselineRef.current ||
        cur.pendingUserAdds.length > 0;

      if (hasLocalEdits) {
        conflictRef.current = true;
        setConflict(true);
      } else {
        dispatch({ type: 'APPLY_SNAPSHOT', payload: { snapshot: remote } });
        baselineRef.current = remoteJson;
      }
    };

    const id = setInterval(tick, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [state.loaded, dispatch]);

  return { conflict, stale };
}

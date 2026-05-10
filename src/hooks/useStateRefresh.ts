import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot } from '@/types';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { buildSnapshot } from '@/utils/snapshot';
import { fetchLiveDataFresh } from '@/utils/liveData';

const REFRESH_INTERVAL_MS = 60_000;

// Imperative handle for components outside this hook (e.g. the submit
// modal) to talk to the refresh loop. Set when the hook mounts.
type SyncBaselineFn = (snapshot: AppSnapshot) => void;
type SetSubmittingFn = (submitting: boolean) => void;
const handle = {
  syncBaseline: ((_s: AppSnapshot) => {}) as SyncBaselineFn,
  setSubmitting: ((_b: boolean) => {}) as SetSubmittingFn,
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
 * Polls main's state.json every 60s and reconciles with local state:
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
export function useStateRefresh(): { conflict: boolean } {
  const dispatch = useAppDispatch();
  const state = useAppState();
  const [conflict, setConflict] = useState(false);

  const baselineRef = useRef<string | null>(null);
  const conflictRef = useRef(false);
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
      nextForceId: state.nextForceId,
      palette: state.palette,
      owners: state.owners,
    });
    baselineRef.current = JSON.stringify(snap);
  }, [
    state.loaded,
    state.provinces,
    state.forces,
    state.nextForceId,
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
    return () => {
      handle.syncBaseline = () => {};
      handle.setSubmitting = () => {};
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
        remote = await fetchLiveDataFresh<AppSnapshot>('state.json');
      } catch (err) {
        // Transient — try again next tick.
        // eslint-disable-next-line no-console
        console.warn('State refresh failed:', err);
        return;
      }

      const remoteJson = JSON.stringify(remote);
      if (remoteJson === baselineRef.current) return;

      const cur = stateRef.current;
      if (!cur.provinces) return;

      const localSnap = buildSnapshot({
        provinces: cur.provinces,
        forces: cur.forces,
        nextForceId: cur.nextForceId,
        palette: cur.palette,
        owners: cur.owners,
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

  return { conflict };
}

import { useEffect, useRef, useState } from 'react';
import type { AppSnapshot } from '@/types';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { buildSnapshot } from '@/utils/snapshot';
import { fetchLiveDataFresh } from '@/utils/liveData';

const REFRESH_INTERVAL_MS = 60_000;

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

  useEffect(() => {
    if (!state.loaded) return;

    const tick = async (): Promise<void> => {
      if (conflictRef.current) return;
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

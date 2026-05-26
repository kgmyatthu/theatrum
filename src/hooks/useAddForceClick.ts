import { useEffect, type RefObject } from 'react';
import type L from 'leaflet';
import { useAppDispatch, useAppState } from '@/state/AppContext';
// useAppState gives us the live turnNumber so each new force can be stamped
// with the turn it was raised on.
import { useForceDraft } from '@/state/ForceDraftContext';
import { useAuth } from '@/auth/AuthContext';
import { mintForceId } from '@/utils/forceId';

interface UseAddForceClickOptions {
  mapRef: RefObject<L.Map | null>;
  onStatus?: (msg: string) => void;
}

/**
 * When mode === 'add-force', a single map click reads the AddForcePanel
 * draft from ForceDraftContext and dispatches ADD_FORCE at the click latlng.
 *
 * Players are constrained to their own nation: any draft.nation diverging
 * from auth.nation is overridden before dispatch (the AddForcePanel locks
 * its UI too — this is defense in depth).
 */
export function useAddForceClick({ mapRef, onStatus }: UseAddForceClickOptions): void {
  const { mode, turnNumber } = useAppState();
  const dispatch = useAppDispatch();
  const { draftRef } = useForceDraft();
  const auth = useAuth();

  useEffect(() => {
    const map = mapRef.current;
    // Anonymous and unregistered users cannot add forces.
    if (!map || mode !== 'add-force' || auth.status !== 'authenticated') return;

    const handler = (e: L.LeafletMouseEvent): void => {
      const draft = draftRef.current;
      if (!draft) return;
      if (!draft.name) {
        onStatus?.('Enter a force name in the form before placing.');
        return;
      }
      // Players cannot pick nations other than their own.
      const nation =
        auth.role === 'player' && auth.nation ? auth.nation : draft.nation;
      if (!nation) {
        onStatus?.('Choose a nation in the form before placing.');
        return;
      }
      if (!auth.login) return; // narrowing — authenticated implies login
      dispatch({
        type: 'ADD_FORCE',
        payload: {
          force: {
            id: mintForceId(auth.login),
            nation,
            branch: draft.branch,
            name: draft.name,
            strength: draft.strength,
            commander: draft.commander,
            lat: e.latlng.lat,
            lon: e.latlng.lng,
            // A new force starts pinned at its placement spot. The
            // createdAtTurn stamp locks it from moving during the turn
            // it was raised in — server enforces this universally.
            turnStartLat: e.latlng.lat,
            turnStartLon: e.latlng.lng,
            kmMovedThisTurn: 0,
            createdAtTurn: turnNumber,
          },
        },
      });
    };

    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [mapRef, mode, dispatch, draftRef, onStatus, auth.status, auth.role, auth.nation, auth.login, turnNumber]);
}

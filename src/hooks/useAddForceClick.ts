import { useEffect, type RefObject } from 'react';
import type L from 'leaflet';
import { useAppDispatch, useAppState } from '@/state/AppContext';
import { useForceDraft } from '@/state/ForceDraftContext';

interface UseAddForceClickOptions {
  mapRef: RefObject<L.Map | null>;
  onStatus?: (msg: string) => void;
}

/**
 * When mode === 'add-force', a single map click reads the AddForcePanel
 * draft from ForceDraftContext and dispatches ADD_FORCE at the click latlng.
 */
export function useAddForceClick({ mapRef, onStatus }: UseAddForceClickOptions): void {
  const { mode, nextForceId } = useAppState();
  const dispatch = useAppDispatch();
  const { draftRef } = useForceDraft();

  useEffect(() => {
    const map = mapRef.current;
    if (!map || mode !== 'add-force') return;

    const handler = (e: L.LeafletMouseEvent): void => {
      const draft = draftRef.current;
      if (!draft) return;
      if (!draft.name) {
        onStatus?.('Enter a force name in the form before placing.');
        return;
      }
      if (!draft.nation) {
        onStatus?.('Choose a nation in the form before placing.');
        return;
      }
      dispatch({
        type: 'ADD_FORCE',
        payload: {
          force: {
            id: nextForceId,
            nation: draft.nation,
            branch: draft.branch,
            name: draft.name,
            strength: draft.strength,
            commander: draft.commander,
            lat: e.latlng.lat,
            lon: e.latlng.lng,
          },
        },
      });
    };

    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [mapRef, mode, nextForceId, dispatch, draftRef, onStatus]);
}

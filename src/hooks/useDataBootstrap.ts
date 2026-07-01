import { useEffect } from 'react';
import { useAppDispatch } from '@/state/AppContext';
import { fetchLiveData, listForceNations } from '@/utils/liveData';
import { flagStaleClientFromSnapshot } from '@/hooks/useStateRefresh';
import { fetchLiveSnapshot } from '@/utils/fetchSnapshot';
import type { AppSnapshot, City, ProvinceCollection } from '@/types';

interface Manifest {
  provinces: ProvinceCollection;
  cities: City[];
  snapshot: AppSnapshot;
}

async function fetchManifest(): Promise<Manifest> {
  const [provinces, cities, snapshot] = await Promise.all([
    // Static factory data — bundled into the deploy.
    fetch('/data/provinces.geojson').then((r) => r.json() as Promise<ProvinceCollection>),
    fetch('/data/cities.json').then((r) => r.json() as Promise<City[]>),
    // Live game state — assembled from state.json (global) + per-nation
    // force files. All SHA-pinned to one main HEAD so the snapshot is
    // consistent across all the files.
    fetchLiveSnapshot(fetchLiveData, listForceNations),
  ]);
  return { provinces, cities, snapshot };
}

/**
 * Loads game data on mount and dispatches BOOTSTRAP_DATA. state.json is
 * the source of truth for ownership + forces and is fetched at main's
 * latest commit SHA on every load (so move PRs propagate within seconds,
 * not Fastly's 5-minute branch-ref cache window). The geojson and
 * cities are static factory data served from the bundled deploy.
 */
export function useDataBootstrap(): void {
  const dispatch = useAppDispatch();

  useEffect(() => {
    let cancelled = false;
    fetchManifest()
      .then((m) => {
        if (cancelled) return;
        dispatch({ type: 'BOOTSTRAP_DATA', payload: m });
        // Surface the refresh modal at page load if main's state.json
        // already declares a schema this bundle wasn't compiled for —
        // no need to wait for the 30-min polling tick to notice.
        flagStaleClientFromSnapshot(m.snapshot);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error('Failed to load app data:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [dispatch]);
}

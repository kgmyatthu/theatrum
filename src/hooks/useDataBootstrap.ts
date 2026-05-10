import { useEffect } from 'react';
import { useAppDispatch } from '@/state/AppContext';
import { fetchLiveData } from '@/utils/liveData';
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
    // Live game state — pinned to main's latest commit SHA so we never
    // see Fastly's stale-on-branch-ref window.
    fetchLiveData<AppSnapshot>('state.json'),
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

import { useEffect } from 'react';
import { useAppDispatch } from '@/state/AppContext';
import type { AppSnapshot, City, ProvinceCollection } from '@/types';

interface Manifest {
  provinces: ProvinceCollection;
  cities: City[];
  snapshot: AppSnapshot;
}

async function fetchManifest(): Promise<Manifest> {
  const [provinces, cities, snapshot] = await Promise.all([
    fetch('/data/provinces.geojson').then((r) => r.json() as Promise<ProvinceCollection>),
    fetch('/data/cities.json').then((r) => r.json() as Promise<City[]>),
    fetch('/data/state.json').then((r) => r.json() as Promise<AppSnapshot>),
  ]);
  return { provinces, cities, snapshot };
}

/**
 * Loads the static data on mount and dispatches BOOTSTRAP_DATA. state.json
 * is the single source of truth for game state — country list, ownership,
 * forces. The geojson contributes geometry only. Whatever the user later
 * exports as JSON drops back in here as a 1:1 replacement for state.json.
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

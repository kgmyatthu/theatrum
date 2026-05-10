import { useEffect } from 'react';
import { useAppDispatch } from '@/state/AppContext';
import { liveDataUrl } from '@/utils/liveData';
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
    // Live game state — read from main HEAD on every load so player PRs
    // propagate without a Pages rebuild.
    fetch(liveDataUrl('state.json'), { cache: 'no-cache' })
      .then((r) => r.json() as Promise<AppSnapshot>),
  ]);
  return { provinces, cities, snapshot };
}

/**
 * Loads game data on mount and dispatches BOOTSTRAP_DATA. state.json is
 * the source of truth for ownership + forces and is fetched live from
 * raw.githubusercontent.com (main branch); the geojson and cities are
 * static factory data served from the bundled deploy.
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

import { useEffect } from 'react';
import { useAppDispatch } from '@/state/AppContext';
import type { City, Force, Palette, ProvinceCollection } from '@/types';

interface Manifest {
  provinces: ProvinceCollection;
  cities: City[];
  palette: Palette;
  owners: string[];
  forces: Force[];
}

async function fetchManifest(): Promise<Manifest> {
  const [provinces, cities, palette, owners, seedForces] = await Promise.all([
    fetch('/data/provinces.geojson').then((r) => r.json() as Promise<ProvinceCollection>),
    fetch('/data/cities.json').then((r) => r.json() as Promise<City[]>),
    fetch('/data/palette.json').then((r) => r.json() as Promise<Palette>),
    fetch('/data/owners.json').then((r) => r.json() as Promise<string[]>),
    fetch('/data/seed_forces.json').then((r) => r.json() as Promise<Force[]>),
  ]);
  return { provinces, cities, palette, owners, forces: seedForces };
}

/**
 * Loads the static data on mount and dispatches BOOTSTRAP_DATA.
 */
export function useDataBootstrap(): void {
  const dispatch = useAppDispatch();

  useEffect(() => {
    let cancelled = false;
    fetchManifest()
      .then((m) => {
        if (cancelled) return;
        const nextForceId = Math.max(0, ...m.forces.map((f) => f.id)) + 1;
        dispatch({
          type: 'BOOTSTRAP_DATA',
          payload: { ...m, nextForceId },
        });
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

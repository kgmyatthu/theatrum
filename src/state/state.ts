import type { AppMode, City, Force, Palette, ProvinceCollection } from '@/types';

export interface LayerVisibility {
  provinces: boolean;
  countryLabels: boolean;
  cities: boolean;
  forces: boolean;
}

export interface AppState {
  /** True until BOOTSTRAP_DATA fires. */
  loaded: boolean;

  /** Loaded GeoJSON. The provinces array reference is stable; the features inside have mutable owner properties. */
  provinces: ProvinceCollection | null;
  cities: City[];

  /** Current owner list — sorted alphabetically. Derived from `countries`. */
  owners: string[];
  /** Current colors. Derived from `countries`. */
  palette: Palette;

  forces: Force[];
  nextForceId: number;

  selectedFids: ReadonlySet<number>;

  layerVisibility: LayerVisibility;
  mode: AppMode;
  provinceFillOpacity: number;
  /** User-adjustable size multiplier for country labels and force counters. Range 0.5–1.5. */
  iconScale: number;

  /**
   * Bumps whenever province ownership changes (SET_OWNER, RENAME_COUNTRY,
   * APPLY_SNAPSHOT). Province features are mutated in place for performance,
   * so the GeoJSON reference is stable; consumers that need to recompute
   * derived state (e.g. country labels) depend on this counter.
   */
  provincesVersion: number;

  /**
   * Country renames performed locally since the last bootstrap, in order.
   * Read at submit time so admin PRs can rewrite player nation entries in
   * perm.json — keeps players assigned to their renamed country.
   */
  pendingRenames: Array<{ from: string; to: string }>;

  /**
   * Player additions staged by the admin since bootstrap. Bundled into the
   * next Finalize-changes PR's perm.json commit. Login is the GitHub
   * username; nation is canonical lowercase.
   */
  pendingUserAdds: Array<{ login: string; nation: string }>;
}

export const initialState: AppState = {
  loaded: false,
  provinces: null,
  cities: [],
  owners: [],
  palette: {},
  forces: [],
  nextForceId: 1,
  selectedFids: new Set(),
  layerVisibility: {
    provinces: true,
    countryLabels: true,
    cities: true,
    forces: true,
  },
  mode: 'view',
  provinceFillOpacity: 0.5,
  iconScale: 1.0,
  provincesVersion: 0,
  pendingRenames: [],
  pendingUserAdds: [],
};

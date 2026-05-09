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

  /** Current owner list — sorted alphabetically. */
  owners: string[];
  /** Current colors. */
  palette: Palette;

  /** Built-in baseline — set ONCE on bootstrap. */
  builtinOwners: ReadonlySet<string>;
  originalPalette: Readonly<Record<string, string>>;
  removedBuiltins: ReadonlySet<string>;

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
}

export const initialState: AppState = {
  loaded: false,
  provinces: null,
  cities: [],
  owners: [],
  palette: {},
  builtinOwners: new Set(),
  originalPalette: {},
  removedBuiltins: new Set(),
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
};

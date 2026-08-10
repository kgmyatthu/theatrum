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

  /** In-game date the current state represents. ISO YYYY-MM-DD. */
  currentDate: string;
  /** Days the most recent turn covered. Drives every force's movement budget. */
  lastTurnDays: number;
  /** Display-only turn counter. Starts at 0; bumped on each ADVANCE_TURN. */
  turnNumber: number;
  /**
   * People each nation ruled when this turn began, summed off province
   * ownership at ADVANCE_TURN and carried in turn.json. Drives both
   * recruitment limits: the monthly cap scales with the cube root of it,
   * and the standing-army ceiling is a flat share of it
   * (MAX_ARMY_POP_SHARE, 3.5%). The contrast is the point — one is curved
   * and one is not, so the two limits answer different questions and a
   * nation can be comfortably inside one while the other refuses it, and
   * the two are re-priced by separate knobs: the 4% → 3.5% cut moved every
   * ceiling by 0.875 and left every monthly cap untouched.
   *
   * `undefined` is a real, load-bearing value — "no table available" — and
   * is what the client boots with before turn.json lands. It fails OPEN:
   * the flat MEN_PER_MONTH cap, no ceiling. Written non-optional so every
   * reducer branch and every buildSnapshot call site has to say which of
   * the two it means rather than forgetting the field exists.
   */
  populationByNation: Record<string, number> | undefined;

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
   * Permission entries staged by the admin since bootstrap. Bundled into
   * the next Finalize-changes PR's perm.json commit. `role: 'player'`
   * carries a `nation` (canonical lowercase); `role: 'admin'` doesn't.
   * Upserts existing entries — used both for adding new users and
   * changing an existing user's role / nation.
   */
  pendingUserAdds: Array<
    | { login: string; role: 'player'; nation: string }
    | { login: string; role: 'admin' }
  >;

  /**
   * GitHub logins staged for removal from perm.json. Bundled into the
   * next Finalize-changes PR. Removal wins if a login is in both
   * pendingUserAdds and pendingUserRemoves.
   */
  pendingUserRemoves: string[];
}

export const initialState: AppState = {
  loaded: false,
  provinces: null,
  cities: [],
  owners: [],
  palette: {},
  forces: [],
  currentDate: '1683-01-01',
  lastTurnDays: 30,
  turnNumber: 0,
  // No table until BOOTSTRAP_DATA brings one — recruitment is unenforced
  // rather than enforced against zeroes.
  populationByNation: undefined,
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
  pendingUserRemoves: [],
};

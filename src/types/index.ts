/**
 * Core domain types for the Theatrum app.
 * Everything that crosses module boundaries is typed here.
 */

import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';

// ------------------------------------------------------------------
// Provinces
// ------------------------------------------------------------------

/** Properties on each province feature. */
export interface ProvinceProps {
  /** Stable, monotonically increasing numeric id assigned at load. */
  _fid: number;
  province_name: string;
  modern_country: string;
  /** Current owner — name from `state.owners`. */
  owner: string;
}

export type ProvinceGeometry = Polygon | MultiPolygon;
export type ProvinceFeature = Feature<ProvinceGeometry, ProvinceProps>;
export type ProvinceCollection = FeatureCollection<ProvinceGeometry, ProvinceProps>;

// ------------------------------------------------------------------
// Cities
// ------------------------------------------------------------------

export interface City {
  NAME: string;
  /** Importance ranking — lower = more important. */
  SCALERANK: number;
  lon: number;
  lat: number;
}

// ------------------------------------------------------------------
// Forces (army / navy units)
// ------------------------------------------------------------------

export type ForceBranch = 'army' | 'navy';

export interface Force {
  /**
   * Deterministic ID minted client-side as `${login}-${epochMs}-${seq}`.
   * Self-namespacing per user, so concurrent army adds across two players
   * never collide. Legacy seed forces use numeric strings ("1", "2", ...).
   */
  id: string;
  nation: string;
  branch: ForceBranch;
  name: string;
  /** Troop count for army, ship count for navy. */
  strength: number;
  commander: string;
  lon: number;
  lat: number;
  /**
   * Position at the most recent turn advance (or creation if newer). The
   * server uses this as a sanity check: displacement (turnStart → current)
   * must be ≤ kmMovedThisTurn, catching a cheating client that lies about
   * its path length.
   */
  turnStartLon: number;
  turnStartLat: number;
  /**
   * Cumulative great-circle path length walked this turn. Incremented on
   * every MOVE_FORCE; reset to 0 on ADVANCE_TURN. Enforced ≤
   * branch-km/day × state.lastTurnDays both client- and server-side.
   */
  kmMovedThisTurn: number;
  /**
   * Turn number this force was raised on. Set once at ADD_FORCE time
   * and never mutated. Server locks movement (budget = 0) while
   * createdAtTurn === current turnNumber — "newly raised forces can't
   * march until the next turn." Optional for back-compat: seed forces
   * baked without this field are treated as primordial (always movable).
   */
  createdAtTurn?: number;
}

// ------------------------------------------------------------------
// Palette / countries
// ------------------------------------------------------------------

/** Mapping from country name to hex color (e.g. "#1F4E9C"). Derived view of `countries` for fast O(1) lookup at render time. */
export type Palette = Readonly<Record<string, string>>;

export interface Country {
  name: string;
  color: string;
}

// ------------------------------------------------------------------
// Persistence — single source of truth for what gets saved
// ------------------------------------------------------------------

export interface AppSnapshot {
  /** [fid, owner] pairs — only the current ownership map. */
  ownerships: Array<[number, string]>;
  forces: Force[];
  /** Full country list — name + color. No built-in / custom split. */
  countries: Country[];
  appVersion?: string;
  /** ISO YYYY-MM-DD — the in-game date this snapshot represents. */
  currentDate: string;
  /** Days the most recent turn covered. Drives every force's movement budget. */
  lastTurnDays: number;
  /** Display-only turn counter. Starts at 0; bumped on each ADVANCE_TURN. */
  turnNumber: number;
}

// ------------------------------------------------------------------
// UI state types
// ------------------------------------------------------------------

export type AppMode = 'view' | 'add-force' | 'ruler';

export interface ProvinceClickContext {
  fid: number;
  /** Original DOM event for shift detection, etc. */
  shiftKey: boolean;
  pageX: number;
  pageY: number;
}

// ------------------------------------------------------------------
// Distance / geometry helpers
// ------------------------------------------------------------------

export interface LatLngPair {
  lat: number;
  lon: number;
}

export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

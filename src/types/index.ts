/**
 * Core domain types for the Napoleonic Map app.
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
  id: number;
  nation: string;
  branch: ForceBranch;
  name: string;
  /** Troop count for army, ship count for navy. */
  strength: number;
  commander: string;
  lon: number;
  lat: number;
}

// ------------------------------------------------------------------
// Palette / countries
// ------------------------------------------------------------------

/** Mapping from country name to hex color (e.g. "#1F4E9C"). */
export type Palette = Readonly<Record<string, string>>;

export interface CountrySnapshot {
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
  nextForceId: number;
  /** Custom-added countries plus built-in countries with overridden colors. */
  customCountries: CountrySnapshot[];
  /** Built-in country names that were renamed away (so they don't reappear after reload). */
  removedBuiltins: string[];
  provinceFillOpacity: number;
  exportedAt?: string;
  appVersion?: string;
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

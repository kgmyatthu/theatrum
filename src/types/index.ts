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
  /** Natural Earth admin-1 code, e.g. "GBR-2054". Unique across all 4,596
   *  features, and the join key for anything baked per-province offline. */
  adm1_code: string;
  province_name: string;
  modern_country: string;
  /** Current owner — name from `state.owners`. */
  owner: string;
  /** Estimated 1800 population, folded in at load from the baked
   *  `population1800.json`. Optional because the bake can legitimately have
   *  no figure for a province (or the file can be absent entirely) — callers
   *  must render the gap rather than assume 0. */
  population1800?: number;
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
   * Great-circle distance marched this turn — straight-line from
   * turnStartLat/Lon, since a force moves ONCE per turn. Set (not
   * accumulated) by MOVE_FORCE, reset to 0 on ADVANCE_TURN, and enforced ≤
   * branch-km/day × state.lastTurnDays on both servers.
   *
   * Doubles as the has-moved flag the one-move-per-turn lock is built on:
   * non-zero means this force is done marching until the turn advances.
   * That is why no separate `movedThisTurn` boolean exists — it would be
   * this field, spelled twice.
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
  /**
   * Strength this force had at the START of the current turn — the strength
   * analogue of turnStartLon/turnStartLat. A force raised *during* this turn
   * had no strength at turn start, so it is stamped 0 and consequently bills
   * its whole strength; createdAtTurn is not consulted by the cost model at
   * all. The server bills only growth over this number against the nation's
   * per-turn recruitment cap, so reinforcing costs exactly the men added and
   * losses cost nothing. Optional here for back-compat with snapshots already
   * in flight (the reducer backfills it from `strength`); mandatory
   * server-side.
   */
  turnStartStrength?: number;
  /**
   * Branch this force had at the START of the current turn — exact twin of
   * turnStartStrength, wired in the same places. The anchor above is a bare
   * number with no branch identity, so without this an 80000-man army edited
   * to branch 'navy' with strength 80 would score max(0, 80 - 80000) = 0 and
   * land 80 ships against a 1-ship cap. Comparing it to `branch` makes a
   * re-brand bill in full against the pool it entered, and the anchor-
   * conservation gate buckets turn-start sums by it. Same optionality
   * bargain as turnStartStrength: optional for snapshots in flight (the
   * reducer backfills it from `branch`), mandatory server-side.
   */
  turnStartBranch?: ForceBranch;
  /**
   * Ids this force came out of: the parent for a detachment, everything
   * consumed for a merge. Absent on a force that is nobody's descendant.
   *
   * Read by two server gates, which is the only reason it exists. The move
   * lock scores a force against the most-travelled id it can name, so a
   * detachment inherits its parent's march and a merge inherits the worse
   * of the two — neither is a way to buy a second move. Anchor conservation
   * credits these ids' turn-start strengths (same nation only, spend-once),
   * without which a merged force's summed anchor reads as inflation and
   * every merge is rejected.
   *
   * Optional and unversioned on purpose: a client that never writes it
   * fails STRICT on both gates rather than loose — an unvouched march is
   * refused and an uncredited anchor bills full price — so an old bundle
   * costs its own user a rejection and costs the game nothing.
   */
  fromIds?: string[];
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
  /**
   * People each nation ruled at the moment this turn began — nation →
   * summed `population1800` of every province it owned at the advance.
   * Anchored, not live: it rides in turn.json beside turnNumber so a
   * conquest mid-turn can't change the cap the same turn's recruits are
   * billed against, and so both the client's preview and the servers'
   * gate read one agreed figure.
   *
   * OPTIONAL, and that optionality is the safety contract: absent means
   * "no table was published", which fails OPEN — the flat MEN_PER_MONTH
   * cap and no standing ceiling at all. A nation merely missing from a
   * table that IS present is a different thing entirely and resolves to
   * 0 (fail closed on contents). Never merge the two.
   */
  populationByNation?: Record<string, number>;
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

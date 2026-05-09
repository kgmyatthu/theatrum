import type { BBox, ProvinceGeometry } from '@/types';

/**
 * Compute the bounding box of a GeoJSON Polygon or MultiPolygon.
 */
export function computeBBox(geom: ProvinceGeometry): BBox {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  const visit = (coords: unknown): void => {
    if (Array.isArray(coords) && typeof coords[0] === 'number') {
      const [lon, lat] = coords as [number, number];
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    if (Array.isArray(coords)) {
      for (const child of coords) visit(child);
    }
  };

  visit(geom.coordinates);
  return { minLon, minLat, maxLon, maxLat };
}

/**
 * Build a Set of "lon,lat" coordinate strings (rounded) for fast adjacency
 * tests against another geometry. Two provinces sharing a vertex produce
 * intersecting sets.
 */
export function buildCoordSet(geom: ProvinceGeometry, precision = 2): Set<string> {
  const set = new Set<string>();
  const factor = Math.pow(10, precision);
  const round = (n: number): number => Math.round(n * factor) / factor;

  const visit = (coords: unknown): void => {
    if (Array.isArray(coords) && typeof coords[0] === 'number') {
      const [lon, lat] = coords as [number, number];
      set.add(`${round(lon)},${round(lat)}`);
      return;
    }
    if (Array.isArray(coords)) {
      for (const child of coords) visit(child);
    }
  };

  visit(geom.coordinates);
  return set;
}

/**
 * True if two bboxes overlap or touch (within tol).
 */
export function bboxesAdjacent(a: BBox, b: BBox, tol = 0.001): boolean {
  return !(
    a.maxLon + tol < b.minLon ||
    a.minLon - tol > b.maxLon ||
    a.maxLat + tol < b.minLat ||
    a.minLat - tol > b.maxLat
  );
}

/**
 * True iff two sets share any element. Iterates the smaller set.
 */
export function setsIntersect<T>(a: Set<T>, b: Set<T>): boolean {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const v of small) if (large.has(v)) return true;
  return false;
}

/**
 * Great-circle distance in kilometers (Haversine).
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

// Movement rules — shared between the worker, the validator, and the
// client (via src/utils/movement.ts which re-exports these constants).
// Keep dependency-free so the worker bundle stays small.

export const ARMY_KM_PER_DAY = 25;
export const NAVY_KM_PER_DAY = 200;

/** Per-turn km cap for a force. Branches outside the two known values
 *  fall back to the army rate (safer to under-budget than to over-budget). */
export function budgetForBranch(branch, lastTurnDays) {
  const perDay = branch === 'navy' ? NAVY_KM_PER_DAY : ARMY_KM_PER_DAY;
  return perDay * Math.max(0, lastTurnDays);
}

/** Whole days between two ISO YYYY-MM-DD dates, exclusive of the start.
 *  Negative when `to` is before `from`. */
export function daysBetween(isoFrom, isoTo) {
  const a = Date.parse(isoFrom + 'T00:00:00Z');
  const b = Date.parse(isoTo + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Great-circle distance in km. Mirrors src/utils/geometry.ts:haversineKm
 *  so this file has no client dependency. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Float-drift tolerance for the displacement ≤ kmMovedThisTurn sanity
 *  check. 0.1 km absorbs the JSON round-trip on lat/lon. */
export const MOVEMENT_TOLERANCE_KM = 0.1;

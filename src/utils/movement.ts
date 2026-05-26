// Movement rules — mirror of scripts/lib/movement.mjs so both client
// and worker can compute budgets without cross-tree imports. If you
// change a value here, change it there too. (Both files are tiny and
// the test suite covers the equivalence.)

import type { ForceBranch } from '@/types';

export const ARMY_KM_PER_DAY = 25;
export const NAVY_KM_PER_DAY = 200;
export const MOVEMENT_TOLERANCE_KM = 0.1;

export function budgetForBranch(branch: ForceBranch, lastTurnDays: number): number {
  const perDay = branch === 'navy' ? NAVY_KM_PER_DAY : ARMY_KM_PER_DAY;
  return perDay * Math.max(0, lastTurnDays);
}

/** Whole days between two ISO YYYY-MM-DD dates. Negative if `to` < `from`. */
export function daysBetween(isoFrom: string, isoTo: string): number {
  const a = Date.parse(isoFrom + 'T00:00:00Z');
  const b = Date.parse(isoTo + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

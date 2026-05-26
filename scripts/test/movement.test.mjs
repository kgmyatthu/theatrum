// Unit tests for the pure helpers in scripts/lib/movement.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARMY_KM_PER_DAY,
  NAVY_KM_PER_DAY,
  MOVEMENT_TOLERANCE_KM,
  budgetForBranch,
  daysBetween,
  haversineKm,
} from '../lib/movement.mjs';

test('constants: army & navy km/day match spec', () => {
  assert.equal(ARMY_KM_PER_DAY, 25);
  assert.equal(NAVY_KM_PER_DAY, 200);
  assert.equal(MOVEMENT_TOLERANCE_KM, 0.1);
});

test('budgetForBranch: army × 30 days = 750 km', () => {
  assert.equal(budgetForBranch('army', 30), 750);
});

test('budgetForBranch: navy × 30 days = 6000 km', () => {
  assert.equal(budgetForBranch('navy', 30), 6000);
});

test('budgetForBranch: unknown branch defaults to army rate (safer cap)', () => {
  assert.equal(budgetForBranch('cavalry', 30), 750);
  assert.equal(budgetForBranch(undefined, 10), 250);
});

test('budgetForBranch: zero days = zero budget', () => {
  assert.equal(budgetForBranch('army', 0), 0);
});

test('budgetForBranch: negative days clamp to zero', () => {
  assert.equal(budgetForBranch('army', -5), 0);
});

test('daysBetween: trivial one-month bump', () => {
  assert.equal(daysBetween('1680-01-01', '1680-01-31'), 30);
});

test('daysBetween: year bump accounts for leap year', () => {
  // 1680 was a leap year.
  assert.equal(daysBetween('1680-01-01', '1681-01-01'), 366);
});

test('daysBetween: same date = 0', () => {
  assert.equal(daysBetween('1680-03-15', '1680-03-15'), 0);
});

test('daysBetween: negative when reversed', () => {
  assert.equal(daysBetween('1680-02-01', '1680-01-01'), -31);
});

test('daysBetween: malformed input returns 0', () => {
  assert.equal(daysBetween('not-a-date', '1680-01-01'), 0);
  assert.equal(daysBetween('1680-01-01', ''), 0);
});

test('haversineKm: zero distance on identical points', () => {
  assert.equal(haversineKm(40.4, -3.7, 40.4, -3.7), 0);
});

test('haversineKm: Madrid → Paris is ~1050 km', () => {
  const d = haversineKm(40.4168, -3.7038, 48.8566, 2.3522);
  assert.ok(Math.abs(d - 1053) < 5, `expected ~1053 km, got ${d}`);
});

test('haversineKm: London → New York is ~5570 km', () => {
  const d = haversineKm(51.5074, -0.1278, 40.7128, -74.006);
  assert.ok(Math.abs(d - 5570) < 10, `expected ~5570 km, got ${d}`);
});

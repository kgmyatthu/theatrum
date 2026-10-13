import type { AppSnapshot, ProvinceCollection } from '@/types';
import { normalizeNation } from '@/utils/nation';
import { populationByOwner, populationTableError } from '../../scripts/lib/population.mjs';

/** Validate an import without touching the loaded world; rebuild only from its ownership overrides. */
export function prepareImportSnapshot(
  snapshot: AppSnapshot,
  provinces: ProvinceCollection | null,
  rebuildPopulation: boolean,
): AppSnapshot {
  if (!provinces?.features.length) throw new Error('Province data is not loaded.');
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('The import must contain a snapshot object.');
  }
  if (!Array.isArray(snapshot.countries) || snapshot.countries.length === 0) {
    throw new Error('The import must contain a full country registry.');
  }
  const countries = new Set<string>();
  for (const country of snapshot.countries) {
    if (
      !country ||
      typeof country.name !== 'string' ||
      !normalizeNation(country.name) ||
      typeof country.color !== 'string' ||
      !country.color.trim()
    ) {
      throw new Error('Every imported country must have a name and color.');
    }
    const name = normalizeNation(country.name);
    if (countries.has(name)) throw new Error(`Duplicate imported country: ${name}.`);
    countries.add(name);
  }
  if (
    !Array.isArray(snapshot.ownerships) ||
    snapshot.ownerships.length !== provinces.features.length
  ) {
    throw new Error('The import must assign every loaded province exactly once.');
  }
  const seen = new Set<number>();
  for (const entry of snapshot.ownerships) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error('Imported ownerships must be [province ID, country] pairs.');
    }
    const [fid, owner] = entry;
    if (!Number.isInteger(fid) || fid < 0 || fid >= provinces.features.length || seen.has(fid)) {
      throw new Error('Imported province IDs must be unique integers covering the loaded map.');
    }
    if (typeof owner !== 'string' || !countries.has(normalizeNation(owner))) {
      throw new Error(`Imported province ${fid} has an owner outside the country registry.`);
    }
    seen.add(fid);
  }
  if (
    snapshot.forces != null &&
    (!Array.isArray(snapshot.forces) ||
      snapshot.forces.some(
        (force) =>
          !force ||
          typeof force.nation !== 'string' ||
          !countries.has(normalizeNation(force.nation)),
      ))
  ) {
    throw new Error('Imported forces must belong to countries in the imported registry.');
  }
  if (snapshot.currentDate != null) {
    const date = snapshot.currentDate;
    const timestamp = typeof date === 'string' ? Date.parse(`${date}T00:00:00Z`) : NaN;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString().slice(0, 10) !== date
    ) {
      throw new Error('The imported date must be a valid YYYY-MM-DD date.');
    }
  }
  if (
    snapshot.lastTurnDays != null &&
    (!Number.isSafeInteger(snapshot.lastTurnDays) || snapshot.lastTurnDays < 0)
  ) {
    throw new Error('Imported turn length must be a nonnegative whole number of days.');
  }
  if (
    snapshot.turnNumber != null &&
    (!Number.isSafeInteger(snapshot.turnNumber) || snapshot.turnNumber < 0)
  ) {
    throw new Error('Imported turn number must be a nonnegative whole number.');
  }

  const populationByNation = rebuildPopulation
    ? populationByOwner(provinces, snapshot.ownerships)
    : snapshot.populationByNation;
  const error = populationTableError(populationByNation, snapshot.countries);
  if (error) throw new Error(error);
  return { ...snapshot, populationByNation };
}

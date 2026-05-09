import type {
  AppSnapshot,
  CountrySnapshot,
  Force,
  Palette,
  ProvinceCollection,
} from '@/types';

export interface SnapshotInputs {
  provinces: ProvinceCollection;
  forces: Force[];
  nextForceId: number;
  palette: Palette;
  owners: string[];
  builtinOwners: ReadonlySet<string>;
  originalPalette: Readonly<Record<string, string>>;
  removedBuiltins: ReadonlySet<string>;
  provinceFillOpacity: number;
}

/**
 * Compute the "custom countries" portion of a snapshot — anything diverging
 * from the original load.
 */
export function computeCustomCountries(inputs: SnapshotInputs): CountrySnapshot[] {
  const { owners, palette, builtinOwners, originalPalette } = inputs;
  const out: CountrySnapshot[] = [];
  for (const owner of owners) {
    const color = palette[owner];
    if (!color) continue;
    if (!builtinOwners.has(owner)) {
      // Newly added country
      out.push({ name: owner, color });
    } else if (palette[owner] !== originalPalette[owner]) {
      // Built-in country whose color was overridden
      out.push({ name: owner, color });
    }
  }
  return out;
}

export function buildSnapshot(inputs: SnapshotInputs): AppSnapshot {
  return {
    appVersion: 'napoleonic-map-1795/v3',
    ownerships: inputs.provinces.features.map(
      (f) => [f.properties._fid, f.properties.owner] as [number, string],
    ),
    forces: inputs.forces,
    nextForceId: inputs.nextForceId,
    customCountries: computeCustomCountries(inputs),
    removedBuiltins: Array.from(inputs.removedBuiltins),
    provinceFillOpacity: inputs.provinceFillOpacity,
    exportedAt: new Date().toISOString(),
  };
}

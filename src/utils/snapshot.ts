import type {
  AppSnapshot,
  Country,
  Force,
  Palette,
  ProvinceCollection,
} from '@/types';

export interface SnapshotInputs {
  provinces: ProvinceCollection;
  forces: Force[];
  palette: Palette;
  owners: string[];
}

function buildCountries(owners: string[], palette: Palette): Country[] {
  const out: Country[] = [];
  for (const name of owners) {
    const color = palette[name];
    if (!color) continue;
    out.push({ name, color });
  }
  return out;
}

export function buildSnapshot(inputs: SnapshotInputs): AppSnapshot {
  return {
    appVersion: 'theatrum/v6',
    ownerships: inputs.provinces.features.map(
      (f) => [f.properties._fid, f.properties.owner] as [number, string],
    ),
    forces: inputs.forces,
    countries: buildCountries(inputs.owners, inputs.palette),
  };
}

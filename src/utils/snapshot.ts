import type {
  AppSnapshot,
  Country,
  Force,
  Palette,
  ProvinceCollection,
} from '@/types';
import { SCHEMA_VERSION } from './schema';

export interface SnapshotInputs {
  provinces: ProvinceCollection;
  forces: Force[];
  palette: Palette;
  owners: string[];
  currentDate: string;
  lastTurnDays: number;
  turnNumber: number;
  /**
   * Turn-start population table. Required in the input type but allowed to
   * be `undefined`, on purpose: every caller has to decide what it is
   * passing (the compiler asks), while "there is no table" stays sayable —
   * that is the fail-open case the recruitment rules are built around.
   */
  populationByNation: Record<string, number> | undefined;
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
    appVersion: SCHEMA_VERSION,
    ownerships: inputs.provinces.features.map(
      (f) => [f.properties._fid, f.properties.owner] as [number, string],
    ),
    forces: inputs.forces,
    countries: buildCountries(inputs.owners, inputs.palette),
    currentDate: inputs.currentDate,
    lastTurnDays: inputs.lastTurnDays,
    turnNumber: inputs.turnNumber,
    // Last, matching fetchLiveSnapshot's key order — the two objects are
    // JSON.stringify-compared against each other in useStateRefresh. An
    // undefined here serialises to nothing at all, so a client with no
    // table produces exactly the bytes it produced before v10.
    populationByNation: inputs.populationByNation,
  };
}

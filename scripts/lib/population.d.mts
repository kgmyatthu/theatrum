export interface PopulationProvinces {
  features: ReadonlyArray<{
    properties: { owner?: string; population1800?: number };
  }>;
}

export interface PopulationWorld {
  state: {
    ownerships: ReadonlyArray<readonly [number, string]>;
    countries: ReadonlyArray<{ name: string }>;
  };
  turn: {
    currentDate: string;
    lastTurnDays: number;
    turnNumber: number;
    populationByNation?: unknown;
  };
}

/** Sum `population1800` by normalized owner, keys sorted. With `ownerships`
 *  (full imported `[fid, owner][]`) those decide ownership instead of
 *  `feature.properties.owner`. Throws on unavailable or invalid data. */
export function populationByOwner(
  provinces: PopulationProvinces,
  ownerships?: ReadonlyArray<readonly [number, string]>,
): Record<string, number>;

/** Why a table cannot be trusted, or null. Missing table is an error here;
 *  callers decide whether absence is permitted. */
export function populationTableError(
  table: unknown,
  countries: ReadonlyArray<{ name: string }>,
): string | null;

/** The table a submission is scored against, or why it cannot be. */
export function resolvePopulation(
  base: PopulationWorld,
  head: PopulationWorld,
): { populationByNation: Record<string, number> | undefined; error: string | null };

import type { AppSnapshot, Country, Force } from '@/types';

// File-shape contracts. The on-disk layout is:
//   public/data/state.json            → { appVersion, ownerships, countries }
//   public/data/turn.json             → { appVersion, currentDate, lastTurnDays, turnNumber }
//   public/data/forces/<nation>.json  → Force[] (only created when non-empty)
//
// turn.json lives in its own file so an "advance turn" PR doesn't collide
// with concurrent admin edits to state.json (ownerships, country renames).
// The runtime AppSnapshot is the unified view we reconstruct from these.
interface StateFile {
  appVersion: string;
  ownerships: Array<[number, string]>;
  countries: Country[];
}

interface TurnFile {
  appVersion: string;
  currentDate: string;
  lastTurnDays: number;
  turnNumber: number;
}

type Fetcher = <T>(filename: string) => Promise<T>;

/**
 * Reconstruct the unified AppSnapshot from main's split files.
 *
 * Reads state.json + turn.json in parallel, then fans out to fetch
 * forces/<nation>.json for every country in the country list. Most
 * countries have no forces, so their files don't exist — those fetches
 * 404 and contribute an empty array. All requests go through the same
 * fetcher (live or fresh) so the SHA pinning + cache semantics match
 * whichever caller invoked us.
 *
 * Used by:
 *   - useDataBootstrap (via fetchLiveData — once-per-session SHA cache)
 *   - useStateRefresh  (via fetchLiveDataFresh — every-tick SHA refresh)
 */
export async function fetchLiveSnapshot(fetcher: Fetcher): Promise<AppSnapshot> {
  const [state, turn] = await Promise.all([
    fetcher<StateFile>('state.json'),
    fetcher<TurnFile>('turn.json'),
  ]);

  const forcePromises = state.countries.map((c) => {
    const nation = c.name; // already canonical lowercase
    return fetcher<Force[]>(`forces/${encodeURIComponent(nation)}.json`).catch(() => {
      // Most countries don't have a force file at all (no forces yet) —
      // expected 404. Swallow and yield empty so the unified snapshot
      // just omits them.
      return [] as Force[];
    });
  });
  const forcesByCountry = await Promise.all(forcePromises);
  const forces = forcesByCountry.flat();

  return {
    appVersion: state.appVersion,
    ownerships: state.ownerships,
    countries: state.countries,
    forces,
    currentDate: turn.currentDate,
    lastTurnDays: turn.lastTurnDays,
    turnNumber: turn.turnNumber,
  };
}

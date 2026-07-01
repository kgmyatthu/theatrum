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
/** Returns the nations with a force file, or null when unavailable (dev / API error). */
type Lister = () => Promise<string[] | null>;

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
export async function fetchLiveSnapshot(fetcher: Fetcher, lister?: Lister): Promise<AppSnapshot> {
  const [state, turn, listed] = await Promise.all([
    fetcher<StateFile>('state.json'),
    fetcher<TurnFile>('turn.json'),
    // Directory listing shares the same SHA round-trip as state/turn, so
    // it costs no extra wall-clock. null → fall back to probing everyone.
    lister ? lister() : Promise.resolve(null),
  ]);

  // Only fetch nations that actually have a force file. The fallback (dev,
  // or a listing failure) probes every country — those misses 404 into [].
  const nations = listed ?? state.countries.map((c) => c.name); // names already canonical lowercase
  const forcePromises = nations.map((nation) =>
    fetcher<Force[]>(`forces/${encodeURIComponent(nation)}.json`).catch(() => [] as Force[]),
  );
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

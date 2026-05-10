import type { AppSnapshot } from '@/types';
import { fetchLiveDataFresh } from '@/utils/liveData';
import { getSession, GitHubAuthError } from './session';

const WORKER_URL = import.meta.env.VITE_OAUTH_WORKER_URL as string | undefined;

export interface CountryRename {
  from: string;
  to: string;
}

export type UserAdd =
  | { login: string; role: 'player'; nation: string }
  | { login: string; role: 'admin' };

/**
 * Compare a candidate snapshot against state.json on main. Returns false
 * when they're structurally identical — caller should refuse to open an
 * empty PR.
 *
 * Reads via the public raw URL (fetchLiveDataFresh) so the check works
 * even before the worker submit path is exercised — and doesn't require
 * any GitHub-side write access.
 */
export async function hasMeaningfulDiff(snapshot: AppSnapshot): Promise<boolean> {
  try {
    const remote = await fetchLiveDataFresh<AppSnapshot>('state.json');
    return JSON.stringify(snapshot) !== JSON.stringify(remote);
  } catch {
    // Couldn't read main — let the caller submit; the validator will sort it out.
    return true;
  }
}

export interface SubmitMoveArgs {
  /** Snapshot to commit (built from current in-memory state). */
  snapshot: AppSnapshot;
  /** Optional player-supplied description. */
  description?: string;
  /**
   * Country renames performed since bootstrap. Admin-only on the worker
   * side; the worker drops these for non-admins (defense in depth — the
   * validator also rejects any non-admin PR that touches perm.json).
   */
  renames?: CountryRename[];
  /** Player additions / nation reassignments. Admin-only. */
  userAdds?: UserAdd[];
  /** GitHub logins to delete from perm.json. Admin-only. */
  userRemoves?: string[];
}

export interface SubmitMoveResult {
  prNumber: number;
  prUrl: string;
}

/**
 * Submit a move via the worker.
 *
 * The worker holds the App's installation token and opens the PR as the
 * App, with the player's verified GitHub login written into the PR body.
 * This means players don't need write access on the repo (collaborator
 * status, fork install, etc.) — they just need an OAuth token.
 *
 * The validator workflow trusts the body marker because the PR is
 * authored by our specific bot identity.
 */
export async function submitMove(args: SubmitMoveArgs): Promise<SubmitMoveResult> {
  if (!WORKER_URL) throw new Error('VITE_OAUTH_WORKER_URL is not configured');
  const session = getSession();
  if (!session?.access_token) throw new GitHubAuthError('not signed in');

  const submitUrl = new URL('/submit', WORKER_URL).toString();
  const r = await fetch(submitUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({
      snapshot: args.snapshot,
      description: args.description,
      renames: args.renames ?? [],
      userAdds: args.userAdds ?? [],
      userRemoves: args.userRemoves ?? [],
    }),
  });

  if (r.status === 401) {
    throw new GitHubAuthError('user token rejected by submit endpoint');
  }

  let payload: { prNumber?: number; prUrl?: string; error?: string };
  try {
    payload = (await r.json()) as typeof payload;
  } catch {
    throw new Error(`submit failed: HTTP ${r.status}`);
  }

  if (!r.ok || !payload.prNumber || !payload.prUrl) {
    throw new Error(payload.error ?? `submit failed: HTTP ${r.status}`);
  }
  return { prNumber: payload.prNumber, prUrl: payload.prUrl };
}

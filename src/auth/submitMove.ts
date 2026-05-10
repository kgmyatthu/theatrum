import type { AppSnapshot } from '@/types';
import {
  createBranch,
  createPullRequest,
  getFile,
  getRef,
  putFile,
  utf8ToBase64,
} from './githubApi';

const REPO = (import.meta.env.VITE_GITHUB_REPO as string | undefined) ?? '';
const STATE_PATH = 'public/data/state.json';

export interface SubmitMoveArgs {
  login: string;
  /** Snapshot to commit (built from current in-memory state). */
  snapshot: AppSnapshot;
  /** Optional player-supplied description. */
  description?: string;
}

export interface SubmitMoveResult {
  prNumber: number;
  prUrl: string;
}

/**
 * Open a PR proposing a move. Auth is handled transparently by
 * authedFetch inside githubApi — callers don't pass tokens.
 *
 * Steps:
 *   1. Read main's HEAD SHA so the new branch is rooted there.
 *   2. Create branch `move/<login>-<timestamp>` from main.
 *   3. Read the current state.json blob SHA on main (required by contents API).
 *   4. PUT the new state.json content on the new branch.
 *   5. Open a PR from the new branch into main.
 */
export async function submitMove(args: SubmitMoveArgs): Promise<SubmitMoveResult> {
  if (!REPO) throw new Error('VITE_GITHUB_REPO is not configured');
  const { login, snapshot, description } = args;

  const mainRef = await getRef(REPO, 'main');
  const baseSha = mainRef.object.sha;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const branchName = `move/${login}-${ts}`;
  await createBranch(REPO, branchName, baseSha);

  const file = await getFile(REPO, STATE_PATH, 'main');

  // Pretty-printed so PR diffs are line-scoped and merge conflicts stay rare.
  const json = JSON.stringify(snapshot, null, 2);
  const base64 = utf8ToBase64(json);
  await putFile(REPO, STATE_PATH, branchName, `move: @${login} ${ts}`, base64, file.sha);

  const title = `Move from @${login}`;
  const body =
    (description?.trim() ? `${description.trim()}\n\n` : '') +
    `Submitted by @${login} via the app. The auto-merge workflow will validate.`;
  const pr = await createPullRequest(REPO, {
    title,
    body,
    head: branchName,
    base: 'main',
  });

  return { prNumber: pr.number, prUrl: pr.html_url };
}

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
const PERM_PATH = 'public/data/perm.json';

export interface CountryRename {
  from: string;
  to: string;
}

interface PermEntry {
  role: 'admin' | 'player';
  nation?: string;
}
type PermFile = Record<string, PermEntry>;

/**
 * Apply rename pairs in order to the player nation entries in perm.json.
 * Order matters: chained renames (Spain→France, France→Germany) walk
 * the chain as written. Returns a new object; input is not mutated.
 */
function rewritePerm(perm: PermFile, renames: CountryRename[]): PermFile {
  const out: PermFile = {};
  for (const [login, entry] of Object.entries(perm)) {
    if (entry.role !== 'player' || !entry.nation) {
      out[login] = entry;
      continue;
    }
    let nation = entry.nation;
    for (const r of renames) {
      if (nation === r.from) nation = r.to;
    }
    out[login] = nation === entry.nation ? entry : { ...entry, nation };
  }
  return out;
}

function base64ToUtf8(b64: string): string {
  // GitHub returns base64 with embedded newlines.
  const clean = b64.replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * Compare a candidate snapshot against state.json on main. Returns false
 * when they're structurally identical — caller should refuse to open an
 * empty PR. Throws on network/auth errors so caller can surface them.
 */
export async function hasMeaningfulDiff(snapshot: AppSnapshot): Promise<boolean> {
  if (!REPO) return true;
  const file = await getFile(REPO, STATE_PATH, 'main');
  let remote: AppSnapshot;
  try {
    remote = JSON.parse(base64ToUtf8(file.content)) as AppSnapshot;
  } catch {
    // Couldn't parse main — let the caller submit; validator will sort it out.
    return true;
  }
  return JSON.stringify(snapshot) !== JSON.stringify(remote);
}

export interface SubmitMoveArgs {
  login: string;
  /** Snapshot to commit (built from current in-memory state). */
  snapshot: AppSnapshot;
  /** Optional player-supplied description. */
  description?: string;
  /**
   * Country renames performed since bootstrap. Admin-only; ignored for
   * players (the validator rejects any non-admin PR that touches perm.json).
   * When non-empty and effective, perm.json is committed alongside
   * state.json so player nation assignments follow the rename.
   */
  renames?: CountryRename[];
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
  const { login, snapshot, description, renames = [] } = args;

  const mainRef = await getRef(REPO, 'main');
  const baseSha = mainRef.object.sha;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const branchName = `move/${login}-${ts}`;
  await createBranch(REPO, branchName, baseSha);

  // perm.json carries player nation assignments. Renames have to be
  // mirrored here or players would be locked out of their renamed
  // country. Skip the round-trip when no renames are pending, and skip
  // the commit when the rewrite produces no effective change (e.g. the
  // renamed countries had no players assigned).
  if (renames.length > 0) {
    const permFile = await getFile(REPO, PERM_PATH, 'main');
    const permBefore = JSON.parse(base64ToUtf8(permFile.content)) as PermFile;
    const permAfter = rewritePerm(permBefore, renames);
    if (JSON.stringify(permBefore) !== JSON.stringify(permAfter)) {
      const permJson = JSON.stringify(permAfter, null, 2) + '\n';
      const permB64 = utf8ToBase64(permJson);
      const summary = renames.map((r) => `${r.from}→${r.to}`).join(', ');
      await putFile(
        REPO,
        PERM_PATH,
        branchName,
        `perm: rewrite player nations (${summary})`,
        permB64,
        permFile.sha,
      );
    }
  }

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

// OAuth + submit proxy for the Theatrum app.
//
// Endpoints (all POST + JSON unless noted):
//   { code }            → initial code-for-token exchange
//   { refresh_token }   → refresh an expired access token
//   { revoke }          → invalidate a token grant server-side
//   { snapshot, ... }   → submit a move (PR opened as the App, with the
//                         player's verified login written into the body)
//
// Why a server-side submit path: GitHub App user-to-server tokens can
// only act on resources the App is installed on. The App is installed
// on kgmyatthu/theatrum, not on each player's account, so a player's
// token can read the public repo but can't push branches there. Forking
// has the same problem (App not installed on the player's fork). The
// only "player does nothing" answer is to push as the App with an
// installation token, with the player's verified identity stamped into
// the PR body. The validator workflow then trusts that marker because
// it came from a PR authored by our specific bot.
//
// Commit strategy: all file changes for a submit are batched into ONE
// git tree + ONE commit via the Git Data API (git/trees with inline
// content), instead of one Contents API round-trip per file. Workers
// caps subrequests per invocation (50 on the free plan), and a large
// admin submit — e.g. a scenario import touching dozens of per-nation
// force files — blew straight through that cap under the per-file
// scheme. The batched path costs a fixed ~12 subrequests no matter how
// many files change: per-file existence/staleness questions are
// answered locally by comparing git blob SHAs (computed in the Worker)
// against main's tree listing, and blob contents are only fetched for
// the rare true concurrent-edit rebase.
//
// Deploy with `wrangler deploy`. Configure secrets:
//   wrangler secret put GITHUB_CLIENT_ID
//   wrangler secret put GITHUB_CLIENT_SECRET
//   wrangler secret put GITHUB_APP_ID
//   wrangler secret put GITHUB_APP_PRIVATE_KEY    # PKCS#8 PEM
//   wrangler secret put GITHUB_APP_INSTALLATION_ID
//   wrangler secret put GITHUB_REPO               # "owner/name"
//   wrangler secret put ALLOWED_ORIGIN

interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_REPO: string;
  ALLOWED_ORIGIN: string;
}

import { rebaseForceFile } from '../../scripts/lib/rebase-forces.mjs';
import {
  budgetForBranch,
  haversineKm,
  MOVEMENT_TOLERANCE_KM,
} from '../../scripts/lib/movement.mjs';

const UA = 'theatrum-oauth-worker';
const SUBMITTER_MARKER_PREFIX = '<!-- theatrum-submitter:';
// Keep in sync with src/utils/schema.ts and scripts/lib/validate-move-core.mjs.
const SCHEMA_VERSION = 'theatrum/v9';

// ────────────────────────────────────────────────────────────────────
// Generic helpers
// ────────────────────────────────────────────────────────────────────

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function jsonResponse(body: string, status: number, origin: string): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function errorJson(origin: string, status: number, message: string): Response {
  return jsonResponse(JSON.stringify({ error: message }), status, origin);
}

function base64ToUtf8(b64: string): string {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function base64UrlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return base64UrlEncode(bin);
}

function normalizeNation(s: string): string {
  return (s ?? '').trim().toLowerCase();
}

// ────────────────────────────────────────────────────────────────────
// OAuth (existing)
// ────────────────────────────────────────────────────────────────────

async function exchangeWithGitHub(
  env: Env,
  params: Record<string, string>,
  origin: string,
): Promise<Response> {
  const r = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      ...params,
    }),
  });
  return jsonResponse(await r.text(), r.status, origin);
}

async function revokeWithGitHub(env: Env, token: string, origin: string): Promise<Response> {
  // /grant kills the OAuth grant entirely (so consent reappears next sign-in);
  // /token would only kill the current pair.
  const basic = btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`);
  const r = await fetch(
    `https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/grant`,
    {
      method: 'DELETE',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Basic ${basic}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({ access_token: token }),
    },
  );
  if (r.status === 204 || r.status === 422) return jsonResponse('{}', 200, origin);
  return jsonResponse(await r.text(), r.status, origin);
}

// ────────────────────────────────────────────────────────────────────
// App authentication: JWT → installation token
// ────────────────────────────────────────────────────────────────────

let cachedInstallToken: { token: string; expires_at: number } | null = null;

async function importPkcs8Pem(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  if (!cleaned) throw new Error('GITHUB_APP_PRIVATE_KEY is empty');
  const bin = atob(cleaned);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

async function signAppJWT(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  // Backdate iat by 60s to absorb clock skew; cap exp at 10 min (GitHub's max).
  const payload = { iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID };
  const data = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(payload),
  )}`;
  const key = await importPkcs8Pem(env.GITHUB_APP_PRIVATE_KEY);
  const sig = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(data),
  );
  return `${data}.${base64UrlEncodeBytes(new Uint8Array(sig))}`;
}

async function getInstallToken(env: Env): Promise<string> {
  if (cachedInstallToken && cachedInstallToken.expires_at > Date.now() + 60_000) {
    return cachedInstallToken.token;
  }
  const jwt = await signAppJWT(env);
  const r = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': UA,
      },
    },
  );
  if (!r.ok) throw new HttpError(502, `installation token: ${r.status} ${await r.text()}`);
  const j = (await r.json()) as { token: string; expires_at: string };
  cachedInstallToken = {
    token: j.token,
    expires_at: new Date(j.expires_at).getTime(),
  };
  return j.token;
}

// ────────────────────────────────────────────────────────────────────
// GitHub API helpers (using installation token)
// ────────────────────────────────────────────────────────────────────

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface GhInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function gh<T>(path: string, init: GhInit, token: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
    ...(init.headers ?? {}),
  };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    if (typeof init.body !== 'string') headers['Content-Type'] = 'application/json';
  }
  const r = await fetch(`https://api.github.com${path}`, {
    method: init.method,
    headers,
    body,
  });
  if (!r.ok) {
    throw new HttpError(
      r.status,
      `GitHub ${init.method ?? 'GET'} ${path} → ${r.status}: ${await r.text()}`,
    );
  }
  return (await r.json()) as T;
}

// ────────────────────────────────────────────────────────────────────
// User identity verification (uses USER token, not install token)
// ────────────────────────────────────────────────────────────────────

async function verifyUserToken(token: string): Promise<string> {
  const r = await fetch('https://api.github.com/user', {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': UA,
    },
  });
  if (!r.ok) throw new HttpError(401, 'invalid user token');
  const j = (await r.json()) as { login: string };
  if (!j.login) throw new HttpError(401, 'no login on /user response');
  return j.login;
}

// ────────────────────────────────────────────────────────────────────
// perm.json mutation (mirrors the frontend's rewritePerm)
// ────────────────────────────────────────────────────────────────────

interface PermEntry {
  role: 'admin' | 'player';
  nation?: string;
}
type PermFile = Record<string, PermEntry>;

interface CountryRename {
  from: string;
  to: string;
}
type UserAdd =
  | { login: string; role: 'player'; nation: string }
  | { login: string; role: 'admin' };

function rewritePerm(
  perm: PermFile,
  renames: CountryRename[],
  userAdds: UserAdd[],
  userRemoves: string[],
): PermFile {
  const out: PermFile = {};
  const renamePairs = renames.map((r) => ({
    from: normalizeNation(r.from),
    to: normalizeNation(r.to),
  }));
  for (const [login, entry] of Object.entries(perm)) {
    if (entry.role !== 'player' || !entry.nation) {
      out[login] = entry;
      continue;
    }
    let nation = normalizeNation(entry.nation);
    for (const r of renamePairs) {
      if (nation === r.from) nation = r.to;
    }
    out[login] = nation === entry.nation ? entry : { ...entry, nation };
  }
  for (const u of userAdds) {
    const login = u.login.trim();
    if (!login) continue;
    if (u.role === 'admin') {
      out[login] = { role: 'admin' };
    } else {
      const nation = normalizeNation(u.nation);
      if (!nation) continue;
      out[login] = { role: 'player', nation };
    }
  }
  for (const login of userRemoves) {
    const lc = login.trim().toLowerCase();
    if (!lc) continue;
    for (const k of Object.keys(out)) {
      if (k.toLowerCase() === lc) delete out[k];
    }
  }
  return out;
}

function summaryParts(
  renames: CountryRename[],
  userAdds: UserAdd[],
  userRemoves: string[],
): string {
  const parts: string[] = [];
  if (renames.length > 0) parts.push(renames.map((r) => `${r.from}→${r.to}`).join(', '));
  if (userAdds.length > 0) {
    parts.push(
      userAdds
        .map((u) => (u.role === 'admin' ? `+@${u.login}=admin` : `+@${u.login}=${u.nation}`))
        .join(', '),
    );
  }
  if (userRemoves.length > 0) parts.push(userRemoves.map((l) => `-@${l}`).join(', '));
  return parts.join('; ');
}

// ────────────────────────────────────────────────────────────────────
// Batched-commit helpers (Git Data API)
// ────────────────────────────────────────────────────────────────────

interface ForceLike {
  id: string;
  nation: string;
  [k: string]: unknown;
}

function groupForcesByNation(forces: ForceLike[]): Map<string, ForceLike[]> {
  const m = new Map<string, ForceLike[]>();
  for (const f of forces) {
    const n = normalizeNation(f.nation);
    if (!n) continue;
    if (!m.has(n)) m.set(n, []);
    m.get(n)!.push(f);
  }
  return m;
}

/**
 * Git blob SHA-1 of a candidate file body ("blob <len>\0<content>").
 * Lets us decide identical / changed against a tree entry entirely
 * locally — no subrequest — which is what keeps big submits inside the
 * Workers subrequest budget.
 */
async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${body.length}\0`);
  const buf = new Uint8Array(header.length + body.length);
  buf.set(header, 0);
  buf.set(body, header.length);
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function readBlob(repo: string, sha: string, token: string): Promise<string> {
  const b = await gh<{ content: string }>(
    `/repos/${repo}/git/blobs/${sha}`,
    { method: 'GET' },
    token,
  );
  return base64ToUtf8(b.content);
}

/**
 * path → blob sha for every file reachable from a commit, in two API
 * calls (commit → tree sha, then one recursive tree listing).
 */
async function fetchTreeMap(
  repo: string,
  commitSha: string,
  token: string,
): Promise<Map<string, string>> {
  const commit = await gh<{ tree: { sha: string } }>(
    `/repos/${repo}/git/commits/${commitSha}`,
    { method: 'GET' },
    token,
  );
  const t = await gh<{
    tree: Array<{ path: string; type: string; sha: string }>;
    truncated: boolean;
  }>(`/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`, { method: 'GET' }, token);
  if (t.truncated) {
    // ~100k entries before GitHub truncates; this repo is a few hundred.
    // Fail loudly rather than risk missing a deletion.
    throw new HttpError(502, 'repo tree listing truncated — cannot batch submit safely');
  }
  const m = new Map<string, string>();
  for (const e of t.tree) if (e.type === 'blob') m.set(e.path, e.sha);
  return m;
}

/** One planned file change, applied later as a single tree + commit. */
type PlannedChange =
  | { path: string; content: string }
  | { path: string; delete: true };

// ────────────────────────────────────────────────────────────────────
// Submit handler
// ────────────────────────────────────────────────────────────────────

interface SubmitBody {
  snapshot?: unknown;
  /**
   * The bootstrap (or most-recently-polled) snapshot the player has been
   * editing against. Required by the v2 submit path to power 3-way merge;
   * omitted by older cached clients, in which case we fall back to blind
   * commit semantics (the v7 behavior).
   */
  baseline?: unknown;
  description?: string;
  renames?: CountryRename[];
  userAdds?: UserAdd[];
  userRemoves?: string[];
}

async function handleSubmit(request: Request, env: Env, origin: string): Promise<Response> {
  const auth = request.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return errorJson(origin, 401, 'missing user token');
  const userToken = auth.slice(7).trim();

  let login: string;
  try {
    login = await verifyUserToken(userToken);
  } catch (e) {
    return errorJson(origin, 401, (e as Error).message);
  }

  let body: SubmitBody;
  try {
    body = (await request.json()) as SubmitBody;
  } catch {
    return errorJson(origin, 400, 'invalid json body');
  }
  const snapshot = body.snapshot as
    | undefined
    | {
        appVersion?: unknown;
        ownerships?: Array<[number, string]>;
        countries?: Array<{ name: string; color: string }>;
        forces?: ForceLike[];
        currentDate?: unknown;
        lastTurnDays?: unknown;
        turnNumber?: unknown;
      };
  if (!snapshot || typeof snapshot !== 'object') {
    return errorJson(origin, 400, 'missing or invalid snapshot');
  }
  // Schema gate — fail fast on stale browser-cached clients so we don't
  // burn a branch + PR + CI run on something the validator will reject.
  if (snapshot.appVersion !== SCHEMA_VERSION) {
    return errorJson(
      origin,
      400,
      `client is stale: expected appVersion ${SCHEMA_VERSION}, got ${String(snapshot.appVersion)}. Hard-refresh and try again.`,
    );
  }
  if (!Array.isArray(snapshot.forces)) {
    return errorJson(origin, 400, 'snapshot.forces must be an array');
  }
  if (!Array.isArray(snapshot.ownerships)) {
    return errorJson(origin, 400, 'snapshot.ownerships must be an array');
  }
  if (!Array.isArray(snapshot.countries)) {
    return errorJson(origin, 400, 'snapshot.countries must be an array');
  }
  if (typeof snapshot.currentDate !== 'string') {
    return errorJson(origin, 400, 'snapshot.currentDate must be an ISO YYYY-MM-DD string');
  }
  if (typeof snapshot.lastTurnDays !== 'number' || snapshot.lastTurnDays < 0) {
    return errorJson(origin, 400, 'snapshot.lastTurnDays must be a non-negative number');
  }
  if (typeof snapshot.turnNumber !== 'number') {
    return errorJson(origin, 400, 'snapshot.turnNumber must be a number');
  }

  // baseline is optional (older cached clients won't send it). When
  // present, structurally validate so the rebase math can't blow up on
  // a malformed shape, then keep it for the 3-way merge below.
  interface BaselineShape {
    appVersion?: unknown;
    ownerships: Array<[number, string]>;
    countries: Array<{ name: string; color: string }>;
    forces: ForceLike[];
    currentDate?: string;
    lastTurnDays?: number;
    turnNumber?: number;
  }
  let baseline: BaselineShape | undefined = undefined;
  if (body.baseline && typeof body.baseline === 'object') {
    const b = body.baseline as { forces?: unknown; ownerships?: unknown; countries?: unknown };
    if (Array.isArray(b.forces) && Array.isArray(b.ownerships) && Array.isArray(b.countries)) {
      baseline = body.baseline as unknown as BaselineShape;
    }
    // Silently drop a malformed baseline rather than rejecting — falls
    // through to blind-commit semantics, same as a missing baseline.
  }

  let installToken: string;
  try {
    installToken = await getInstallToken(env);
  } catch (e) {
    return errorJson(origin, 502, (e as Error).message);
  }

  // Read perm.json with the install token to determine the submitter's role.
  // The validator does the same thing in CI, but we mirror it here so we can
  // fail fast and so non-admins can never bundle perm.json edits. The raw
  // content is kept so an admin perm edit below can diff against it without
  // a second read.
  let perms: PermFile;
  let permContentOnMain: string;
  try {
    const f = await gh<{ content: string }>(
      `/repos/${env.GITHUB_REPO}/contents/public/data/perm.json?ref=main`,
      { method: 'GET' },
      installToken,
    );
    permContentOnMain = base64ToUtf8(f.content);
    perms = JSON.parse(permContentOnMain) as PermFile;
  } catch (e) {
    return errorJson(origin, 502, `couldn't read perm.json: ${(e as Error).message}`);
  }
  const entry = perms[login];
  if (!entry) {
    return errorJson(origin, 403, `@${login} is not registered in perm.json`);
  }
  const isAdmin = entry.role === 'admin';

  // Strip perm.json edits from non-admins (defense in depth — the validator
  // would reject such a PR anyway).
  const renames: CountryRename[] = isAdmin ? body.renames ?? [] : [];
  const userAdds: UserAdd[] = isAdmin ? body.userAdds ?? [] : [];
  const userRemoves: string[] = isAdmin ? body.userRemoves ?? [] : [];

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const branchName = `move/${login}-${ts}`;

  // 1. Resolve main HEAD and load its full tree once. Every per-file
  //    existence / staleness question below is answered from this single
  //    listing plus local blob-sha math — not a Contents round-trip per
  //    file. The branch is only created at the very end, once the whole
  //    submit has passed validation, so rejections leave no debris.
  let baseSha: string;
  let mainTree: Map<string, string>;
  try {
    const ref = await gh<{ object: { sha: string } }>(
      `/repos/${env.GITHUB_REPO}/git/ref/heads/main`,
      { method: 'GET' },
      installToken,
    );
    baseSha = ref.object.sha;
    mainTree = await fetchTreeMap(env.GITHUB_REPO, baseSha, installToken);
  } catch (e) {
    const msg = (e as Error).message;
    return errorJson(origin, e instanceof HttpError ? e.status : 502, msg);
  }

  const changes: PlannedChange[] = [];

  // 2. perm.json (admin only, when there's an effective change).
  if (renames.length > 0 || userAdds.length > 0 || userRemoves.length > 0) {
    const permAfter = rewritePerm(perms, renames, userAdds, userRemoves);
    if (JSON.stringify(perms) !== JSON.stringify(permAfter)) {
      const json = JSON.stringify(permAfter, null, 2) + '\n';
      if (json !== permContentOnMain) {
        changes.push({ path: 'public/data/perm.json', content: json });
      }
    }
  }

  // 3. Plan per-file content changes. The on-disk layout is:
  //      public/data/state.json            — { appVersion, ownerships, countries }
  //      public/data/forces/<nation>.json  — Force[]
  //    Non-admin players only touch their own nation's force file; the
  //    validator enforces the same rule. Admins can touch state.json
  //    (ownerships + countries) and every per-nation force file.
  //
  //    When the client sends a `baseline` (what they last saw on main),
  //    we do per-nation 3-way merge: apply (snapshot - baseline) to
  //    current main. This makes concurrent edits in the same nation
  //    file no-ops for unchanged forces — exactly the rollback failure
  //    mode the v6 schema couldn't dodge. Older cached clients that
  //    don't send a baseline fall back to blind commit (v7 behavior).
  //
  //    Nothing is written here — changes accumulate into `changes` and
  //    land as one tree + one commit in step 4.
  const incomingByNation = groupForcesByNation(snapshot.forces);
  const baselineByNation = baseline ? groupForcesByNation(baseline.forces) : null;
  const FORCES_PREFIX = 'public/data/forces/';

  /** Decide what (if anything) to write for one nation's force file.
   *  Blob shas answer "identical?" locally; main's content is only
   *  fetched for a true concurrent-edit rebase (baseline present, main
   *  moved since the client loaded, and the submitter touched this
   *  nation). The rebase falls back to incoming-as-is when baseline is
   *  absent or has no entry for this nation. */
  async function planNation(nation: string): Promise<void> {
    const path = `${FORCES_PREFIX}${nation}.json`;
    const incoming = incomingByNation.get(nation) ?? [];
    const mainSha = mainTree.get(path) ?? null;
    const incomingJson =
      incoming.length > 0 ? JSON.stringify(incoming, null, 2) + '\n' : '';

    if (!baselineByNation) {
      // Legacy / no-baseline path — preserve v7's blind-commit semantics.
      if (incoming.length === 0) {
        // Nation no longer has any forces — drop the file if it exists.
        if (mainSha) changes.push({ path, delete: true });
        return;
      }
      if (mainSha && (await gitBlobSha(incomingJson)) === mainSha) return; // identical
      changes.push({ path, content: incomingJson });
      return;
    }

    const baselineForces = baselineByNation.get(nation) ?? [];
    const baselineJson =
      baselineForces.length > 0 ? JSON.stringify(baselineForces, null, 2) + '\n' : '';
    const baselineSha = baselineForces.length > 0 ? await gitBlobSha(baselineJson) : null;

    let mainForces: ForceLike[];
    if (mainSha === baselineSha) {
      // Main hasn't moved since the client loaded — rebase against the
      // baseline we already hold instead of re-downloading it.
      mainForces = baselineForces;
    } else if (!mainSha) {
      mainForces = [];
    } else {
      mainForces = JSON.parse(
        await readBlob(env.GITHUB_REPO, mainSha, installToken),
      ) as ForceLike[];
    }
    const merged = rebaseForceFile(baselineForces, incoming, mainForces) as ForceLike[];

    if (merged.length === 0) {
      if (mainSha) changes.push({ path, delete: true });
      return;
    }
    const newJson = JSON.stringify(merged, null, 2) + '\n';
    if (mainSha && (await gitBlobSha(newJson)) === mainSha) return; // no-op after rebase
    changes.push({ path, content: newJson });
  }

  try {
    // Read mainState AND mainTurn in parallel via their tree blobs —
    // state.json carries appVersion/ownerships/countries; turn.json
    // carries the time fields. Splitting them by file means an admin
    // advancing the turn doesn't create merge contention with concurrent
    // state-only edits. Reading by blob sha (from the step-1 listing)
    // keeps every read consistent with the same main snapshot.
    const stateSha = mainTree.get('public/data/state.json');
    const turnSha = mainTree.get('public/data/turn.json');
    if (!stateSha) {
      return errorJson(origin, 502, 'state.json missing on main — repo is broken');
    }
    if (!turnSha) {
      return errorJson(origin, 502, 'turn.json missing on main — repo is broken');
    }
    const [stateContent, turnContent] = await Promise.all([
      readBlob(env.GITHUB_REPO, stateSha, installToken),
      readBlob(env.GITHUB_REPO, turnSha, installToken),
    ]);
    const mainState = JSON.parse(stateContent) as {
      appVersion: string;
      ownerships: Array<[number, string]>;
      countries: Array<{ name: string; color: string }>;
    };
    const mainTurn = JSON.parse(turnContent) as {
      appVersion: string;
      currentDate: string;
      lastTurnDays: number;
      turnNumber: number;
    };

    // ── Turn-field permission / drift gate ─────────────────────────────
    // Players can't change currentDate / lastTurnDays / turnNumber. Admins
    // can — but only if their baseline matches main (so a concurrent admin
    // advance hasn't already landed since they started editing). Both
    // checks collapse to the same rule: the values the client is operating
    // against must match what's on main right now.
    const probe = isAdmin && baseline ? baseline : snapshot;
    const probeCurrentDate = (probe as { currentDate?: unknown }).currentDate;
    const probeLastTurnDays = (probe as { lastTurnDays?: unknown }).lastTurnDays;
    const probeTurnNumber = (probe as { turnNumber?: unknown }).turnNumber;
    if (
      probeCurrentDate !== mainTurn.currentDate ||
      probeLastTurnDays !== mainTurn.lastTurnDays ||
      probeTurnNumber !== mainTurn.turnNumber
    ) {
      return errorJson(
        origin,
        409,
        isAdmin
          ? 'main moved while you were editing: the turn was advanced. Refresh the page and re-apply any turn change.'
          : 'turn fields (currentDate / lastTurnDays / turnNumber) cannot be changed by players — refresh the page.',
      );
    }

    // ── Per-force movement budget (universal) ──────────────────────────
    // Budget basis: admin uses snapshot.lastTurnDays (they may be
    // advancing the turn in this same PR); everyone else uses main's
    // value, since the gate above already proved snapshot == main for
    // non-admins.
    const effectiveLastTurnDays = isAdmin
      ? (snapshot.lastTurnDays as number)
      : mainTurn.lastTurnDays;
    // For "newly raised this turn" purposes we use main's turnNumber.
    // The permission gate above already proved snapshot/baseline matches
    // main, and an admin advancing turn in this same PR has snapshot ==
    // baseline pre-advance, so this is the right reference frame either way.
    const effectiveTurnNumber = mainTurn.turnNumber;
    for (const f of snapshot.forces!) {
      const turnStartLon = (f as { turnStartLon?: unknown }).turnStartLon;
      const turnStartLat = (f as { turnStartLat?: unknown }).turnStartLat;
      const kmMovedThisTurn = (f as { kmMovedThisTurn?: unknown }).kmMovedThisTurn;
      const createdAtTurn = (f as { createdAtTurn?: unknown }).createdAtTurn;
      const branch = (f as { branch?: unknown }).branch;
      const lat = (f as { lat?: unknown }).lat;
      const lon = (f as { lon?: unknown }).lon;
      if (
        typeof turnStartLon !== 'number' ||
        typeof turnStartLat !== 'number' ||
        typeof kmMovedThisTurn !== 'number' ||
        typeof lat !== 'number' ||
        typeof lon !== 'number' ||
        (branch !== 'army' && branch !== 'navy')
      ) {
        return errorJson(
          origin,
          400,
          `force ${String(f.id)} is missing turn-tracking fields. Hard-refresh the page.`,
        );
      }
      // Newly raised forces (createdAtTurn === current turnNumber) are
      // locked from movement until the next turn. createdAtTurn is
      // optional for back-compat with seed forces, which are primordial
      // (always movable). Stale clients omitting the field would let
      // their new forces move freely — acceptable transient until refresh.
      const justRaised =
        typeof createdAtTurn === 'number' && createdAtTurn === effectiveTurnNumber;
      if (justRaised && kmMovedThisTurn > MOVEMENT_TOLERANCE_KM) {
        return errorJson(
          origin,
          422,
          `force ${f.id} was raised this turn and cannot move until the next turn`,
        );
      }
      const budget = justRaised ? 0 : budgetForBranch(branch, effectiveLastTurnDays);
      if (kmMovedThisTurn > budget + MOVEMENT_TOLERANCE_KM) {
        return errorJson(
          origin,
          422,
          `force ${f.id} (${branch}) exceeded movement budget: ${Math.round(kmMovedThisTurn)} km moved, budget is ${budget} km this turn`,
        );
      }
      const displacement = haversineKm(turnStartLat, turnStartLon, lat, lon);
      if (displacement > kmMovedThisTurn + MOVEMENT_TOLERANCE_KM) {
        return errorJson(
          origin,
          422,
          `force ${f.id} displacement (${Math.round(displacement)} km) exceeds reported movement (${Math.round(kmMovedThisTurn)} km) — refresh the page`,
        );
      }
    }

    if (!isAdmin) {
      if (!entry.nation) {
        return errorJson(origin, 403, `@${login} has no nation assigned in perm.json`);
      }
      await planNation(normalizeNation(entry.nation));
    } else {
      // Admin: state.json + every force file that differs. We need the
      // union of (nations that already have a force file on main) and
      // (nations with forces in the incoming snapshot) so deletions
      // (e.g. a country rename's old name) are caught too.
      // Stale-baseline gate for state.json fields. Per the design call,
      // admin must operate against fresh main for ownerships / countries —
      // a 3-way merge of these arrays is ambiguous (e.g. an ownership
      // pair flip is indistinguishable from a stale value), so we reject
      // and force the admin to refresh + redo when concurrent edits
      // landed for those fields. Pure force edits are still rebased.
      if (baseline) {
        const baselineOwnershipsJson = JSON.stringify(baseline.ownerships);
        const mainOwnershipsJson = JSON.stringify(mainState.ownerships);
        if (baselineOwnershipsJson !== mainOwnershipsJson) {
          return errorJson(
            origin,
            409,
            'main moved while you were editing: province ownerships changed. Refresh the page and redo any ownership edits.',
          );
        }
        const baselineCountriesJson = JSON.stringify(baseline.countries);
        const mainCountriesJson = JSON.stringify(mainState.countries);
        if (baselineCountriesJson !== mainCountriesJson) {
          return errorJson(
            origin,
            409,
            'main moved while you were editing: country list changed. Refresh the page and redo any country edits.',
          );
        }
      }

      const newStateJson =
        JSON.stringify(
          {
            appVersion: snapshot.appVersion,
            ownerships: snapshot.ownerships,
            countries: snapshot.countries,
          },
          null,
          2,
        ) + '\n';
      if (newStateJson !== stateContent) {
        changes.push({ path: 'public/data/state.json', content: newStateJson });
      }

      const newTurnJson =
        JSON.stringify(
          {
            appVersion: snapshot.appVersion,
            currentDate: snapshot.currentDate,
            lastTurnDays: snapshot.lastTurnDays,
            turnNumber: snapshot.turnNumber,
          },
          null,
          2,
        ) + '\n';
      if (newTurnJson !== turnContent) {
        changes.push({ path: 'public/data/turn.json', content: newTurnJson });
      }

      // Union of (nations that already have a force file on main) and
      // (nations with forces in the incoming snapshot) so deletions
      // (e.g. a country rename's old name) are caught too. The step-1
      // tree listing already names every existing file — no directory
      // listing call needed.
      const existingNations = [...mainTree.keys()]
        .filter((p) => p.startsWith(FORCES_PREFIX) && p.endsWith('.json'))
        .map((p) => p.slice(FORCES_PREFIX.length, -'.json'.length));

      const allNations = new Set([...existingNations, ...incomingByNation.keys()]);
      for (const nation of allNations) {
        await planNation(nation);
      }
    }
  } catch (e) {
    const msg = (e as Error).message;
    return errorJson(origin, e instanceof HttpError ? e.status : 502, `commit: ${msg}`);
  }

  if (changes.length === 0) {
    return errorJson(origin, 400, 'no changes to submit — everything already matches main');
  }

  // 4. Apply the plan: one tree, one commit, one branch ref. Fixed cost
  //    regardless of how many files changed.
  const permSummary = summaryParts(renames, userAdds, userRemoves);
  const commitMessage =
    `move: @${login} ${ts}` +
    (permSummary ? ` (${permSummary})` : '') +
    '\n\n' +
    changes.map((c) => `${'delete' in c ? '-' : '+'} ${c.path}`).join('\n');
  try {
    const tree = await gh<{ sha: string }>(
      `/repos/${env.GITHUB_REPO}/git/trees`,
      {
        method: 'POST',
        body: {
          base_tree: baseSha,
          tree: changes.map((c) =>
            'delete' in c
              ? { path: c.path, mode: '100644', type: 'blob', sha: null }
              : { path: c.path, mode: '100644', type: 'blob', content: c.content },
          ),
        },
      },
      installToken,
    );
    const commit = await gh<{ sha: string }>(
      `/repos/${env.GITHUB_REPO}/git/commits`,
      {
        method: 'POST',
        body: { message: commitMessage, tree: tree.sha, parents: [baseSha] },
      },
      installToken,
    );
    await gh<unknown>(
      `/repos/${env.GITHUB_REPO}/git/refs`,
      { method: 'POST', body: { ref: `refs/heads/${branchName}`, sha: commit.sha } },
      installToken,
    );
  } catch (e) {
    const msg = (e as Error).message;
    return errorJson(origin, e instanceof HttpError ? e.status : 502, `commit: ${msg}`);
  }

  // 5. Open the PR — body carries the verified submitter marker.
  const description = (body.description ?? '').trim();
  const prBody =
    (description ? `${description}\n\n` : '') +
    `Submitted by @${login} via the app. The auto-merge workflow will validate.\n\n` +
    `${SUBMITTER_MARKER_PREFIX} ${login} -->`;
  try {
    const pr = await gh<{ number: number; html_url: string }>(
      `/repos/${env.GITHUB_REPO}/pulls`,
      {
        method: 'POST',
        body: { title: `Move from @${login}`, body: prBody, head: branchName, base: 'main' },
      },
      installToken,
    );
    return jsonResponse(
      JSON.stringify({ prNumber: pr.number, prUrl: pr.html_url }),
      200,
      origin,
    );
  } catch (e) {
    return errorJson(origin, 502, `open PR: ${(e as Error).message}`);
  }
}

// ────────────────────────────────────────────────────────────────────
// Top-level dispatcher
// ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Legacy GET /?code=... — keep working for old client bundles.
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const code = url.searchParams.get('code');
      if (!code) return errorJson(origin, 400, 'missing code');
      return exchangeWithGitHub(env, { code }, origin);
    }

    if (request.method !== 'POST') {
      return errorJson(origin, 405, 'method not allowed');
    }

    // /submit lives at a path so OAuth flows aren't disturbed by a body
    // shape mismatch. Everything else is content-routed by JSON keys.
    const url = new URL(request.url);
    if (url.pathname === '/submit') {
      return handleSubmit(request, env, origin);
    }

    let body: { code?: string; refresh_token?: string; revoke?: string };
    try {
      body = (await request.json()) as {
        code?: string;
        refresh_token?: string;
        revoke?: string;
      };
    } catch {
      return errorJson(origin, 400, 'invalid json body');
    }

    if (body.code) return exchangeWithGitHub(env, { code: body.code }, origin);
    if (body.refresh_token) {
      return exchangeWithGitHub(
        env,
        { grant_type: 'refresh_token', refresh_token: body.refresh_token },
        origin,
      );
    }
    if (body.revoke) return revokeWithGitHub(env, body.revoke, origin);

    return errorJson(origin, 400, 'missing code, refresh_token, or revoke');
  },
};

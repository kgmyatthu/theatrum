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
  checkAnchorConservation,
  checkMoveLock,
  checkRaiseBudgets,
  haversineKm,
  MOVEMENT_TOLERANCE_KM,
} from '../../scripts/lib/movement.mjs';
import { resolvePopulation } from '../../scripts/lib/population.mjs';

const UA = 'theatrum-oauth-worker';
const SUBMITTER_MARKER_PREFIX = '<!-- theatrum-submitter:';
// Keep in sync with src/utils/schema.ts and scripts/lib/validate-move-core.mjs.
const SCHEMA_VERSION = 'theatrum/v10';

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
// Per-file commit helpers
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

// Subrequest budget, not elegance, is why these two exist. A Worker
// invocation gets 50 outbound fetches; the per-file Contents API path this
// replaced spent two per nation (GET ?ref=main, then PUT) and blew the cap
// outright on an admin turn advance, which rewrites every force file in the
// game — "Too many subrequests by single Worker invocation", with the PR
// half-written. One GraphQL query reads the whole data directory and one
// tree+commit+ref writes it, so the cost is now flat in the nation count.

interface RepoSnapshot {
  /** commit main points at — the parent of what we're about to write */
  baseSha: string;
  /** its tree, the base_tree every write layers onto */
  baseTreeSha: string;
  perm: string | null;
  state: string | null;
  turn: string | null;
  /** nation → forces/<nation>.json text, for every file that exists */
  forces: Map<string, string>;
}

interface GraphQLBlob {
  text?: string | null;
  isTruncated?: boolean;
}

async function readRepo(repo: string, token: string): Promise<RepoSnapshot> {
  const [owner, name] = repo.split('/');
  const query = `query($owner:String!,$name:String!){
    repository(owner:$owner,name:$name){
      ref(qualifiedName:"refs/heads/main"){ target{ ...on Commit{ oid tree{ oid } } } }
      perm:  object(expression:"main:public/data/perm.json"){  ...on Blob{ text isTruncated } }
      state: object(expression:"main:public/data/state.json"){ ...on Blob{ text isTruncated } }
      turn:  object(expression:"main:public/data/turn.json"){  ...on Blob{ text isTruncated } }
      forces:object(expression:"main:public/data/forces"){
        ...on Tree{ entries{ name object{ ...on Blob{ text isTruncated } } } }
      }
    }
  }`;
  // GraphQL answers 200 with an `errors` array, so gh()'s status check
  // can't see a failure here — check it before trusting `data`.
  const r = await gh<{
    errors?: Array<{ message: string }>;
    data?: {
      repository: {
        ref: { target: { oid: string; tree: { oid: string } } } | null;
        perm: GraphQLBlob | null;
        state: GraphQLBlob | null;
        turn: GraphQLBlob | null;
        forces: { entries?: Array<{ name: string; object: GraphQLBlob | null }> } | null;
      } | null;
    };
  }>('/graphql', { method: 'POST', body: { query, variables: { owner, name } } }, token);
  if (r.errors?.length) throw new HttpError(502, `graphql: ${r.errors[0].message}`);
  const repository = r.data?.repository;
  if (!repository?.ref) throw new HttpError(502, 'graphql: no refs/heads/main');

  /** A blob we can't read whole is not an empty blob. Returning null for a
   *  truncated file would hand the callers below an empty force list and
   *  commit the deletion of every army in it. */
  const textOf = (blob: GraphQLBlob | null | undefined, path: string): string | null => {
    if (!blob) return null;
    if (blob.isTruncated) throw new HttpError(502, `${path} is too large to read via GraphQL`);
    return blob.text ?? null;
  };

  const forces = new Map<string, string>();
  for (const e of repository.forces?.entries ?? []) {
    if (!e.name.endsWith('.json')) continue;
    const text = textOf(e.object, `forces/${e.name}`);
    if (text !== null) forces.set(e.name.slice(0, -'.json'.length), text);
  }
  return {
    baseSha: repository.ref.target.oid,
    baseTreeSha: repository.ref.target.tree.oid,
    perm: textOf(repository.perm, 'perm.json'),
    state: textOf(repository.state, 'state.json'),
    turn: textOf(repository.turn, 'turn.json'),
    forces,
  };
}

/** `content: null` deletes the path. */
interface FileWrite {
  path: string;
  content: string | null;
}

/** Every file in one commit, so a rejected submission can't leave a branch
 *  carrying half a move — the ref only appears once all of it is written. */
async function commitAll(
  repo: string,
  snap: RepoSnapshot,
  branch: string,
  message: string,
  writes: FileWrite[],
  token: string,
): Promise<void> {
  const tree = await gh<{ sha: string }>(
    `/repos/${repo}/git/trees`,
    {
      method: 'POST',
      body: {
        base_tree: snap.baseTreeSha,
        tree: writes.map((w) => ({
          path: w.path,
          mode: '100644',
          type: 'blob',
          ...(w.content === null ? { sha: null } : { content: w.content }),
        })),
      },
    },
    token,
  );
  const commit = await gh<{ sha: string }>(
    `/repos/${repo}/git/commits`,
    { method: 'POST', body: { message, tree: tree.sha, parents: [snap.baseSha] } },
    token,
  );
  await gh<unknown>(
    `/repos/${repo}/git/refs`,
    { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } },
    token,
  );
}

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
        // Legacy clients may omit this. resolvePopulation below allows
        // inheritance only while ownership, country identities and the
        // clock are unchanged; world replacements must carry their anchor.
        populationByNation?: unknown;
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

  // One read for the whole data directory: main's head, perm.json,
  // state.json, turn.json and every per-nation force file. perm.json is read
  // here to determine the submitter's role — the validator does the same in
  // CI, but we mirror it so we can fail fast and so non-admins can never
  // bundle perm.json edits.
  let repo: RepoSnapshot;
  let perms: PermFile;
  try {
    repo = await readRepo(env.GITHUB_REPO, installToken);
    if (repo.perm === null) throw new Error('perm.json missing on main');
    perms = JSON.parse(repo.perm) as PermFile;
  } catch (e) {
    return errorJson(origin, 502, `couldn't read repo: ${(e as Error).message}`);
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

  // 1. Work out the file content to commit. The on-disk layout is:
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
  const incomingByNation = groupForcesByNation(snapshot.forces);
  const baselineByNation = baseline ? groupForcesByNation(baseline.forces) : null;

  /** What this submission would leave in one nation's file, plus what is
   *  in there right now. Computed for every nation we intend to write
   *  BEFORE anything is committed, because the recruitment gates are
   *  per-nation SUMS and a sum is only meaningful over the array that
   *  actually lands on main. The old code summed the raw snapshot, which
   *  is scored against a client-supplied `baseline`: sending
   *  `baseline: []` next to one at-cap force passed the worker every
   *  time while CI — which diffs the PR against main — rejected it. The
   *  per-force checks were rebase-invariant, so the split only starts to
   *  matter now. */
  interface NationPlan {
    path: string;
    /** forces/<nation>.json as it stands on main, or null if absent. */
    mainJson: string | null;
    /** the same file parsed: the base side of the anchor-conservation
     *  comparison. */
    mainForces: ForceLike[];
    /** post-rebase result: what the gates score and what we commit. */
    merged: ForceLike[];
  }

  function planNation(nation: string): NationPlan {
    const incoming = incomingByNation.get(nation) ?? [];
    const path = `public/data/forces/${nation}.json`;
    const mainJson = repo.forces.get(nation) ?? null;
    const mainForces = mainJson !== null ? (JSON.parse(mainJson) as ForceLike[]) : [];
    // Legacy / no-baseline clients keep v7's blind-commit semantics: with
    // nothing to diff against, their snapshot IS the merge result.
    const merged = baselineByNation
      ? (rebaseForceFile(
          baselineByNation.get(nation) ?? [],
          incoming,
          mainForces,
        ) as ForceLike[])
      : incoming;
    return { path, mainJson, mainForces, merged };
  }

  /** A plan as a file write, or null when the rebase made it a no-op. An
   *  emptied nation deletes its file rather than committing `[]`. */
  function planWrite(plan: NationPlan): FileWrite | null {
    const newJson = plan.merged.length > 0 ? JSON.stringify(plan.merged, null, 2) + '\n' : '';
    if (newJson === (plan.mainJson ?? '')) return null; // no-op after rebase
    return { path: plan.path, content: plan.merged.length > 0 ? newJson : null };
  }

  try {
    // state.json carries appVersion/ownerships/countries; turn.json carries
    // the time fields. Splitting them by file means an admin advancing the
    // turn doesn't create merge contention with concurrent state-only edits.
    if (repo.state === null) {
      return errorJson(origin, 502, 'state.json missing on main — repo is broken');
    }
    if (repo.turn === null) {
      return errorJson(origin, 502, 'turn.json missing on main — repo is broken');
    }
    const mainState = JSON.parse(repo.state) as {
      appVersion: string;
      ownerships: Array<[number, string]>;
      countries: Array<{ name: string; color: string }>;
    };
    const mainTurn = JSON.parse(repo.turn) as {
      appVersion: string;
      currentDate: string;
      lastTurnDays: number;
      turnNumber: number;
      // OPTIONAL, and that is the whole shape-tolerance story for the
      // population rules: any turn.json written before this feature has no
      // populationByNation at all. Typing it as required — or adding it to
      // the missing-field rejections above — would brick every submission
      // in the game until the next turn advance rewrote the file. Absent it
      // stays undefined and the recruitment gate reverts to the flat
      // pre-population cap, which is bit-for-bit today's behaviour.
      populationByNation?: Record<string, number>;
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
    // Turn-number basis: the same rule as the days above, and it has to
    // be, because the two are read together. For non-admins the gate above
    // proved snapshot == main, so they are interchangeable. The admin
    // advancing the turn in this same PR is the case that matters: that
    // gate compared their *baseline* to main, so their snapshot carries
    // the new turnNumber, turn.json on the branch gets that same number,
    // and the CI validator scores the PR against it (head.turn.turnNumber)
    // alongside the new lastTurnDays. Reading main's stale number here
    // would mix frames — last turn's recruits billed against the new
    // turn's cap — and bounce the admin's own turn advance for a PR the
    // validator would have passed. snapshot.turnNumber is already proven
    // to be a number by the body check near the top of this handler.
    const effectiveTurnNumber = isAdmin
      ? (snapshot.turnNumber as number)
      : mainTurn.turnNumber;
    // Population basis: resolved by the SAME resolvePopulation() CI runs,
    // so the two gates refuse and accept identical inputs. The table is a
    // turn-start anchor in turn.json, and the frame is picked the same way
    // as the two fields above:
    //   - Non-admin: main's state + turn against itself. Players cannot
    //     write turn.json, so nothing they send can influence the anchor;
    //     this only validates what main already holds (and keeps an absent
    //     legacy table undefined).
    //   - Admin: main as base, their snapshot's world and clock (plus any
    //     table they sent) as head. An admin advancing the turn is writing a
    //     new table, so the gate scores the frame that will land. A table
    //     omitted across an ownership / registry / clock change over a main
    //     that has one is rejected rather than silently inherited — that is
    //     how a stale import used to carry an old world's anchor.
    // The value the cap is scored against is exactly what the turn.json
    // write below commits, so what lands is what was judged.
    //
    // ponytail: the table is admin-asserted, same as turnNumber and
    // lastTurnDays beside it — an admin who could forge it can already edit
    // the force files directly. Upgrade path (recompute from ownerships and
    // reject on mismatch) is written up on checkRaiseBudgets in
    // scripts/lib/movement.mjs.
    const mainWorld = { state: mainState, turn: mainTurn };
    const resolvedPopulation = resolvePopulation(
      mainWorld,
      isAdmin
        ? {
            state: { ownerships: snapshot.ownerships!, countries: snapshot.countries! },
            turn: {
              currentDate: snapshot.currentDate as string,
              lastTurnDays: snapshot.lastTurnDays as number,
              turnNumber: snapshot.turnNumber as number,
              populationByNation: snapshot.populationByNation,
            },
          }
        : mainWorld,
    );
    if (resolvedPopulation.error) {
      return errorJson(
        origin,
        isAdmin ? 422 : 502,
        isAdmin
          ? `population anchor rejected: ${resolvedPopulation.error}`
          : `population anchor on main is unusable: ${resolvedPopulation.error}`,
      );
    }
    const effectivePopulation = resolvedPopulation.populationByNation;
    for (const f of snapshot.forces!) {
      const turnStartLon = (f as { turnStartLon?: unknown }).turnStartLon;
      const turnStartLat = (f as { turnStartLat?: unknown }).turnStartLat;
      const kmMovedThisTurn = (f as { kmMovedThisTurn?: unknown }).kmMovedThisTurn;
      const createdAtTurn = (f as { createdAtTurn?: unknown }).createdAtTurn;
      const branch = (f as { branch?: unknown }).branch;
      const lat = (f as { lat?: unknown }).lat;
      const lon = (f as { lon?: unknown }).lon;
      const strength = (f as { strength?: unknown }).strength;
      const turnStartStrength = (f as { turnStartStrength?: unknown }).turnStartStrength;
      const turnStartBranch = (f as { turnStartBranch?: unknown }).turnStartBranch;
      // strength was never validated server-side until the recruitment cap
      // landed — this is the trust boundary that whole feature stands on.
      // Both strength fields are mandatory for the same reason the position
      // anchors are: the per-nation gate below subtracts them, and a missing
      // or NaN operand would silently price recruitment at zero (NaN fails
      // every `<= cap` comparison, so an over-cap raise would slip through).
      // Negative values are rejected too — claiming a debt would otherwise
      // bank free headroom for the rest of the nation's forces.
      // turnStartBranch is mandatory on the same grounds: raiseCost reads
      // it to decide whether the anchor was earned in the branch the force
      // is billed against, and a missing one makes every force look
      // re-branded (undefined !== 'army') — which would bill the entire
      // standing order of battle against this turn's cap.
      if (
        typeof turnStartLon !== 'number' ||
        typeof turnStartLat !== 'number' ||
        typeof kmMovedThisTurn !== 'number' ||
        typeof lat !== 'number' ||
        typeof lon !== 'number' ||
        !Number.isFinite(strength) ||
        (strength as number) < 0 ||
        !Number.isFinite(turnStartStrength) ||
        (turnStartStrength as number) < 0 ||
        (turnStartBranch !== 'army' && turnStartBranch !== 'navy') ||
        (branch !== 'army' && branch !== 'navy')
      ) {
        return errorJson(
          origin,
          400,
          `force ${String(f.id)} is missing turn-tracking fields (turnStartLon, turnStartLat, kmMovedThisTurn, strength, turnStartStrength, turnStartBranch). Hard-refresh the page.`,
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

    // Stale-baseline gate for state.json fields. Per the design call,
    // admin must operate against fresh main for ownerships / countries —
    // a 3-way merge of these arrays is ambiguous (e.g. an ownership
    // pair flip is indistinguishable from a stale value), so we reject
    // and force the admin to refresh + redo when concurrent edits
    // landed for those fields. Pure force edits are still rebased.
    // Checked here, ahead of the per-nation reads below, so a submission
    // that is doomed anyway doesn't spend a file read per nation first.
    if (isAdmin && baseline) {
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

    // ── What this submission would write ───────────────────────────────
    // The exact set of nation files we are about to touch: a player's own
    // nation, or for an admin the union of (nations that already have a
    // force file on main) and (nations with forces in the incoming
    // snapshot) so deletions (e.g. a country rename's old name) are
    // caught too. Resolved and merged here rather than at commit time
    // because the gates below have to score the post-rebase arrays, and
    // they have to do it before a single byte is written.
    // The admin union is load-bearing twice over: it is also the base
    // index for anchor conservation, which pairs forces BY ID across
    // nation files. Narrowing it to "only the files we rewrite" would
    // save reads and silently reject every rename — see the gate below.
    let targetNations: string[];
    if (!isAdmin) {
      if (!entry.nation) {
        return errorJson(origin, 403, `@${login} has no nation assigned in perm.json`);
      }
      targetNations = [normalizeNation(entry.nation)];
    } else {
      // Existing nation files come free with the repo read — an absent
      // forces/ directory (first ever bake) is simply an empty map.
      targetNations = [...new Set([...repo.forces.keys(), ...incomingByNation.keys()])];
    }
    const plans = new Map<string, NationPlan>();
    const mergedByNation: Record<string, ForceLike[]> = {};
    const mainByNation: Record<string, ForceLike[]> = {};
    for (const nation of targetNations) {
      const plan = planNation(nation);
      plans.set(nation, plan);
      mergedByNation[nation] = plan.merged;
      mainByNation[nation] = plan.mainForces;
    }

    // ── Per-nation recruitment budget (universal) ──────────────────────
    // Unlike the movement checks this is a nation-level sum, so it runs
    // once over the whole record instead of per force: a partial view
    // would under-count a nation's spend and let a second force sneak the
    // overage through. It must run *after* the loop above, which is what
    // proves strength / turnStartStrength / turnStartBranch are real on
    // the forces the client sent — the checker does arithmetic on them
    // without re-validating. The rest of `merged` comes from main, where
    // this same gate (or the backfill) already vetted it.
    // Scored over the MERGED record, which is both what lands on main and
    // what CI re-scores from the base checkout. No counter is stored, so
    // the cap is cumulative across however many PRs a nation lands inside
    // one turn: main's forces are already in the sum, and each new PR
    // only adds its own growth on top. Only the nations we write are
    // scored — deliberately, so one nation sitting over cap on main can't
    // bounce every other nation's moves. Same reference frame as the
    // movement budget (effectiveLastTurnDays), and now the same frame for
    // population too: the third argument turns the flat monthly cap into a
    // population-derived one and adds the standing-army ceiling. Passing
    // undefined (no table on main, or an admin whose client sent none over
    // a main that has none either) is not a special case at the call site —
    // it is the pre-population behaviour, unchanged.
    const overBudget = checkRaiseBudgets(
      mergedByNation,
      effectiveLastTurnDays,
      effectivePopulation,
    );
    if (overBudget) {
      // Already a finished sentence naming the nation and the branch —
      // no force id or file path to prefix, since the violation is a sum.
      return errorJson(origin, 422, overBudget);
    }

    // ── Anchor conservation ────────────────────────────────────────────
    // The cap above is only as honest as turnStartStrength, which the
    // client asserts. This is what makes that assertion safe: every head
    // force is paired to its base self BY ID, and a nation's per-branch
    // anchor total may not exceed what exactly those forces were anchored
    // at on main. A force main never saw funds none of it, so a fabricated
    // anchor — invented to zero out a force's growth, or smuggled in with
    // a force lifted from another nation's file — has nowhere to come
    // from. (A nation's raw anchor sum is free to RISE, which is the whole
    // point of pairing: a rename fills a file that had no anchors at all.)
    // Skipped when the turn is
    // being advanced (admin-only, and the gate above already proved they
    // were operating against fresh main): the anchors legitimately reset
    // up to current strengths at a turn boundary. Same exception the CI
    // validator makes, for the same reason.
    // Base scope is the subtle half: the pairing is by id ALONE, so a
    // RENAME_COUNTRY — which rewrites force.nation and carries whole ids
    // from forces/spain.json into forces/hispania.json — passes only
    // while base still holds spain's copy. It does: the forces/ listing
    // puts the old name into targetNations and the snapshot puts the new
    // one there, so an admin's mainByNation spans every force file on
    // main. A player's stays scoped to their own nation on purpose — the
    // only ids their merge can name are main's copy of that same file
    // plus their own snapshot, so an id living in someone else's file is
    // a theft, and this 0 allowance is the only thing here that catches
    // it (the duplicate-id check lives in the CI validator, not here).
    if (effectiveTurnNumber === mainTurn.turnNumber) {
      const inflated = checkAnchorConservation(mainByNation, mergedByNation);
      if (inflated) {
        return errorJson(origin, 422, inflated);
      }
      // One move per force per turn, scored over the same merged-vs-main
      // pair and sharing this branch's turn-advance exception: an advance
      // legitimately resets every odometer to 0, which the gate would read
      // as a march being laundered away. It has to live down here rather
      // than in the per-force loop above — that loop only sees the incoming
      // snapshot, and this rule is a comparison against main.
      const relocked = checkMoveLock(mainByNation, mergedByNation);
      if (relocked) {
        return errorJson(origin, 422, relocked);
      }
    }

    // ── Everything below this line is the write set ────────────────────
    // Collected, not committed: the branch is created from a single commit
    // at the very end, so a rejection anywhere above leaves no ref at all
    // — no stranded branch, and no half-written move if a later write
    // fails. (The old per-file path could do both.)
    const writes: FileWrite[] = [];
    const changed: string[] = [];

    // perm.json — admin only, and only when the rewrite is an effective
    // change. `perms` is main's copy, from the same read the role check used.
    if (renames.length > 0 || userAdds.length > 0 || userRemoves.length > 0) {
      const permAfter = rewritePerm(perms, renames, userAdds, userRemoves);
      if (JSON.stringify(perms) !== JSON.stringify(permAfter)) {
        writes.push({
          path: 'public/data/perm.json',
          content: JSON.stringify(permAfter, null, 2) + '\n',
        });
        changed.push(`perm (${summaryParts(renames, userAdds, userRemoves)})`);
      }
    }

    if (isAdmin) {
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
      if (newStateJson !== repo.state) {
        writes.push({ path: 'public/data/state.json', content: newStateJson });
        changed.push('state');
      }

      // turn.json stays its own file so a turn-advance doesn't churn the
      // (much larger) state.json blob; merge contention drops as a result.
      // Skipped when nothing changed.
      const newTurnJson =
        JSON.stringify(
          {
            appVersion: snapshot.appVersion,
            currentDate: snapshot.currentDate,
            lastTurnDays: snapshot.lastTurnDays,
            turnNumber: snapshot.turnNumber,
            // Carried, not asserted — the only turn field this rewrite does
            // not simply take from the snapshot. This block reconstructs
            // turn.json from scratch, so omitting the population table would
            // DELETE it: every admin submission that touches anything at all
            // would strip the anchor both gates read, and the feature would
            // die at the first ownership edit after a bake. effectivePopulation
            // is main's copy unless the admin's client sent a fresher one,
            // which is also precisely what the gate above scored — so what
            // lands is what was judged. JSON.stringify drops an undefined
            // value entirely, so a turn.json with no population table still
            // round-trips byte-identical and the !== check below still
            // short-circuits the write.
            populationByNation: effectivePopulation,
          },
          null,
          2,
        ) + '\n';
      if (newTurnJson !== repo.turn) {
        writes.push({ path: 'public/data/turn.json', content: newTurnJson });
        changed.push(`turn → ${String(snapshot.currentDate)} (${String(snapshot.lastTurnDays)} days)`);
      }
    }

    // Force files, straight from the plans the gates scored — one nation
    // for a player, every nation on main for an admin. Unchanged files
    // short-circuit inside planWrite.
    for (const [nation, plan] of plans) {
      const write = planWrite(plan);
      if (!write) continue;
      writes.push(write);
      changed.push(write.content === null ? `clear ${nation}` : nation);
    }

    if (writes.length === 0) {
      // An empty tree would still commit (and GitHub would refuse the PR
      // for having no diff) — say what actually happened instead.
      return errorJson(origin, 409, 'nothing to submit: your changes are already on main');
    }

    const summary = changed.length > 4 ? `${changed.slice(0, 3).join(', ')} +${changed.length - 3} more` : changed.join(', ');
    await commitAll(
      env.GITHUB_REPO,
      repo,
      branchName,
      `move: @${login} ${summary} ${ts}`,
      writes,
      installToken,
    );
  } catch (e) {
    const msg = (e as Error).message;
    return errorJson(origin, e instanceof HttpError ? e.status : 502, `commit: ${msg}`);
  }

  // 3. Open the PR — body carries the verified submitter marker.
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

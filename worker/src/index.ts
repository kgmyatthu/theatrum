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

const UA = 'theatrum-oauth-worker';
const SUBMITTER_MARKER_PREFIX = '<!-- theatrum-submitter:';
// Keep in sync with src/utils/schema.ts and scripts/lib/validate-move-core.mjs.
const SCHEMA_VERSION = 'theatrum/v7';

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

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
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

/** Per-segment URL-encode a repo path so file names with spaces survive. */
function encodeRepoPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

type MainFile =
  | { exists: true; sha: string; content: string }
  | { exists: false };

async function readFileOnMain(
  repo: string,
  path: string,
  token: string,
): Promise<MainFile> {
  try {
    const f = await gh<{ sha: string; content: string }>(
      `/repos/${repo}/contents/${encodeRepoPath(path)}?ref=main`,
      { method: 'GET' },
      token,
    );
    return { exists: true, sha: f.sha, content: base64ToUtf8(f.content) };
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return { exists: false };
    throw e;
  }
}

async function commitFile(
  repo: string,
  path: string,
  branch: string,
  content: string,
  message: string,
  token: string,
  existingSha: string | undefined,
): Promise<void> {
  await gh<unknown>(
    `/repos/${repo}/contents/${encodeRepoPath(path)}`,
    {
      method: 'PUT',
      body: {
        message,
        content: utf8ToBase64(content),
        branch,
        ...(existingSha ? { sha: existingSha } : {}),
      },
    },
    token,
  );
}

async function deleteFile(
  repo: string,
  path: string,
  branch: string,
  sha: string,
  message: string,
  token: string,
): Promise<void> {
  await gh<unknown>(
    `/repos/${repo}/contents/${encodeRepoPath(path)}`,
    {
      method: 'DELETE',
      body: { message, sha, branch },
    },
    token,
  );
}

/**
 * Apply an incoming forces array for one nation against main's
 * forces/<nation>.json. Creates / updates / deletes the file as needed
 * and returns whether a commit was made. Empty incoming + existing file
 * → delete; empty incoming + no file → no-op (the common case).
 */
async function syncNationForces(
  repo: string,
  branch: string,
  nation: string,
  incomingForces: ForceLike[],
  login: string,
  ts: string,
  token: string,
): Promise<boolean> {
  const path = `public/data/forces/${nation}.json`;
  const onMain = await readFileOnMain(repo, path, token);

  const incomingJson = JSON.stringify(incomingForces, null, 2) + '\n';
  const mainJson = onMain.exists ? onMain.content : '';

  if (incomingJson === mainJson) return false; // identical
  if (incomingForces.length === 0) {
    // Nation no longer has any forces — drop the file if it exists.
    if (!onMain.exists) return false;
    await deleteFile(
      repo,
      path,
      branch,
      onMain.sha,
      `forces: @${login} clear ${nation} ${ts}`,
      token,
    );
    return true;
  }
  await commitFile(
    repo,
    path,
    branch,
    incomingJson,
    `move: @${login} ${nation} ${ts}`,
    token,
    onMain.exists ? onMain.sha : undefined,
  );
  return true;
}

// ────────────────────────────────────────────────────────────────────
// Submit handler
// ────────────────────────────────────────────────────────────────────

interface SubmitBody {
  snapshot?: unknown;
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

  let installToken: string;
  try {
    installToken = await getInstallToken(env);
  } catch (e) {
    return errorJson(origin, 502, (e as Error).message);
  }

  // Read perm.json with the install token to determine the submitter's role.
  // The validator does the same thing in CI, but we mirror it here so we can
  // fail fast and so non-admins can never bundle perm.json edits.
  let perms: PermFile;
  try {
    const f = await gh<{ content: string }>(
      `/repos/${env.GITHUB_REPO}/contents/public/data/perm.json?ref=main`,
      { method: 'GET' },
      installToken,
    );
    perms = JSON.parse(base64ToUtf8(f.content)) as PermFile;
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

  // 1. Get main HEAD SHA, create branch.
  let baseSha: string;
  try {
    const ref = await gh<{ object: { sha: string } }>(
      `/repos/${env.GITHUB_REPO}/git/ref/heads/main`,
      { method: 'GET' },
      installToken,
    );
    baseSha = ref.object.sha;
    await gh<unknown>(
      `/repos/${env.GITHUB_REPO}/git/refs`,
      { method: 'POST', body: { ref: `refs/heads/${branchName}`, sha: baseSha } },
      installToken,
    );
  } catch (e) {
    const msg = (e as Error).message;
    return errorJson(origin, e instanceof HttpError ? e.status : 502, msg);
  }

  // 2. perm.json (admin only, when there's an effective change).
  if (renames.length > 0 || userAdds.length > 0 || userRemoves.length > 0) {
    try {
      const permFile = await gh<{ sha: string; content: string }>(
        `/repos/${env.GITHUB_REPO}/contents/public/data/perm.json?ref=main`,
        { method: 'GET' },
        installToken,
      );
      const permBefore = JSON.parse(base64ToUtf8(permFile.content)) as PermFile;
      const permAfter = rewritePerm(permBefore, renames, userAdds, userRemoves);
      if (JSON.stringify(permBefore) !== JSON.stringify(permAfter)) {
        const json = JSON.stringify(permAfter, null, 2) + '\n';
        await gh<unknown>(
          `/repos/${env.GITHUB_REPO}/contents/public/data/perm.json`,
          {
            method: 'PUT',
            body: {
              message: `perm: ${summaryParts(renames, userAdds, userRemoves)}`,
              content: utf8ToBase64(json),
              sha: permFile.sha,
              branch: branchName,
            },
          },
          installToken,
        );
      }
    } catch (e) {
      return errorJson(origin, 502, `perm.json commit: ${(e as Error).message}`);
    }
  }

  // 3. Commit per-file content. The on-disk layout is:
  //      public/data/state.json            — { appVersion, ownerships, countries }
  //      public/data/forces/<nation>.json  — Force[]
  //    Non-admin players only touch their own nation's force file; the
  //    validator enforces the same rule. Admins can touch state.json
  //    (ownerships + countries) and every per-nation force file.
  //
  //    The incoming `snapshot` is the unified in-memory view (flat forces
  //    array). We decompose it server-side and only commit files whose
  //    bytes actually changed against main — this keeps PRs minimal and
  //    sidesteps the "stale baseline rolls back another player's work"
  //    failure mode that caused the v6 rejections.
  const incomingByNation = groupForcesByNation(snapshot.forces);
  try {
    if (!isAdmin) {
      if (!entry.nation) {
        return errorJson(origin, 403, `@${login} has no nation assigned in perm.json`);
      }
      const playerNation = normalizeNation(entry.nation);
      const playerForces = incomingByNation.get(playerNation) ?? [];
      await syncNationForces(
        env.GITHUB_REPO,
        branchName,
        playerNation,
        playerForces,
        login,
        ts,
        installToken,
      );
    } else {
      // Admin: state.json + every force file that differs. We need the
      // union of (nations that already have a force file on main) and
      // (nations with forces in the incoming snapshot) so deletions
      // (e.g. a country rename's old name) are caught too.
      const stateOnMain = await readFileOnMain(
        env.GITHUB_REPO,
        'public/data/state.json',
        installToken,
      );
      if (!stateOnMain.exists) {
        return errorJson(origin, 502, 'state.json missing on main — repo is broken');
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
      if (newStateJson !== stateOnMain.content) {
        await commitFile(
          env.GITHUB_REPO,
          'public/data/state.json',
          branchName,
          newStateJson,
          `state: @${login} ${ts}`,
          installToken,
          stateOnMain.sha,
        );
      }

      // Discover existing nation files via one Contents API listing —
      // saves us probing every country in the world with a 404.
      let existingNations: string[] = [];
      try {
        const dir = await gh<Array<{ name: string; type: string }>>(
          `/repos/${env.GITHUB_REPO}/contents/public/data/forces?ref=main`,
          { method: 'GET' },
          installToken,
        );
        existingNations = dir
          .filter((e) => e.type === 'file' && e.name.endsWith('.json'))
          .map((e) => e.name.slice(0, -'.json'.length));
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 404)) throw e;
        // 404 means forces/ directory doesn't exist yet — first ever bake.
      }

      const allNations = new Set([...existingNations, ...incomingByNation.keys()]);
      for (const nation of allNations) {
        const incomingForces = incomingByNation.get(nation) ?? [];
        await syncNationForces(
          env.GITHUB_REPO,
          branchName,
          nation,
          incomingForces,
          login,
          ts,
          installToken,
        );
      }
    }
  } catch (e) {
    const msg = (e as Error).message;
    return errorJson(origin, e instanceof HttpError ? e.status : 502, `commit: ${msg}`);
  }

  // 4. Open the PR — body carries the verified submitter marker.
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

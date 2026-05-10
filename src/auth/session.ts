// Session module: owns the GitHub App User-to-Server token lifecycle.
//
// Tokens last 8 hours; refresh tokens last 6 months and rotate on each
// use. We refresh proactively (when the access token is < 1 minute from
// expiry on any API call) and reactively (on a 401 we couldn't predict).
// Concurrent refresh attempts coalesce into a single network call so a
// burst of API calls doesn't fan out.
//
// Storage: localStorage `theatrum.gh_session` = full session object.
// XSS exposure of the access token is the same as before; the refresh
// token has the same exposure but rotates after every use, so a stolen
// refresh_token gets invalidated as soon as the legitimate client uses
// it again. Not perfect, but better than a never-rotating long-lived
// token.

const SESSION_KEY = 'theatrum.gh_session';
const REFRESH_BUFFER_MS = 60 * 1000;

const WORKER_URL = import.meta.env.VITE_OAUTH_WORKER_URL as string | undefined;

export interface Session {
  access_token: string;
  refresh_token?: string;
  /** ms-epoch when the access token stops being valid. */
  expires_at: number;
  /** ms-epoch when the refresh token stops being valid. */
  refresh_expires_at?: number;
}

/** Thrown when we can no longer authenticate (refresh failed / not signed in). */
export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAuthError';
  }
}

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

function writeSession(s: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

export function getSession(): Session | null {
  return readSession();
}

function postRevoke(token: string): void {
  if (!WORKER_URL) return;
  // Fire-and-forget — local state wipe must not wait on the network.
  // If the worker / GitHub is unreachable, the token still expires
  // naturally in <= 8h.
  fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revoke: token }),
    keepalive: true,
  }).catch(() => {});
}

export function clearSession(): void {
  // Best-effort revoke FIRST so the network call is built before we
  // forget the token. The actual fetch is async + ignored.
  const cur = readSession();
  if (cur?.access_token) postRevoke(cur.access_token);

  // Cancel any in-flight refresh — refreshSession's writeback also
  // double-checks readSession() so a race can't re-populate storage.
  refreshing = null;

  // Wipe everything namespaced to the app from both stores. Catches
  // SESSION_KEY, LEGACY_TOKEN_KEY, the OAuth CSRF state in
  // sessionStorage, and any future theatrum.* keys.
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('theatrum.')) localStorage.removeItem(k);
  }
  for (const k of Object.keys(sessionStorage)) {
    if (k.startsWith('theatrum.')) sessionStorage.removeItem(k);
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

function sessionFromResponse(j: TokenResponse): Session {
  if (!j.access_token) {
    const detail = j.error ? `${j.error}: ${j.error_description ?? ''}` : 'no access_token in response';
    throw new GitHubAuthError(detail);
  }
  const now = Date.now();
  const session: Session = {
    access_token: j.access_token,
    expires_at: now + (j.expires_in ?? 28800) * 1000,
  };
  if (j.refresh_token) session.refresh_token = j.refresh_token;
  if (typeof j.refresh_token_expires_in === 'number') {
    session.refresh_expires_at = now + j.refresh_token_expires_in * 1000;
  }
  return session;
}

async function postWorker(payload: object): Promise<Session> {
  if (!WORKER_URL) throw new GitHubAuthError('VITE_OAUTH_WORKER_URL is not set');
  const r = await fetch(WORKER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let j: TokenResponse;
  try {
    j = (await r.json()) as TokenResponse;
  } catch {
    throw new GitHubAuthError(`OAuth worker returned non-JSON (HTTP ${r.status})`);
  }
  if (!r.ok) {
    throw new GitHubAuthError(j.error_description ?? j.error ?? `worker HTTP ${r.status}`);
  }
  return sessionFromResponse(j);
}

/** Initial code-for-token exchange. Persists the resulting session. */
export async function exchangeCode(code: string): Promise<Session> {
  const s = await postWorker({ code });
  writeSession(s);
  return s;
}

let refreshing: Promise<Session> | null = null;

/**
 * Refresh the current session. Multiple concurrent callers share one
 * in-flight network request so we don't burn the (one-shot) refresh
 * token by sending it twice in parallel.
 */
export async function refreshSession(): Promise<Session> {
  if (refreshing) return refreshing;
  const cur = readSession();
  if (!cur?.refresh_token) {
    throw new GitHubAuthError('no refresh token available');
  }
  refreshing = (async () => {
    try {
      const s = await postWorker({ refresh_token: cur.refresh_token });
      // If a concurrent signout cleared storage during the round-trip,
      // do not re-populate it.
      if (readSession()) writeSession(s);
      return s;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Return a valid access token, refreshing if necessary. null if signed-out. */
async function getValidAccessToken(): Promise<string | null> {
  let s = readSession();
  if (!s) return null;
  if (s.expires_at - REFRESH_BUFFER_MS > Date.now()) return s.access_token;
  if (!s.refresh_token) {
    // No way to refresh — caller will hit 401 and see GitHubAuthError.
    return s.access_token;
  }
  try {
    s = await refreshSession();
  } catch {
    clearSession();
    return null;
  }
  return s.access_token;
}

/**
 * Drop-in `fetch` that attaches `Authorization: Bearer <access_token>`
 * and transparently refreshes on 401. Throws GitHubAuthError if the
 * caller is signed out OR if a refresh attempt failed.
 */
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let token = await getValidAccessToken();
  if (!token) throw new GitHubAuthError('not signed in');

  const send = (t: string): Promise<Response> =>
    fetch(input, {
      ...init,
      headers: {
        ...((init.headers as Record<string, string>) ?? {}),
        Authorization: `Bearer ${t}`,
      },
    });

  let r = await send(token);
  if (r.status !== 401) return r;

  // Reactive refresh — proactive missed (clock skew / token revoked / etc.).
  try {
    const s = await refreshSession();
    token = s.access_token;
  } catch {
    clearSession();
    throw new GitHubAuthError('session expired');
  }
  r = await send(token);
  if (r.status === 401) {
    clearSession();
    throw new GitHubAuthError('session expired even after refresh');
  }
  return r;
}

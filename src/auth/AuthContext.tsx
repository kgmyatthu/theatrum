import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type AuthRole = 'admin' | 'player';

export type AuthStatus =
  /** First-paint until we've checked for an existing token. */
  | 'loading'
  /** No token stored. */
  | 'anonymous'
  /** Signed in but not in perm.json — read-only viewer. */
  | 'unregistered'
  /** Signed in with a recognized role. */
  | 'authenticated';

export interface AuthValue {
  status: AuthStatus;
  token: string | null;
  login: string | null;
  role: AuthRole | null;
  /** Set only when role === 'player'. */
  nation: string | null;
  signIn: () => void;
  signOut: () => void;
}

interface PermEntry {
  role: 'admin' | 'player';
  nation?: string;
}
type PermFile = Record<string, PermEntry>;

const TOKEN_KEY = 'theatrum.gh_token';
const STATE_KEY = 'theatrum.oauth_state';

const CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined;
const WORKER_URL = import.meta.env.VITE_OAUTH_WORKER_URL as string | undefined;

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthValue>(() => ({
    status: 'loading',
    token: null,
    login: null,
    role: null,
    nation: null,
    signIn: () => {},
    signOut: () => {},
  }));

  // On mount: handle a returning ?code=, then resolve identity.
  useEffect(() => {
    let cancelled = false;

    async function exchangeCodeIfPresent(): Promise<void> {
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      const stateParam = url.searchParams.get('state');
      if (!code) return;

      // Always strip the code from the URL so a refresh doesn't re-trigger.
      url.searchParams.delete('code');
      url.searchParams.delete('state');
      window.history.replaceState({}, '', url.toString());

      const expected = sessionStorage.getItem(STATE_KEY);
      sessionStorage.removeItem(STATE_KEY);
      if (!expected || stateParam !== expected) {
        // CSRF guard; refuse silently.
        return;
      }
      if (!WORKER_URL) {
        console.error('VITE_OAUTH_WORKER_URL is not set; cannot complete sign-in.');
        return;
      }
      try {
        const r = await fetch(`${WORKER_URL}?code=${encodeURIComponent(code)}`);
        const j = await r.json();
        if (j.access_token) {
          localStorage.setItem(TOKEN_KEY, j.access_token);
        } else {
          console.error('OAuth exchange returned no token:', j);
        }
      } catch (err) {
        console.error('OAuth exchange failed:', err);
      }
    }

    async function resolveIdentity(): Promise<void> {
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) {
        if (!cancelled) setAuth((a) => ({ ...a, status: 'anonymous', token: null, login: null, role: null, nation: null }));
        return;
      }
      try {
        const r = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        });
        if (!r.ok) {
          // Token expired / revoked
          localStorage.removeItem(TOKEN_KEY);
          if (!cancelled) setAuth((a) => ({ ...a, status: 'anonymous', token: null, login: null, role: null, nation: null }));
          return;
        }
        const userData = (await r.json()) as { login: string };
        const login = userData.login;

        const permResp = await fetch('/data/perm.json', { cache: 'no-store' });
        const perms = (await permResp.json()) as PermFile;
        const entry = perms[login];

        if (!entry) {
          if (!cancelled) setAuth((a) => ({ ...a, status: 'unregistered', token, login, role: null, nation: null }));
          return;
        }
        if (entry.role === 'admin') {
          if (!cancelled) setAuth((a) => ({ ...a, status: 'authenticated', token, login, role: 'admin', nation: null }));
          return;
        }
        if (entry.role === 'player' && entry.nation) {
          if (!cancelled) setAuth((a) => ({ ...a, status: 'authenticated', token, login, role: 'player', nation: entry.nation! }));
          return;
        }
        if (!cancelled) setAuth((a) => ({ ...a, status: 'unregistered', token, login, role: null, nation: null }));
      } catch (err) {
        console.error('Identity resolution failed:', err);
        if (!cancelled) setAuth((a) => ({ ...a, status: 'anonymous', token: null, login: null, role: null, nation: null }));
      }
    }

    (async () => {
      await exchangeCodeIfPresent();
      await resolveIdentity();
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Provide stable signIn/signOut functions — the dependency-light approach
  // here is fine because they don't read changing state.
  useEffect(() => {
    setAuth((a) => ({ ...a, signIn, signOut }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function signIn(): void {
    if (!CLIENT_ID) {
      // eslint-disable-next-line no-alert
      alert('Sign-in is not configured: VITE_GITHUB_CLIENT_ID is missing.');
      return;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const state = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    sessionStorage.setItem(STATE_KEY, state);
    const redirect = window.location.origin + window.location.pathname;
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirect,
      scope: 'public_repo',
      state,
    });
    window.location.href = `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  function signOut(): void {
    localStorage.removeItem(TOKEN_KEY);
    setAuth((a) => ({ ...a, status: 'anonymous', token: null, login: null, role: null, nation: null }));
  }

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

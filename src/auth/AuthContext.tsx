import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchLiveData } from '@/utils/liveData';
import { normalizeNation } from '@/utils/nation';
import {
  authedFetch,
  clearSession,
  exchangeCode,
  getSession,
  GitHubAuthError,
} from './session';

export type AuthRole = 'admin' | 'player';

export type AuthStatus =
  /** First-paint until we've checked for an existing session. */
  | 'loading'
  /** No session stored. */
  | 'anonymous'
  /** Signed in but not in perm.json — read-only viewer. */
  | 'unregistered'
  /** Signed in with a recognized role. */
  | 'authenticated';

export interface AuthValue {
  status: AuthStatus;
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

const STATE_KEY = 'theatrum.oauth_state';

const CLIENT_ID = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined;

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthValue>(() => ({
    status: 'loading',
    login: null,
    role: null,
    nation: null,
    signIn: () => {},
    signOut: () => {},
  }));

  // On mount: complete a returning ?code= dance, then resolve identity.
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
      if (!expected || stateParam !== expected) return; // CSRF guard

      try {
        await exchangeCode(code);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('OAuth exchange failed:', err);
      }
    }

    async function resolveIdentity(): Promise<void> {
      const session = getSession();
      if (!session) {
        if (!cancelled) {
          setAuth((a) => ({ ...a, status: 'anonymous', login: null, role: null, nation: null }));
        }
        return;
      }
      try {
        const r = await authedFetch('https://api.github.com/user');
        if (!r.ok) throw new GitHubAuthError(`/user → ${r.status}`);
        const userData = (await r.json()) as { login: string };
        const login = userData.login;

        // perm.json read at main's latest commit SHA so admin perm
        // updates take effect on next sign-in without a Pages rebuild
        // and without Fastly staleness. Shares the SHA fetch with
        // useDataBootstrap, so this adds zero extra round-trips.
        const perms = await fetchLiveData<PermFile>('perm.json');
        const entry = perms[login];

        if (!entry) {
          if (!cancelled) {
            setAuth((a) => ({ ...a, status: 'unregistered', login, role: null, nation: null }));
          }
          return;
        }
        if (entry.role === 'admin') {
          if (!cancelled) {
            setAuth((a) => ({ ...a, status: 'authenticated', login, role: 'admin', nation: null }));
          }
          return;
        }
        if (entry.role === 'player' && entry.nation) {
          if (!cancelled) {
            setAuth((a) => ({
              ...a,
              status: 'authenticated',
              login,
              role: 'player',
              nation: normalizeNation(entry.nation!),
            }));
          }
          return;
        }
        if (!cancelled) {
          setAuth((a) => ({ ...a, status: 'unregistered', login, role: null, nation: null }));
        }
      } catch (err) {
        if (err instanceof GitHubAuthError) {
          // Session is dead and refresh failed (or there was no refresh
          // token). Wipe and fall back to anonymous.
          clearSession();
        }
        // eslint-disable-next-line no-console
        console.error('Identity resolution failed:', err);
        if (!cancelled) {
          setAuth((a) => ({ ...a, status: 'anonymous', login: null, role: null, nation: null }));
        }
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

  // Stable signIn/signOut.
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
    // GitHub Apps use App-defined permissions (configured in the App's
    // settings), so we don't pass `scope=` here — it's ignored.
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirect,
      state,
    });
    window.location.href = `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  function signOut(): void {
    clearSession();
    setAuth((a) => ({ ...a, status: 'anonymous', login: null, role: null, nation: null }));
  }

  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

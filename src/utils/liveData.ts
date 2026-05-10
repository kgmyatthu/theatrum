import { getSession } from '@/auth/session';

const REPO = import.meta.env.VITE_GITHUB_REPO as string | undefined;

// raw.githubusercontent.com URLs go through Fastly with `cache-control:
// max-age=300`. Branch-ref URLs (.../main/...) can serve stale content
// for up to 5 minutes after a commit lands; query-string cache busting
// doesn't reliably defeat this because the CDN's cache key normalization
// can ignore query params on these paths.
//
// SHA-pinned URLs (.../<commit-sha>/...) are immutable: a new commit
// produces a brand-new URL with no prior cache entry, so the response
// is always the freshly committed bytes. We pay one round-trip to the
// GitHub API to learn the latest SHA, then memoize it for the page
// session — every live-data fetch in the same load shares that SHA.

let shaPromise: Promise<string> | null = null;

async function fetchLatestSha(repo: string): Promise<string> {
  // Attach the user token when we have one. Authenticated calls get
  // 5000 requests/hour per user; anonymous gets 60/hour per IP, which
  // the bootstrap + refresh loop will burn through quickly.
  const session = getSession();
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (session?.access_token) {
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  // no-store + cache-busting query param so we ALWAYS see fresh main
  // HEAD even when the post-merge handler races a still-cached response
  // (Firefox's heuristic cache can short-circuit no-cache).
  const r = await fetch(
    `https://api.github.com/repos/${repo}/commits/main?_=${Date.now()}`,
    {
      cache: 'no-store',
      headers,
    },
  );
  if (!r.ok) {
    throw new Error(`commits/main → ${r.status}`);
  }
  const j = (await r.json()) as { sha: string };
  return j.sha;
}

async function getLatestSha(repo: string): Promise<string> {
  if (shaPromise) return shaPromise;
  shaPromise = fetchLatestSha(repo);
  // On failure, clear the memo so the next caller (or a retry on the
  // next page interaction) can try again instead of replaying the error.
  shaPromise.catch(() => {
    shaPromise = null;
  });
  return shaPromise;
}

/**
 * Fetch a JSON data file from main HEAD with no CDN-staleness window.
 *
 * In production the URL resolves to
 *   https://raw.githubusercontent.com/<repo>/<latest-sha>/public/data/<file>
 * which is immutable and never served stale.
 *
 * In local dev (no VITE_GITHUB_REPO) we read the bundled copy at
 *   /data/<file>
 */
export async function fetchLiveData<T>(filename: string): Promise<T> {
  if (!REPO) {
    const r = await fetch(`/data/${filename}`);
    if (!r.ok) throw new Error(`/data/${filename} → ${r.status}`);
    return (await r.json()) as T;
  }
  const sha = await getLatestSha(REPO);
  const r = await fetch(
    `https://raw.githubusercontent.com/${REPO}/${sha}/public/data/${filename}`,
  );
  if (!r.ok) throw new Error(`raw@${sha.slice(0, 7)} ${filename} → ${r.status}`);
  return (await r.json()) as T;
}

/**
 * Like {@link fetchLiveData} but bypasses the session-memoized SHA so a
 * long-lived page can pick up new commits. Used by useStateRefresh to
 * detect upstream drift while the user is still editing.
 */
export async function fetchLiveDataFresh<T>(filename: string): Promise<T> {
  if (!REPO) {
    const r = await fetch(`/data/${filename}`);
    if (!r.ok) throw new Error(`/data/${filename} → ${r.status}`);
    return (await r.json()) as T;
  }
  const sha = await fetchLatestSha(REPO);
  const r = await fetch(
    `https://raw.githubusercontent.com/${REPO}/${sha}/public/data/${filename}`,
  );
  if (!r.ok) throw new Error(`raw@${sha.slice(0, 7)} ${filename} → ${r.status}`);
  return (await r.json()) as T;
}

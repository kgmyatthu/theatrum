const REPO = import.meta.env.VITE_GITHUB_REPO as string | undefined;

/**
 * URL for a data file that must reflect the current state of `main` —
 * NOT the deploy bundle. Reading from raw.githubusercontent.com lets:
 *   - player move PRs propagate state.json updates instantly,
 *   - admin perm.json edits take effect on next sign-in,
 * with no Pages rebuild required (saves CI minutes).
 *
 * The `?t=...` cache-bust defeats Fastly's edge cache (raw sets
 * Cache-Control: max-age=300 by default). One miss per app load is
 * negligible compared to forcing a full Pages rebuild per change.
 *
 * In local dev (no VITE_GITHUB_REPO set), falls back to /data/<file>
 * which Vite serves from public/.
 */
export function liveDataUrl(filename: string): string {
  if (!REPO) return `/data/${filename}`;
  return `https://raw.githubusercontent.com/${REPO}/main/public/data/${filename}?t=${Date.now()}`;
}

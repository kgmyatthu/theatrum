# theatrum-oauth (Cloudflare Worker)

Tiny OAuth proxy for the GitHub App User-to-Server flow. Exists because
the `code → access_token` exchange requires `client_secret` server-side;
everything else stays in the browser.

## Why a GitHub App (not an OAuth App)

GitHub App User-to-Server tokens are scoped to the repos the App is
**installed** on, with **per-API permissions** (Contents r/w, Pull
requests r/w, Metadata r) instead of OAuth's coarse scopes. Concretely:

- Today's OAuth `gho_*` token covers **every** public repo the user can
  write to. If leaked → spam PRs to all of them.
- GitHub App `ghu_*` token covers **only** theatrum and only the
  permissions configured. If leaked → only attack surface is theatrum
  (and the validator workflow rejects unauthorized moves anyway).

Tokens last 8 hours. App rejects with 401 after that; the UI prompts
re-sign-in.

## Setup

### 1. Register the GitHub App

1. Settings → Developer settings → **GitHub Apps** → New GitHub App
2. Configure:
   - **GitHub App name**: `theatrum` (or whatever)
   - **Homepage URL**: `https://theatrum.kaungmyatthu.dev`
   - **Callback URL**: `https://theatrum.kaungmyatthu.dev/`
   - ✅ **Request user authorization (OAuth) during installation**
   - ✅ **Expire user authorization tokens** (8h tokens)
   - ❌ **Webhook**: uncheck Active (we don't use webhooks)
3. **Repository permissions**:
   - Contents: Read and write
   - Pull requests: Read and write
   - Metadata: Read-only (auto)
4. **Where can this GitHub App be installed?** → Only on this account
5. Create the App. Note the **App ID** and **Client ID**. Generate a
   **Client secret**.

### 2. Install the App on theatrum

App settings → **Install App** → kgmyatthu → **Only select repositories**
→ pick `theatrum` → Install.

(Each player who wants to use the app will be prompted to authorize as
themselves the first time they sign in — they don't need to install
anything.)

### 3. Deploy the Worker

```bash
cd worker
npm install
wrangler login
wrangler secret put GITHUB_CLIENT_ID       # GitHub App's Client ID
wrangler secret put GITHUB_CLIENT_SECRET   # GitHub App's Client secret
wrangler secret put ALLOWED_ORIGIN         # https://theatrum.kaungmyatthu.dev
wrangler deploy
```

### 4. Frontend env

Repo secrets (Settings → Secrets and variables → Actions):

```
VITE_GITHUB_CLIENT_ID=<GitHub App's Client ID>
VITE_OAUTH_WORKER_URL=https://theatrum-oauth.<sub>.workers.dev
VITE_GITHUB_REPO=kgmyatthu/theatrum
```

Re-run the deploy workflow so the new client_id is baked in.

## Migrating from an OAuth App

If you already had an OAuth App configured: keep both the App and the
new GitHub App registered until you've verified the GitHub App works,
then revoke the OAuth App. Repo secrets and Worker secrets just need
the new client_id / secret swapped in. The Worker code itself doesn't
change — `/login/oauth/access_token` works for both.

# theatrum-oauth (Cloudflare Worker)

Tiny OAuth proxy for GitHub Web flow. The only reason this exists is that
GitHub OAuth requires `client_secret` server-side; everything else stays
in the browser app.

## Setup

1. Register a GitHub OAuth App
   - Settings → Developer settings → OAuth Apps → New OAuth App
   - Authorization callback URL: `https://theatrum.kaungmyatthu.dev/`

2. Install Wrangler if you haven't: `npm install -g wrangler`

3. Inside this directory:
   ```bash
   npm install
   wrangler login
   wrangler secret put GITHUB_CLIENT_ID
   wrangler secret put GITHUB_CLIENT_SECRET
   wrangler secret put ALLOWED_ORIGIN   # e.g. https://theatrum.kaungmyatthu.dev
   wrangler deploy
   ```

4. Take the deployed worker URL and set it in the app's `.env`:
   ```
   VITE_OAUTH_WORKER_URL=https://theatrum-oauth.<your-cf-subdomain>.workers.dev
   VITE_GITHUB_CLIENT_ID=<the OAuth App client id>
   ```

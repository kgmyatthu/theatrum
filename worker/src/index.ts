// OAuth proxy for the Theatrum app. Two flows, both POST + JSON body:
//   { code }           → initial code-for-token exchange
//   { refresh_token }  → refresh an expired access token
//
// GitHub App User-to-Server tokens last 8 hours; refresh tokens last
// 6 months and rotate on each use. Both endpoints proxy to GitHub's
// /login/oauth/access_token; the only reason this lives server-side is
// `client_secret`, which can't safely sit in the SPA bundle.
//
// Legacy `GET /?code=...` is still accepted for back-compat with the
// pre-refresh-token bundle that may still be cached in someone's browser.
//
// Deploy with `wrangler deploy`. Configure secrets:
//   wrangler secret put GITHUB_CLIENT_ID
//   wrangler secret put GITHUB_CLIENT_SECRET
//   wrangler secret put ALLOWED_ORIGIN

interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_ORIGIN: string;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Legacy GET /?code=... — keep working for any old client bundle.
    if (request.method === 'GET') {
      const url = new URL(request.url);
      const code = url.searchParams.get('code');
      if (!code) return errorJson(origin, 400, 'missing code');
      return exchangeWithGitHub(env, { code }, origin);
    }

    if (request.method !== 'POST') {
      return errorJson(origin, 405, 'method not allowed');
    }

    let body: { code?: string; refresh_token?: string };
    try {
      body = (await request.json()) as { code?: string; refresh_token?: string };
    } catch {
      return errorJson(origin, 400, 'invalid json body');
    }

    if (body.code) {
      return exchangeWithGitHub(env, { code: body.code }, origin);
    }
    if (body.refresh_token) {
      return exchangeWithGitHub(
        env,
        { grant_type: 'refresh_token', refresh_token: body.refresh_token },
        origin,
      );
    }
    return errorJson(origin, 400, 'missing code or refresh_token');
  },
};

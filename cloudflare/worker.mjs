import { createRemoteJWKSet, jwtVerify } from 'jose';

const responseHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function secure(response) {
  const result = new Response(response.body, response);
  for (const [key, value] of Object.entries(responseHeaders)) result.headers.set(key, value);
  return result;
}

const keySets = new Map();
function remoteKeys(issuer) {
  if (!keySets.has(issuer)) {
    keySets.set(issuer, createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer)));
  }
  return keySets.get(issuer);
}

// Static Assets currently does not propagate ctx.access. Verify the signed Access
// application token instead; never trust the presence of an identity header.
export function createWorker(resolveKeys = remoteKeys) {
  return {
    async fetch(request, env) {
      const deny = (message, status) => secure(new Response(message, { status }));
      const issuer = (env.TEAM_DOMAIN || '').replace(/\/$/, '');
      const audience = (env.POLICY_AUD || '').trim();
      const email = (env.ALLOWED_EMAIL || '').trim().toLowerCase();
      if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !audience || !email) {
        return deny('Private dashboard is not configured.', 503);
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const response = deny('Method not allowed.', 405);
        response.headers.set('Allow', 'GET, HEAD');
        return response;
      }
      const token = request.headers.get('cf-access-jwt-assertion');
      if (!token) return deny('Sign in through Cloudflare Access to continue.', 403);
      try {
        const { payload } = await jwtVerify(token, resolveKeys(issuer), {
          issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'email'],
        });
        if (payload.type !== 'app' || typeof payload.email !== 'string' || payload.email.toLowerCase() !== email) {
          return deny('Access denied.', 403);
        }
      } catch {
        return deny('Access denied.', 403);
      }
      return secure(await env.ASSETS.fetch(request));
    },
  };
}

export default createWorker();

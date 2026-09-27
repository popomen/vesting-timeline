import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createWorker } from '../cloudflare/worker.mjs';

const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = await exportJWK(publicKey);
const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'test', alg: 'RS256' }] });
const worker = createWorker(() => keys);
const config = {
  TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
  POLICY_AUD: 'test-audience',
  ALLOWED_EMAIL: 'owner@example.com',
};
async function token(overrides = {}, key = privateKey) {
  return new SignJWT({
    iss: config.TEAM_DOMAIN, aud: config.POLICY_AUD,
    email: config.ALLOWED_EMAIL, type: 'app',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(key);
}
async function request(path, jwt, overrides = {}, method = 'GET') {
  let assetCalls = 0;
  const env = {
    ...config, ...overrides,
    ASSETS: { async fetch() { assetCalls++; return new Response('protected content'); } },
  };
  const headers = jwt ? { 'cf-access-jwt-assertion': jwt } : {};
  const response = await worker.fetch(new Request('https://example.workers.dev' + path, { headers, method }), env);
  return { response, assetCalls };
}

test('missing authentication cannot read homepage, JSON or assets', async () => {
  for (const path of ['/', '/data/awards-timeline.json', '/app.js']) {
    const { response, assetCalls } = await request(path);
    assert.equal(response.status, 403);
    assert.equal(assetCalls, 0);
    assert.match(response.headers.get('cache-control'), /no-store/);
  }
});
test('missing or invalid deployment configuration fails closed', async () => {
  const jwt = await token();
  for (const overrides of [{ TEAM_DOMAIN: '' }, { POLICY_AUD: '' }, { ALLOWED_EMAIL: '' }, { TEAM_DOMAIN: 'https://attacker.invalid' }]) {
    const { response, assetCalls } = await request('/', jwt, overrides);
    assert.equal(response.status, 503);
    assert.equal(assetCalls, 0);
  }
});
test('rejects malformed, expired, wrong issuer/audience, wrong email and non-app tokens', async () => {
  const cases = [
    'forged.header.signature',
    await token({ exp: 1 }), await token({ exp: undefined }),
    await token({ iss: 'https://other.cloudflareaccess.com' }),
    await token({ aud: 'other-app' }), await token({ email: 'other@example.com' }),
    await token({ email: undefined }), await token({ type: 'org' }),
  ];
  const stranger = await generateKeyPair('RS256');
  cases.push(await token({}, stranger.privateKey));
  for (const jwt of cases) {
    const { response, assetCalls } = await request('/data/awards-timeline.json', jwt);
    assert.equal(response.status, 403);
    assert.equal(assetCalls, 0);
  }
});
test('valid login serves the asset with private response headers', async () => {
  const { response, assetCalls } = await request('/data/awards-timeline.json', await token());
  assert.equal(response.status, 200);
  assert.equal(assetCalls, 1);
  assert.equal(await response.text(), 'protected content');
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
test('write methods never reach static assets', async () => {
  const { response, assetCalls } = await request('/', await token(), {}, 'POST');
  assert.equal(response.status, 405);
  assert.equal(assetCalls, 0);
});

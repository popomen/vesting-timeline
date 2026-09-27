import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createHandler } from '../cloudbase/index.cjs';

const password = 'synthetic-test-password-only';
const passwordHash = createHash('sha256').update(password).digest('hex');
const authorization = 'Basic ' + Buffer.from('vesting:' + password).toString('base64');
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vesting-handler-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'data'));
  await writeFile(path.join(directory, 'index.html'), '<h1>Synthetic dashboard</h1>');
  await writeFile(path.join(directory, 'data/awards-timeline.json'), '{"synthetic":"private"}');
  await writeFile(path.join(directory, 'unexpected.txt'), 'must-not-be-served');
  const handler = createHandler({ root: directory, env: { DASHBOARD_PASSWORD_SHA256: passwordHash, ...overrides } });
  const request = (url, headers = { authorization }, httpMethod = 'GET') => handler({ path: url, httpMethod, headers });
  return { request };
}
test('anonymous and incorrect credentials never return homepage or data', async (t) => {
  const { request } = await fixture(t);
  for (const url of ['/vesting/', '/vesting/data/awards-timeline.json', '/vesting/index.html']) {
    for (const headers of [{}, { authorization: 'Basic '+Buffer.from('vesting:wrong').toString('base64') }, { authorization: 'Bearer invalid' }]) {
      const result = await request(url, headers);
      assert.equal(result.statusCode, 401);
      assert.match(result.headers['WWW-Authenticate'], /^Basic /);
      assert.doesNotMatch(result.body, /Synthetic|private|must-not/);
      assert.match(result.headers['Cache-Control'], /no-store/);
    }
  }
});
test('authorized users can read the app and JSON, including HEAD', async (t) => {
  const { request } = await fixture(t);
  assert.match((await request('/vesting/')).body, /Synthetic dashboard/);
  assert.equal((await request('/vesting/data/awards-timeline.json')).body, '{"synthetic":"private"}');
  const upper = await request('/vesting/', { Authorization: authorization });
  assert.equal(upper.statusCode, 200);
  const head = await request('/vesting/', { authorization }, 'HEAD');
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.match(head.headers['Content-Security-Policy'], /script-src 'self'/);
});
test('missing config and malformed requests fail closed', async (t) => {
  for (const value of ['', 'not-a-hash']) {
    const { request } = await fixture(t, { DASHBOARD_PASSWORD_SHA256: value });
    assert.equal((await request('/vesting/')).statusCode, 503);
  }
});
test('wrong usernames, malformed or multiple credentials cannot sign in', async (t) => {
  const { request } = await fixture(t);
  for (const value of ['Basic !!!', 'Basic '+Buffer.from('other:'+password).toString('base64'), [authorization, authorization], 'Basic '+ 'a'.repeat(9000)]) {
    assert.equal((await request('/vesting/', { authorization: value })).statusCode, 401);
  }
});
test('only allowlisted asset paths are served; traversal never exposes source', async (t) => {
  const { request } = await fixture(t);
  for (const url of ['/vesting/../index.js', '/vesting/%2e%2e/index.js', '/vesting/unexpected.txt', '/vesting/.env', '/vesting/index.js', '/other/', '/vesting/%00', '/vesting/%ZZ', '/vesting/a\\b']) {
    const result = await request(url);
    assert.equal(result.statusCode, 404, url);
    assert.doesNotMatch(result.body, /must-not-be-served/);
  }
});
test('prefix redirect preserves local paths, query strings do not alter the whitelist', async (t) => {
  const { request } = await fixture(t);
  const result = await request('/vesting');
  assert.equal(result.statusCode, 308);
  assert.equal(result.headers.Location, '/vesting/');
  assert.equal((await request('/vesting/?today=2026-09-27')).statusCode, 200);
  assert.equal((await request('/vesting/app.js')).statusCode, 404);
  assert.equal((await request('/vesting/', { authorization }, 'POST')).statusCode, 405);
});

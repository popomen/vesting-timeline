import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildCloudflare as build } from '../scripts/build_cloudflare.mjs';

const scriptPath = fileURLToPath(new URL('../scripts/build_cloudflare.mjs', import.meta.url));
const publicFiles = ['app.js', 'demo-data.json', 'index.html', 'robots.txt', 'vendor/d3.LICENSE', 'vendor/d3.min.js'];

function data() {
  return {
    as_of: '2026-09-27',
    awards: {
      example: { label: 'Synthetic grant', cat: 'option', units: 1, grant: '2026-01-01' },
      pending: { label: 'Synthetic proposed grant', cat: 'dola', units: 0.3, grant: '2026-01-01', proposed: true },
    },
    order: ['example', 'pending'],
    tranches: [
      ['2026-02-01', 'example', 'option', 0.6, 'tranche'],
      ['2026-03-01', 'example', 'option', 0.4, 'cancel'],
      ['2026-02-01', 'pending', 'dola', 0.1, 'ptranche'],
      ['2026-03-01', 'pending', 'dola', 0.2, 'ptranche'],
    ],
    orig_plan: {},
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'vesting-build-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function put(name, contents) {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const demo = data();
  const privateData = data();
  privateData.synthetic_private_marker = 'fixture-private-secret';
  await Promise.all([
    put('index.html', '<!doctype html><script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script><script src="app.js"></script>'),
    put('app.js', '/* public application fixture */'),
    put('node_modules/d3/dist/d3.min.js', '/* bundled d3 fixture */'),
    put('node_modules/d3/LICENSE', 'Synthetic license fixture'),
    put('demo-data.json', JSON.stringify(demo)),
    put('data/awards-timeline.json', JSON.stringify(privateData)),
    put('robots.txt', 'User-agent: *\nDisallow: /\n'),
    put('private-note.txt', 'fixture-private-secret'),
    put('.env', 'fixture-private-secret'),
    put('.git/config', 'fixture-private-secret'),
    put('data/extra.json', 'fixture-private-secret'),
  ]);
  return { root, put, demo, privateData, assets: path.join(root, '.work/cloudflare/assets'), manifest: path.join(root, '.work/cloudflare/manifest.json') };
}

async function filesAt(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const child of await filesAt(path.join(directory, entry.name))) files.push(`${entry.name}/${child}`);
    } else files.push(entry.name);
  }
  return files.sort();
}

test('default demo build publishes only the fixed whitelist and bundles D3 locally', async (t) => {
  const f = await fixture(t);
  // A demo build must not even parse a private source that happens to exist.
  await f.put('data/awards-timeline.json', 'invalid private fixture that must not be read');
  await build({ root: f.root });
  assert.deepEqual(await filesAt(f.assets), publicFiles);
  const html = await readFile(path.join(f.assets, 'index.html'), 'utf8');
  assert.match(html, /src="vendor\/d3\.min\.js"/);
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net/);
  assert.equal(await readFile(path.join(f.assets, 'vendor/d3.LICENSE'), 'utf8'), 'Synthetic license fixture');
});

test('manifest hashes only emitted assets without source paths or private contents', async (t) => {
  const f = await fixture(t);
  await build({ root: f.root, mode: 'demo' });
  const raw = await readFile(f.manifest, 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.mode, 'demo');
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), publicFiles);
  assert.doesNotMatch(raw, /fixture-private-secret|awards-timeline|vesting-build-test/);
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(f.assets, file.path));
    assert.equal(file.bytes, bytes.length);
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
});

test('explicit private mode copies only the designated private data file', async (t) => {
  const f = await fixture(t);
  await build({ root: f.root, mode: 'private' });
  assert.deepEqual(await filesAt(f.assets), [...publicFiles, 'data/awards-timeline.json'].sort());
  assert.deepEqual(JSON.parse(await readFile(path.join(f.assets, 'data/awards-timeline.json'), 'utf8')), f.privateData);
  const raw = await readFile(f.manifest, 'utf8');
  assert.equal(JSON.parse(raw).mode, 'private');
  assert.doesNotMatch(raw, /fixture-private-secret|vesting-build-test/);
});

test('switching from private to demo removes all prior and unexpected assets', async (t) => {
  const f = await fixture(t);
  await build({ root: f.root, mode: 'private' });
  await f.put('.work/cloudflare/assets/nested/stale-private.txt', 'fixture-private-secret');
  await build({ root: f.root, mode: 'demo' });
  assert.deepEqual(await filesAt(f.assets), publicFiles);
  assert.equal(JSON.parse(await readFile(f.manifest, 'utf8')).mode, 'demo');
});

test('grant reconciliation includes cancellation and tolerates ordinary floating point noise', async (t) => {
  const f = await fixture(t);
  await build({ root: f.root, mode: 'private' });
  assert.deepEqual(await filesAt(f.assets), [...publicFiles, 'data/awards-timeline.json'].sort());
});

const invalidCases = [
  ['invalid JSON', () => '{"fixture-private-secret":'],
  ['missing awards', (value) => { delete value.awards; }],
  ['empty schedule', (value) => { value.tranches = []; }],
  ['unknown award reference', (value) => { value.tranches[0][1] = 'fixture-private-secret'; }],
  ['invalid category', (value) => { value.tranches[0][2] = 'invalid'; }],
  ['invalid event kind', (value) => { value.tranches[0][4] = 'invalid'; }],
  ['invalid date', (value) => { value.tranches[0][0] = '2026-02-30'; }],
  ['negative quantity', (value) => { value.tranches[0][3] = -0.6; }],
  ['numeric string quantity', (value) => { value.tranches[0][3] = '0.6'; }],
  ['non-finite quantity', (value) => { value.tranches[0][3] = Infinity; }],
  ['incomplete order', (value) => { value.order = ['example']; }],
  ['duplicate order', (value) => { value.order = ['example', 'example']; }],
  ['wrong award total', (value) => { value.awards.example.units = 987654321; }],
];

for (const [name, mutate] of invalidCases) {
  test(`rejects ${name} without leaking contents or leaving deployable stale assets`, async (t) => {
    const f = await fixture(t);
    await build({ root: f.root, mode: 'private' });
    const candidate = data();
    candidate.synthetic_private_marker = 'fixture-private-secret';
    const text = mutate(candidate);
    await f.put('data/awards-timeline.json', typeof text === 'string' ? text : JSON.stringify(candidate));
    await assert.rejects(build({ root: f.root, mode: 'private' }), (error) => {
      assert.equal(error.message, 'Cloudflare build failed. Check required files and data validation.');
      assert.doesNotMatch(error.stack, /fixture-private-secret|987654321/);
      return true;
    });
    assert.deepEqual(await filesAt(f.assets), []);
    await assert.rejects(readFile(f.manifest), { code: 'ENOENT' });
  });
}

test('rejects an unknown mode or arbitrary output option', async (t) => {
  const f = await fixture(t);
  await assert.rejects(build({ root: f.root, mode: 'anything' }));
  await assert.rejects(build({ root: f.root, out: 'public' }));
});

test('CLI defaults to demo, requires explicit private, and prints generic failures', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'scripts'), { recursive: true });
  await copyFile(scriptPath, path.join(f.root, 'scripts/build_cloudflare.mjs'));
  const run = (...args) => spawnSync(process.execPath, [path.join(f.root, 'scripts/build_cloudflare.mjs'), ...args], { encoding: 'utf8', cwd: tmpdir() });
  const demo = run();
  assert.equal(demo.status, 0, demo.stderr);
  assert.deepEqual(await filesAt(f.assets), publicFiles);
  const privateBuild = run('--private');
  assert.equal(privateBuild.status, 0, privateBuild.stderr);
  assert.deepEqual(await filesAt(f.assets), [...publicFiles, 'data/awards-timeline.json'].sort());
  await f.put('data/awards-timeline.json', '{"fixture-private-secret":');
  const invalid = run('--private');
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stderr.trim(), 'Cloudflare build failed. Check required files and data validation.');
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /fixture-private-secret|vesting-build-test/);
  for (const args of [['--out', '/tmp/arbitrary'], ['--demo', '--private'], ['--unknown']]) {
    assert.equal(run(...args).status, 1);
  }
});

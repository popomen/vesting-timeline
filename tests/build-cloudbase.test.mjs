import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildCloudflare } from '../scripts/build_cloudflare.mjs';
import { buildCloudbase as build } from '../scripts/build_cloudbase.mjs';

const cloudbaseScript = fileURLToPath(new URL('../scripts/build_cloudbase.mjs', import.meta.url));
const cloudflareScript = fileURLToPath(new URL('../scripts/build_cloudflare.mjs', import.meta.url));
const failure = 'CloudBase build failed. Check required files and data validation.';
const assetFiles = ['app.js', 'demo-data.json', 'index.html', 'robots.txt', 'vendor/d3.LICENSE', 'vendor/d3.min.js'];
const packageFiles = [...assetFiles.map((file) => `assets/${file}`), 'index.js', 'package.json'].sort();
const handler = 'exports.main = async () => ({ statusCode: 200, body: "synthetic fixture" });\n';

function syntheticData(privateFixture = false) {
  return {
    awards: { synthetic: { cat: 'option', label: privateFixture ? 'fixture-secret-marker' : 'demo', units: 0.3, grant: '2026-01-01' } },
    order: ['synthetic'],
    tranches: [['2026-02-01', 'synthetic', 'option', 0.1, 'tranche'], ['2026-03-01', 'synthetic', 'option', 0.2, 'cancel']],
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'vesting-cloudbase-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (name, contents) => {
    const destination = path.join(root, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  };
  await Promise.all([
    put('index.html', '<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script><script src="app.js"></script>'),
    put('app.js', '/* synthetic application */'),
    put('node_modules/d3/dist/d3.min.js', '/* synthetic d3 */'),
    put('node_modules/d3/LICENSE', 'Synthetic d3 license'),
    put('demo-data.json', JSON.stringify(syntheticData())),
    put('data/awards-timeline.json', JSON.stringify(syntheticData(true))),
    put('robots.txt', 'User-agent: *\nDisallow: /\n'),
    put('cloudbase/index.cjs', handler),
    put('cloudbase/secret.txt', 'fixture-secret-marker'),
    put('.env', 'fixture-secret-marker'),
    put('data/unrelated-private.json', 'fixture-secret-marker'),
    put('notes.pdf', 'fixture-secret-marker'),
    put('package.json', '{"type":"module","syntheticDoNotCopy":true}'),
  ]);
  return { root, put, output: path.join(root, '.work/cloudbase'), functionDir: path.join(root, '.work/cloudbase/functions/vesting') };
}

async function fileList(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      for (const child of await fileList(path.join(directory, entry.name))) result.push(`${entry.name}/${child}`);
    } else result.push(entry.name);
  }
  return result.sort();
}

test('CloudBase defaults to a CommonJS function package containing only public assets', async (t) => {
  const f = await fixture(t);
  await f.put('data/awards-timeline.json', 'invalid private input that must not be parsed');
  await build({ root: f.root });
  assert.deepEqual(await fileList(f.functionDir), packageFiles);
  assert.equal(await readFile(path.join(f.functionDir, 'index.js'), 'utf8'), handler);
  const pkg = JSON.parse(await readFile(path.join(f.functionDir, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'commonjs');
  assert.equal(pkg.name, 'vesting');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.syntheticDoNotCopy, undefined);
  const run = spawnSync(process.execPath, ['-e', 'require("./index.js").main().then(value => console.log(value.statusCode))'], { cwd: f.functionDir, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '200');
  assert.match(await readFile(path.join(f.functionDir, 'assets/index.html'), 'utf8'), /src="vendor\/d3\.min\.js"/);
});

test('private mode puts the private JSON only inside designated function assets', async (t) => {
  const f = await fixture(t);
  await build({ root: f.root, mode: 'private' });
  const expected = [...packageFiles, 'assets/data/awards-timeline.json'].sort();
  assert.deepEqual(await fileList(f.functionDir), expected);
  assert.deepEqual(await fileList(f.output), [...expected.map((file) => `functions/vesting/${file}`), 'manifest.json'].sort());
  for (const file of await fileList(f.output)) {
    const contents = await readFile(path.join(f.output, file), 'utf8');
    if (file === 'functions/vesting/assets/data/awards-timeline.json') assert.match(contents, /fixture-secret-marker/);
    else assert.doesNotMatch(contents, /fixture-secret-marker/);
  }
});

test('manifest remains outside the deployable function and hashes every emitted file', async (t) => {
  const f = await fixture(t);
  const result = await build({ root: f.root, mode: 'private' });
  const raw = await readFile(path.join(f.output, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(raw);
  assert.deepEqual(result, manifest);
  assert.equal(manifest.mode, 'private');
  assert.doesNotMatch(raw, /fixture-secret-marker|vesting-cloudbase-test/);
  assert.deepEqual(manifest.files.map((entry) => entry.path).sort(), await fileList(f.functionDir));
  for (const file of manifest.files) {
    const contents = await readFile(path.join(f.functionDir, file.path));
    assert.equal(file.bytes, contents.length);
    assert.equal(file.sha256, createHash('sha256').update(contents).digest('hex'));
  }
});

test('private to demo removes private and stale function files', async (t) => {
  const f = await fixture(t);
  await build({ root: f.root, mode: 'private' });
  await f.put('.work/cloudbase/functions/vesting/unexpected-secret.txt', 'fixture-secret-marker');
  await build({ root: f.root, mode: 'demo' });
  assert.deepEqual(await fileList(f.functionDir), packageFiles);
  assert.equal(JSON.parse(await readFile(path.join(f.output, 'manifest.json'), 'utf8')).mode, 'demo');
});

for (const [name, corrupt] of [
  ['invalid JSON', (f) => f.put('data/awards-timeline.json', '{"fixture-secret-marker":')],
  ['incorrect total', (f) => { const data = syntheticData(true); data.awards.synthetic.units = 7654321; return f.put('data/awards-timeline.json', JSON.stringify(data)); }],
  ['invalid demo', (f) => f.put('demo-data.json', '{}')],
  ['missing handler', (f) => rm(path.join(f.root, 'cloudbase/index.cjs'))],
  ['missing public dependency', (f) => rm(path.join(f.root, 'node_modules/d3/dist/d3.min.js'))],
]) {
  test(`failed build (${name}) clears stale function and manifest with a generic error`, async (t) => {
    const f = await fixture(t);
    await build({ root: f.root, mode: 'private' });
    await corrupt(f);
    await assert.rejects(build({ root: f.root, mode: 'private' }), (error) => {
      assert.equal(error.message, failure);
      assert.doesNotMatch(error.stack, /fixture-secret-marker|7654321/);
      return true;
    });
    assert.deepEqual(await fileList(f.functionDir), []);
    await assert.rejects(readFile(path.join(f.output, 'manifest.json')), { code: 'ENOENT' });
  });
}

test('CloudBase builds never rewrite the Cloudflare deployment or root package', async (t) => {
  const f = await fixture(t);
  await buildCloudflare({ root: f.root, mode: 'private' });
  const cloudflare = path.join(f.root, '.work/cloudflare');
  const beforeFiles = await fileList(cloudflare);
  const before = await Promise.all(beforeFiles.map((file) => readFile(path.join(cloudflare, file), 'utf8')));
  const packageBefore = await readFile(path.join(f.root, 'package.json'), 'utf8');
  await build({ root: f.root, mode: 'private' });
  await build({ root: f.root, mode: 'demo' });
  assert.deepEqual(await fileList(cloudflare), beforeFiles);
  assert.deepEqual(await Promise.all(beforeFiles.map((file) => readFile(path.join(cloudflare, file), 'utf8'))), before);
  assert.equal(await readFile(path.join(f.root, 'package.json'), 'utf8'), packageBefore);
});

test('CLI stays in its fixture root and rejects arbitrary output or ambiguous modes', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'scripts'), { recursive: true });
  await copyFile(cloudbaseScript, path.join(f.root, 'scripts/build_cloudbase.mjs'));
  await copyFile(cloudflareScript, path.join(f.root, 'scripts/build_cloudflare.mjs'));
  const run = (...args) => spawnSync(process.execPath, [path.join(f.root, 'scripts/build_cloudbase.mjs'), ...args], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(run('--private').status, 0);
  assert.match(await readFile(path.join(f.functionDir, 'assets/data/awards-timeline.json'), 'utf8'), /fixture-secret-marker/);
  assert.equal(run().status, 0);
  assert.deepEqual(await fileList(f.functionDir), packageFiles);
  assert.deepEqual(await fileList(path.join(f.root, '.work/cloudflare')), []);
  await f.put('data/awards-timeline.json', '{"fixture-secret-marker":');
  const failed = run('--private');
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr.trim(), failure);
  assert.doesNotMatch(failed.stdout + failed.stderr, /fixture-secret-marker|vesting-cloudbase-test/);
  for (const args of [['--out', '/tmp/other'], ['--demo', '--private'], ['--unknown']]) assert.equal(run(...args).status, 1);
  await assert.rejects(build({ root: f.root, out: 'other' }));
  await assert.rejects(build({ root: f.root, mode: 'other' }));
});

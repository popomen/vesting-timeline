#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareAssets } from './build_cloudflare.mjs';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const FAILURE = 'CloudBase build failed. Check required files and data validation.';

function requireValid(condition) {
  if (!condition) throw new Error(FAILURE);
}

async function ensureDirectory(directory) {
  try {
    // Do not follow symlinked output parents during recursive cleanup.
    requireValid((await lstat(directory)).isDirectory());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(directory);
  }
}

/** Build one dependency-free Event function; only explicit private mode includes private data. */
export async function buildCloudbase(options = {}) {
  let functionDir;
  let manifestPath;
  try {
    requireValid(options !== null && typeof options === 'object' && !Array.isArray(options));
    requireValid(Object.keys(options).every((key) => ['root', 'mode'].includes(key)));
    const { root = DEFAULT_ROOT, mode = 'demo' } = options;
    requireValid(typeof root === 'string' && ['demo', 'private'].includes(mode));
    const base = path.resolve(root);
    const work = path.join(base, '.work');
    const output = path.join(work, 'cloudbase');
    const functions = path.join(output, 'functions');
    await ensureDirectory(work);
    await ensureDirectory(output);
    await ensureDirectory(functions);
    functionDir = path.join(functions, 'vesting');
    manifestPath = path.join(output, 'manifest.json');
    await rm(functionDir, { recursive: true, force: true });
    await rm(manifestPath, { force: true });

    const assets = await prepareAssets(base, mode);
    const handlerPath = path.join(base, 'cloudbase/index.cjs');
    requireValid((await lstat(handlerPath)).isFile());
    const handler = await readFile(handlerPath);
    const pkg = { name: 'vesting', private: true, type: 'commonjs', main: 'index.js' };
    const prepared = [
      { path: 'index.js', bytes: handler },
      { path: 'package.json', bytes: Buffer.from(`${JSON.stringify(pkg, null, 2)}\n`) },
      ...assets.map((asset) => ({ path: `assets/${asset.path}`, bytes: asset.bytes })),
    ];

    const files = [];
    for (const file of prepared.sort((a, b) => a.path.localeCompare(b.path))) {
      const destination = path.join(functionDir, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes);
      files.push({ path: file.path, sha256: createHash('sha256').update(file.bytes).digest('hex'), bytes: file.bytes.length });
    }
    const manifest = { mode, files };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch {
    // Discard the complete deployment package after validation or write failures.
    if (functionDir) await rm(functionDir, { recursive: true, force: true }).catch(() => {});
    if (manifestPath) await rm(manifestPath, { force: true }).catch(() => {});
    throw new Error(FAILURE);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    requireValid(args.length === 0 || (args.length === 1 && ['--demo', '--private'].includes(args[0])));
    const mode = args[0] === '--private' ? 'private' : 'demo';
    await buildCloudbase({ mode });
    console.log(`CloudBase ${mode} function package built and validated.`);
  } catch {
    console.error(FAILURE);
    process.exitCode = 1;
  }
}

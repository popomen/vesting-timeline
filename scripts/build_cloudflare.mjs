#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const FAILURE = 'Cloudflare build failed. Check required files and data validation.';
const D3_CDN = 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js';
const PUBLIC_FILES = [
  ['index.html', 'index.html'],
  ['app.js', 'app.js'],
  ['node_modules/d3/dist/d3.min.js', 'vendor/d3.min.js'],
  ['node_modules/d3/LICENSE', 'vendor/d3.LICENSE'],
  ['demo-data.json', 'demo-data.json'],
  ['robots.txt', 'robots.txt'],
];

function requireValid(condition) {
  // Never include source values, paths or JSON parse diagnostics in errors.
  if (!condition) throw new Error(FAILURE);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isQuantity(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateData(bytes) {
  const data = JSON.parse(bytes.toString('utf8'));
  requireValid(isObject(data) && isObject(data.awards));
  const awards = Object.entries(data.awards);
  requireValid(awards.length > 0 && Array.isArray(data.tranches) && data.tranches.length > 0);
  const totals = new Map();
  for (const [id, award] of awards) {
    requireValid(id.length > 0 && isObject(award));
    requireValid(['dola', 'option'].includes(award.cat));
    requireValid(typeof award.label === 'string' && award.label.trim().length > 0);
    requireValid(isQuantity(award.units) && isDate(award.grant));
    requireValid(award.exp === undefined || isDate(award.exp));
    requireValid(award.proposed === undefined || typeof award.proposed === 'boolean');
    totals.set(id, 0);
  }
  if (data.order !== undefined) {
    requireValid(Array.isArray(data.order) && data.order.length === awards.length);
    requireValid(new Set(data.order).size === awards.length && data.order.every((id) => totals.has(id)));
  }
  requireValid(data.as_of === undefined || isDate(data.as_of));
  requireValid(data.orig_plan === undefined || (isObject(data.orig_plan) && Object.values(data.orig_plan).every(isQuantity)));
  if (data.prices !== undefined) {
    requireValid(isObject(data.prices));
    for (const cat of ['dola', 'option']) requireValid(data.prices[cat] === undefined || isQuantity(data.prices[cat]));
  }
  for (const tranche of data.tranches) {
    requireValid(Array.isArray(tranche) && tranche.length === 5);
    const [date, id, category, units, kind] = tranche;
    requireValid(isDate(date) && totals.has(id));
    requireValid(category === data.awards[id].cat && isQuantity(units));
    requireValid(['tranche', 'ptranche', 'cancel'].includes(kind));
    totals.set(id, totals.get(id) + units);
  }
  for (const [id, award] of awards) {
    const actual = totals.get(id);
    const tolerance = Math.max(1e-8, Math.abs(award.units) * 1e-10);
    requireValid(Number.isFinite(actual) && Math.abs(actual - award.units) <= tolerance);
  }
}

async function ensureDirectory(directory) {
  try {
    requireValid((await lstat(directory)).isDirectory());
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(directory);
  }
}

/** Read and validate the allowlisted assets without writing any deployment output. */
export async function prepareAssets(root, mode = 'demo') {
  try {
    requireValid(typeof root === 'string' && ['demo', 'private'].includes(mode));
    const sources = [...PUBLIC_FILES];
    if (mode === 'private') sources.push(['data/awards-timeline.json', 'data/awards-timeline.json']);
    const prepared = [];
    for (const [source, destination] of sources) {
      const sourcePath = path.join(root, source);
      requireValid((await lstat(sourcePath)).isFile());
      let bytes = await readFile(sourcePath);
      if (destination.endsWith('.json')) validateData(bytes);
      if (destination === 'index.html') {
        const html = bytes.toString('utf8');
        requireValid(html.split(D3_CDN).length === 2);
        bytes = Buffer.from(html.replace(D3_CDN, 'vendor/d3.min.js'));
      }
      prepared.push({ path: destination, bytes });
    }
    return prepared;
  } catch {
    throw new Error(FAILURE);
  }
}

/** Build a fixed, explicit asset whitelist. Only private mode reads private data. */
export async function buildCloudflare(options = {}) {
  let assets;
  let manifestPath;
  try {
    requireValid(isObject(options) && Object.keys(options).every((key) => ['root', 'mode'].includes(key)));
    const { root = DEFAULT_ROOT, mode = 'demo' } = options;
    requireValid(typeof root === 'string' && ['demo', 'private'].includes(mode));
    const base = path.resolve(root);
    // Refuse symlinked output parents before recursive cleanup.
    const work = path.join(base, '.work');
    const output = path.join(work, 'cloudflare');
    await ensureDirectory(work);
    await ensureDirectory(output);
    assets = path.join(output, 'assets');
    manifestPath = path.join(output, 'manifest.json');
    await rm(assets, { recursive: true, force: true });
    await rm(manifestPath, { force: true });

    const prepared = await prepareAssets(base, mode);
    const files = [];
    for (const file of prepared.sort((a, b) => a.path.localeCompare(b.path))) {
      const destination = path.join(assets, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes);
      files.push({ path: file.path, sha256: createHash('sha256').update(file.bytes).digest('hex'), bytes: file.bytes.length });
    }
    const manifest = { mode, files };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch {
    // A failed build must never leave a previous private deployment available.
    if (assets) await rm(assets, { recursive: true, force: true }).catch(() => {});
    if (manifestPath) await rm(manifestPath, { force: true }).catch(() => {});
    throw new Error(FAILURE);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    requireValid(args.length === 0 || (args.length === 1 && ['--demo', '--private'].includes(args[0])));
    const mode = args[0] === '--private' ? 'private' : 'demo';
    await buildCloudflare({ mode });
    console.log(`Cloudflare ${mode} assets built and validated.`);
  } catch {
    console.error(FAILURE);
    process.exitCode = 1;
  }
}

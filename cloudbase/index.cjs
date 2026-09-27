'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const TYPES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/vendor/d3.min.js': ['vendor/d3.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/d3.LICENSE': ['vendor/d3.LICENSE', 'text/plain; charset=utf-8'],
  '/demo-data.json': ['demo-data.json', 'application/json; charset=utf-8'],
  '/data/awards-timeline.json': ['data/awards-timeline.json', 'application/json; charset=utf-8'],
  '/robots.txt': ['robots.txt', 'text/plain; charset=utf-8'],
};
const HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Vary': 'Authorization',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'",
};

function getHeader(headers, key) {
  const match = Object.entries(headers || {}).find(([name]) => name.toLowerCase() === key);
  return match && typeof match[1] === 'string' ? match[1] : '';
}

function authenticated(headers, expected) {
  const authorization = getHeader(headers, 'authorization');
  if (authorization.length > 4096 || !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(authorization)) return false;
  const credentials = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  if (!credentials.startsWith('vesting:')) return false;
  const actual = createHash('sha256').update(credentials.slice(8)).digest();
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

// The whole allowlisted site lives inside this function package. There is no
// public hosting copy of the JSON that could bypass this authentication check.
function createHandler({ root = path.join(__dirname, 'assets'), env = process.env } = {}) {
  return async function handler(event = {}) {
    const respond = (statusCode, body, extra = {}) => ({
      statusCode,
      headers: { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8', ...extra },
      body: event.httpMethod === 'HEAD' ? '' : body,
      isBase64Encoded: false,
    });
    const digest = env.DASHBOARD_PASSWORD_SHA256 || '';
    if (!/^[a-f0-9]{64}$/.test(digest)) return respond(503, 'Private dashboard is not configured.');
    if (getHeader(event.headers, 'x-forwarded-proto').toLowerCase() === 'http') {
      return respond(426, 'Use HTTPS to access this dashboard.');
    }
    if (!authenticated(event.headers, digest)) {
      return respond(401, 'Authentication required.', { 'WWW-Authenticate': 'Basic realm="Vesting", charset="UTF-8"' });
    }
    if (!['GET', 'HEAD'].includes(event.httpMethod)) return respond(405, 'Method not allowed.', { Allow: 'GET, HEAD' });
    let pathname;
    try {
      pathname = decodeURIComponent((event.path || '').split('?')[0]);
    } catch {
      return respond(404, 'Not found.');
    }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part === '.' || part === '..')) {
      return respond(404, 'Not found.');
    }
    if (pathname === '/vesting') return respond(308, '', { Location: '/vesting/' });
    if (!pathname.startsWith('/vesting/')) return respond(404, 'Not found.');
    const relative = pathname.slice('/vesting'.length);
    const asset = Object.hasOwn(TYPES, relative) ? TYPES[relative] : undefined;
    if (!asset) return respond(404, 'Not found.');
    try {
      const body = await readFile(path.join(root, asset[0]), 'utf8');
      return respond(200, body, { 'Content-Type': asset[1] });
    } catch (error) {
      return respond(error.code === 'ENOENT' ? 404 : 503, 'Resource unavailable.');
    }
  };
}

exports.createHandler = createHandler;
exports.main = createHandler();

/* SokkerLiga API server.
 *
 * No dependencies: node:http and node:sqlite only. Sign-in is the Conforza
 * front door's job — see server/identity.mjs.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, ValidationError } from './db.mjs';
import { identityFrom, recordVisit } from './identity.mjs';
import { VERSION } from '../src/version.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const PORT = Number(process.env.PORT ?? 5176);
/* Loopback only. The identity headers are trusted because only Caddy can
 * reach this port; binding anything wider would let anyone forge them. */
const HOST = process.env.HOST ?? '127.0.0.1';
const FRONT_DOOR_URL = process.env.CONFORZA_URL ?? 'http://localhost:5177';

const db = openDatabase(process.env.SOKKERLIGA_DB ?? undefined);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

const send = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
};

async function handleApi(req, res, url) {
  const path = url.pathname;

  /* Open: Caddy lets the health probe through without asking the front door,
   * so a deploy can be verified without an account. */
  if (path === '/api/health' && req.method === 'GET') {
    return send(res, 200, { status: 'ok', version: VERSION });
  }

  const person = identityFrom(req.headers);
  if (!person) return send(res, 401, { error: 'Please sign in.' });
  recordVisit(db, person);

  if (path === '/api/me' && req.method === 'GET') {
    return send(res, 200, { user: person, frontDoor: FRONT_DOOR_URL });
  }

  return send(res, 404, { error: 'No such endpoint.' });
}

async function serveStatic(res, pathname) {
  if (!existsSync(DIST)) {
    return send(res, 404, { error: 'The UI has not been built. Run npm run build, or npm run dev.' });
  }
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, safe === '/' ? 'index.html' : safe);
  if (!file.startsWith(DIST) || !existsSync(file)) file = join(DIST, 'index.html');
  const body = await readFile(file);
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(body);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(res, url.pathname);
  } catch (error) {
    if (error instanceof ValidationError) return send(res, error.status, { error: error.message });
    console.error(error);
    return send(res, 500, { error: 'Something went wrong on the server.' });
  }
}).listen(PORT, HOST, () => {
  console.log(`SokkerLiga API listening on http://${HOST}:${PORT}`);
});

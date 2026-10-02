/* SokkerLiga API server.
 *
 * No dependencies: node:http and node:sqlite only. Sign-in is the Conforza
 * front door's job — see server/identity.mjs. This process only reads the
 * database and records requests; every provider call happens in the worker
 * (server/worker.mjs), so a slow provider never holds up a page.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, ValidationError } from './db.mjs';
import { identityFrom, recordVisit } from './identity.mjs';
import {
  dashboard, listMatches, matchCenter, teamProfile, playerProfile, listPlayers, listTeams,
  listCompetitions, competitionDetail, setCompetitionEnabled, search, favourites, setFavourite, matchPlayers,
  leagueCatalog, enableFromCatalog,
} from './queries.mjs';
import { syncStatus, requestRun } from './jobs.mjs';
import {
  listSportsbooks, saveSportsbook, createBet, updateBet, deleteBet, correctSettlement, listBets, getBet, bettingHistory,
  setClosingOdds, useCalculatedResult,
} from './bets.mjs';
import { performance } from './performance.mjs';
import { bracket, bracketCompetitions } from './brackets.mjs';
import { bankroll, saveBankrollSettings, addLedgerEntry } from './bankroll.mjs';
import { ask } from './ask.mjs';
import { defaultQuestionParser } from './ai/questions.mjs';
import {
  requestAnalysis, analysisForMatch, listPredictions, thresholdsFor, setThresholds, featureSnapshot,
} from './analysis.mjs';
import { VERSION } from '../src/version.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist');
const PORT = Number(process.env.PORT ?? 5176);
/* Loopback only. The identity headers are trusted because only Caddy can
 * reach this port; binding anything wider would let anyone forge them. */
const HOST = process.env.HOST ?? '127.0.0.1';
const FRONT_DOOR_URL = process.env.CONFORZA_URL ?? 'http://localhost:5177';

const db = openDatabase(process.env.SOKKERLIGA_DB ?? undefined);
const questionParser = defaultQuestionParser();

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
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
};

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw new ValidationError('That request is too large.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('The request body is not valid JSON.');
  }
}

const notFound = (res, what) => send(res, 404, { error: `That ${what} does not exist.` });

async function handleApi(req, res, url) {
  const path = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  const method = req.method;

  /* Open: Caddy lets the health probe through without asking the front door,
   * so a deploy can be verified without an account. */
  if (path === '/api/health' && method === 'GET') {
    return send(res, 200, { status: 'ok', version: VERSION });
  }

  const person = identityFrom(req.headers);
  if (!person) return send(res, 401, { error: 'Please sign in.' });
  recordVisit(db, person);

  if (path === '/api/me' && method === 'GET') {
    return send(res, 200, { user: person, frontDoor: FRONT_DOOR_URL, favourites: favourites(db, person.id) });
  }

  if (path === '/api/dashboard' && method === 'GET') {
    return send(res, 200, dashboard(db, person.id, { dayStart: q.dayStart, dayEnd: q.dayEnd }));
  }

  if (path === '/api/search' && method === 'GET') return send(res, 200, search(db, q.q));

  if (path === '/api/matches' && method === 'GET') {
    return send(res, 200, listMatches(db, { ...q, userId: person.id, favouritesOnly: q.favourites === '1' }));
  }

  let m = path.match(/^\/api\/matches\/(\d+)$/);
  if (m && method === 'GET') {
    const result = matchCenter(db, m[1]);
    return result ? send(res, 200, result) : notFound(res, 'match');
  }

  m = path.match(/^\/api\/matches\/(\d+)\/players$/);
  if (m && method === 'GET') return send(res, 200, matchPlayers(db, m[1]));

  m = path.match(/^\/api\/matches\/(\d+)\/analysis$/);
  if (m && method === 'GET') return send(res, 200, analysisForMatch(db, m[1]));
  m = path.match(/^\/api\/matches\/(\d+)\/analyze$/);
  if (m && method === 'POST') return send(res, 202, requestAnalysis(db, m[1], person.id));
  m = path.match(/^\/api\/analysis-runs\/(\d+)\/snapshot$/);
  if (m && method === 'GET') {
    const snap = featureSnapshot(db, m[1]);
    return snap ? send(res, 200, snap) : notFound(res, 'snapshot');
  }

  if (path === '/api/predictions' && method === 'GET') {
    return send(res, 200, listPredictions(db, { ...q, includeSuperseded: q.includeSuperseded === '1' }));
  }
  if (path === '/api/settings/thresholds' && method === 'GET') return send(res, 200, thresholdsFor(db, person.id));
  if (path === '/api/settings/thresholds' && method === 'PUT') {
    return send(res, 200, setThresholds(db, person.id, await readJson(req)));
  }
  if (path === '/api/market-types' && method === 'GET') {
    return send(res, 200, db.prepare('SELECT key, name, family, description FROM market_types ORDER BY ordinal').all());
  }

  /* Betting apps, bets, settlement and history. */
  if (path === '/api/sportsbooks' && method === 'GET') return send(res, 200, listSportsbooks(db));
  if (path === '/api/sportsbooks' && method === 'POST') return send(res, 200, saveSportsbook(db, await readJson(req)));
  m = path.match(/^\/api\/sportsbooks\/([a-z0-9-]+)$/);
  if (m && method === 'PUT') return send(res, 200, saveSportsbook(db, { ...(await readJson(req)), key: m[1] }));

  if (path === '/api/bets' && method === 'GET') return send(res, 200, listBets(db, person.id, q));
  if (path === '/api/bets' && method === 'POST') return send(res, 201, createBet(db, person.id, await readJson(req)));
  m = path.match(/^\/api\/bets\/(\d+)$/);
  if (m && method === 'GET') {
    const bet = getBet(db, m[1], person.id);
    return bet ? send(res, 200, bet) : notFound(res, 'bet');
  }
  if (m && method === 'PUT') return send(res, 200, updateBet(db, person.id, m[1], await readJson(req)));
  if (m && method === 'DELETE') {
    deleteBet(db, person.id, m[1]);
    return send(res, 200, { ok: true });
  }
  m = path.match(/^\/api\/bets\/(\d+)\/settlements$/);
  if (m && method === 'POST') return send(res, 200, correctSettlement(db, person.id, m[1], await readJson(req)));
  m = path.match(/^\/api\/bets\/(\d+)\/calculated$/);
  if (m && method === 'POST') return send(res, 200, useCalculatedResult(db, person.id, m[1]));
  m = path.match(/^\/api\/bets\/(\d+)\/legs\/(\d+)\/closing$/);
  if (m && method === 'PUT') {
    const body = await readJson(req);
    return send(res, 200, setClosingOdds(db, person.id, m[1], m[2], body.closingOdds));
  }
  if (path === '/api/history' && method === 'GET') return send(res, 200, bettingHistory(db, person.id, q));

  /* Phase 4 and 5 */
  if (path === '/api/performance' && method === 'GET') return send(res, 200, performance(db, q));
  if (path === '/api/bankroll' && method === 'GET') return send(res, 200, bankroll(db, person.id));
  if (path === '/api/bankroll/settings' && method === 'PUT') {
    return send(res, 200, saveBankrollSettings(db, person.id, await readJson(req)));
  }
  if (path === '/api/bankroll/ledger' && method === 'POST') {
    return send(res, 200, addLedgerEntry(db, person.id, await readJson(req)));
  }
  if (path === '/api/ask' && method === 'POST') {
    const body = await readJson(req);
    try {
      return send(res, 200, await ask(db, person.id, body.question, questionParser));
    } catch (error) {
      if (error.status === 'failed' || error.status === 'refused') return send(res, 502, { error: error.message });
      throw error;
    }
  }

  if (path === '/api/teams' && method === 'GET') return send(res, 200, listTeams(db, q));
  m = path.match(/^\/api\/teams\/(\d+)$/);
  if (m && method === 'GET') {
    const result = teamProfile(db, m[1]);
    return result ? send(res, 200, result) : notFound(res, 'team');
  }

  if (path === '/api/players' && method === 'GET') return send(res, 200, listPlayers(db, q));
  m = path.match(/^\/api\/players\/(\d+)$/);
  if (m && method === 'GET') {
    const result = playerProfile(db, m[1]);
    return result ? send(res, 200, result) : notFound(res, 'player');
  }

  if (path === '/api/competitions' && method === 'GET') return send(res, 200, listCompetitions(db));
  if (path === '/api/league-catalog' && method === 'GET') return send(res, 200, leagueCatalog(db));
  if (path === '/api/brackets' && method === 'GET') return send(res, 200, bracketCompetitions(db));
  m = path.match(/^\/api\/competitions\/(\d+)\/bracket$/);
  if (m && method === 'GET') return send(res, 200, bracket(db, m[1], q.season));
  if (path === '/api/competitions' && method === 'POST') {
    const body = await readJson(req);
    enableFromCatalog(db, body.apiFootballId);
    for (const job of ['sync_competitions', 'sync_teams', 'sync_fixtures', 'sync_standings', 'sync_squads']) requestRun(db, job);
    return send(res, 200, listCompetitions(db));
  }
  m = path.match(/^\/api\/competitions\/(\d+)$/);
  if (m && method === 'GET') {
    const result = competitionDetail(db, m[1], q.season);
    return result ? send(res, 200, result) : notFound(res, 'competition');
  }
  if (m && method === 'PATCH') {
    const body = await readJson(req);
    setCompetitionEnabled(db, m[1], !!body.isEnabled);
    /* A competition switched on gets its season, teams, fixtures, table and
     * squads on the worker's next pass, rather than over the next week. */
    if (body.isEnabled) for (const job of ['sync_competitions', 'sync_teams', 'sync_fixtures', 'sync_standings', 'sync_squads']) requestRun(db, job);
    return send(res, 200, listCompetitions(db));
  }

  m = path.match(/^\/api\/favourites\/(competition|team)\/(\d+)$/);
  if (m && (method === 'PUT' || method === 'DELETE')) {
    return send(res, 200, setFavourite(db, person.id, m[1], m[2], method === 'PUT'));
  }

  if (path === '/api/sync' && method === 'GET') return send(res, 200, syncStatus(db));
  m = path.match(/^\/api\/sync\/([a-z_]+)\/run$/);
  if (m && method === 'POST') {
    if (!requestRun(db, m[1])) return notFound(res, 'job');
    return send(res, 202, syncStatus(db));
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

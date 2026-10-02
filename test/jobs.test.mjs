import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { runJob, dueJobs, requestRun, syncStatus, retryFailedNow } from '../server/jobs.mjs';
import { fakeProvider, fixture } from './fixtures/api-football.mjs';
import { ProviderError } from '../server/providers/api-football.mjs';

let db;
beforeEach(() => {
  db = openDatabase(':memory:');
  /* One competition keeps the call counts readable. */
  db.prepare("UPDATE competitions SET is_enabled = CASE key WHEN 'premier-league' THEN 1 ELSE 0 END").run();
});

const count = (table, where = '1=1', ...args) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;

describe('Data-refresh jobs', () => {
  test('every job is due on a fresh database, in order, except the manual backfill', () => {
    assert.deepEqual(dueJobs(db), ['sync_competitions', 'sync_teams', 'sync_fixtures', 'sync_results',
      'sync_standings', 'sync_squads', 'sync_players', 'sync_injuries']);
  });

  test('competitions → teams → fixtures → standings builds the season', async () => {
    const provider = fakeProvider();
    const opts = { providerFactory: () => provider };
    const run = await runJob(db, 'sync_competitions', opts);
    assert.equal(run.status, 'ok');
    assert.equal(count('seasons'), 2);
    assert.equal((await runJob(db, 'sync_teams', opts)).status, 'ok');
    assert.equal(count('teams'), 2);
    assert.equal(count('venues'), 2);
    assert.equal((await runJob(db, 'sync_fixtures', opts)).status, 'ok');
    assert.equal(count('matches'), 1);
    assert.equal((await runJob(db, 'sync_standings', opts)).status, 'ok');
    assert.equal(count('standings'), 2);
    assert.deepEqual(provider.calls.map((c) => c[0]), ['leagues', 'teams', 'fixtures', 'standings']);
  });

  test('a job run is logged with counts, and schedules its next run', async () => {
    const opts = { providerFactory: () => fakeProvider() };
    const run = await runJob(db, 'sync_competitions', opts);
    assert.equal(run.records_in, 1);
    assert.equal(run.records_written, 2);
    assert.ok(run.finished_at);
    const job = db.prepare("SELECT * FROM jobs WHERE key = 'sync_competitions'").get();
    assert.equal(job.locked_until, null);
    assert.ok(Date.parse(job.next_run_at) > Date.now() + 6 * 86400_000);
    assert.equal(dueJobs(db).includes('sync_competitions'), false);
  });

  test('fixtures before a season exists is reported, not crashed', async () => {
    const run = await runJob(db, 'sync_fixtures', { providerFactory: () => fakeProvider() });
    assert.equal(run.status, 'failed');
    assert.match(run.message, /no current season/);
  });

  test('a missing key fails the run with a clear message and makes no requests', async () => {
    const saved = process.env.API_FOOTBALL_KEY;
    delete process.env.API_FOOTBALL_KEY;
    const run = await runJob(db, 'sync_competitions');
    process.env.API_FOOTBALL_KEY = saved ?? '';
    if (saved === undefined) delete process.env.API_FOOTBALL_KEY;
    assert.equal(run.status, 'failed');
    assert.match(run.message, /No API-Football key/);
    assert.equal(run.requests_used, 0);
  });

  test('a failed job retries within 15 minutes, and at once after a worker restart', async () => {
    const saved = process.env.API_FOOTBALL_KEY;
    delete process.env.API_FOOTBALL_KEY;
    await runJob(db, 'sync_competitions');
    if (saved !== undefined) process.env.API_FOOTBALL_KEY = saved;
    const next = Date.parse(db.prepare("SELECT next_run_at FROM jobs WHERE key = 'sync_competitions'").get().next_run_at);
    assert.ok(next <= Date.now() + 15 * 60_000 + 1000, 'not a week away');
    assert.equal(dueJobs(db).includes('sync_competitions'), false);
    assert.equal(retryFailedNow(db), 1);
    assert.equal(dueJobs(db).includes('sync_competitions'), true);
  });

  test('a plan refusal stops the job at the first competition and waits six hours', async () => {
    db.prepare("UPDATE competitions SET is_enabled = 1 WHERE key IN ('premier-league', 'la-liga')").run();
    const opts0 = { providerFactory: () => fakeProvider() };
    await runJob(db, 'sync_competitions', opts0);
    const provider = fakeProvider({ teams: () => {
      throw new ProviderError('API-Football: Free plans do not have access to this season.', { fatal: true });
    } });
    const run = await runJob(db, 'sync_teams', { providerFactory: () => provider });
    assert.equal(run.status, 'failed');
    assert.equal(provider.calls.filter((c) => c[0] === 'teams').length, 1, 'La Liga is not asked');
    assert.equal(JSON.parse(run.errors_json).length, 1);
    const next = Date.parse(db.prepare("SELECT next_run_at FROM jobs WHERE key = 'sync_teams'").get().next_run_at);
    assert.ok(next > Date.now() + 5 * 3600_000 && next <= Date.now() + 6 * 3600_000 + 1000);
  });

  test('one failing competition does not stop the others', async () => {
    db.prepare("UPDATE competitions SET is_enabled = 1 WHERE key IN ('premier-league', 'la-liga')").run();
    const provider = fakeProvider({ leagues: (id) => {
      if (id === 140) throw new Error('boom');
      return [{ league: { id, name: 'X' }, country: {}, seasons: [{ year: 2026, start: '2026-08-01', end: '2027-05-30', current: true }] }];
    } });
    const run = await runJob(db, 'sync_competitions', { providerFactory: () => provider });
    assert.equal(run.status, 'partial');
    assert.match(JSON.parse(run.errors_json)[0], /La Liga: boom/);
    assert.equal(count('seasons'), 1);
  });

  test('results: a match that just finished gets its details in one batched request', async () => {
    const kickoff = new Date(Date.now() - 4 * 3600_000).toISOString();
    const provider = fakeProvider({
      fixtures: [fixture({ date: kickoff })],
      fixturesByIds: (ids) => ids.map((id) => fixture({ id: Number(id), date: kickoff, status: 'FT',
        goals: { home: 2, away: 0 }, halftime: { home: 1, away: 0 }, details: true })),
    });
    const opts = { providerFactory: () => provider };
    await runJob(db, 'sync_competitions', opts);
    await runJob(db, 'sync_fixtures', opts);
    const run = await runJob(db, 'sync_results', opts);
    assert.equal(run.status, 'ok');
    const m = db.prepare('SELECT * FROM matches').get();
    assert.equal(m.status_key, 'finished');
    assert.equal(m.home_goals, 2);
    assert.ok(m.details_fetched_at);
    assert.ok(m.result_confirmed_at, 'seen four hours after kickoff, so confirmed');
    assert.equal(count('match_events'), 3);
    assert.equal(provider.calls.filter((c) => c[0] === 'fixturesByIds').length, 1);
  });

  test('results: nothing to do means no requests', async () => {
    const provider = fakeProvider();
    const run = await runJob(db, 'sync_results', { providerFactory: () => provider });
    assert.equal(run.status, 'ok');
    assert.match(run.message, /Nothing live/);
    assert.equal(provider.calls.length, 0);
  });

  test('backfill fetches earlier seasons; their details come through the results backlog', async () => {
    const provider = fakeProvider({
      fixtures: (leagueId, season) => [fixture({ id: season * 10, season, date: `${season}-09-01T14:00:00+00:00`,
        status: season < 2026 ? 'FT' : 'NS', goals: season < 2026 ? { home: 1, away: 1 } : { home: null, away: null } })],
    });
    const opts = { providerFactory: () => provider };
    await runJob(db, 'sync_competitions', opts);
    const run = await runJob(db, 'backfill_history', opts);
    assert.equal(run.status, 'ok');
    assert.equal(count('matches'), 1, 'the fake league has one earlier season');
    assert.equal(db.prepare('SELECT source_ref FROM matches').get().source_ref, '20250');
    await runJob(db, 'sync_results', opts);
    assert.ok(db.prepare('SELECT details_fetched_at FROM matches').get().details_fetched_at);
  });

  test('a held lock keeps a second run out', async () => {
    db.prepare("UPDATE jobs SET locked_until = ? WHERE key = 'sync_teams'").run(new Date(Date.now() + 60_000).toISOString());
    assert.equal(await runJob(db, 'sync_teams', { providerFactory: () => fakeProvider() }), null);
    assert.equal(dueJobs(db).includes('sync_teams'), false);
  });

  test('"Run now" makes even the manual backfill due, once', async () => {
    assert.equal(dueJobs(db).includes('backfill_history'), false);
    requestRun(db, 'backfill_history');
    assert.equal(dueJobs(db).includes('backfill_history'), true);
    await runJob(db, 'backfill_history', { providerFactory: () => fakeProvider() });
    assert.equal(dueJobs(db).includes('backfill_history'), false);
  });

  test('sync status reports each job with its last run and last success', async () => {
    await runJob(db, 'sync_competitions', { providerFactory: () => fakeProvider() });
    const status = syncStatus(db);
    const comp = status.jobs.find((j) => j.key === 'sync_competitions');
    assert.equal(comp.lastRun.status, 'ok');
    assert.ok(comp.lastSuccessAt);
    assert.ok(comp.nextRunAt);
    assert.equal(status.jobs.find((j) => j.key === 'sync_teams').lastRun, null);
  });
});

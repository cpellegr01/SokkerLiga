import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { openDatabase } from '../server/db.mjs';
import {
  createClient, ProviderError, statusKey, eventTypeKey, statValue, seasonLabel, heightCm,
  normaliseLeague, normaliseFixture, normaliseStandings, normaliseSquad, normalisePlayerProfile, normaliseInjury,
} from '../server/providers/api-football.mjs';
import { league, fixture, standingsFor, squad, profile, injury, envelope } from './fixtures/api-football.mjs';

describe('Normalising API-Football responses', () => {
  test('status codes map onto our statuses', () => {
    assert.equal(statusKey('NS'), 'scheduled');
    assert.equal(statusKey('HT'), 'live');
    assert.equal(statusKey('AET'), 'finished');
    assert.equal(statusKey('PEN'), 'finished');
    assert.equal(statusKey('PST'), 'postponed');
    assert.equal(statusKey('WO'), 'awarded');
  });

  test('event types are classified, penalties and own goals included', () => {
    assert.equal(eventTypeKey('Goal', 'Normal Goal'), 'goal');
    assert.equal(eventTypeKey('Goal', 'Own Goal'), 'own_goal');
    assert.equal(eventTypeKey('Goal', 'Penalty'), 'penalty_goal');
    assert.equal(eventTypeKey('Goal', 'Missed Penalty'), 'missed_penalty');
    assert.equal(eventTypeKey('Card', 'Second Yellow card'), 'second_yellow');
    assert.equal(eventTypeKey('Card', 'Red Card'), 'red');
    assert.equal(eventTypeKey('subst', 'Substitution 1'), 'sub');
    assert.equal(eventTypeKey('Var', 'Goal cancelled'), 'var');
  });

  test('statistic values become numbers', () => {
    assert.equal(statValue('64%'), 64);
    assert.equal(statValue('2.41'), 2.41);
    assert.equal(statValue(7), 7);
    assert.equal(statValue(null), null);
    assert.equal(statValue('n/a'), null);
  });

  test('season labels follow the calendar', () => {
    assert.equal(seasonLabel(2026, '2026-08-15', '2027-05-24'), '2026/27');
    assert.equal(seasonLabel(2026, '2026-02-21', '2026-12-06'), '2026');
    assert.equal(heightCm('181 cm'), 181);
    assert.equal(heightCm(''), null);
  });

  test('a league carries its seasons and coverage', () => {
    const l = normaliseLeague(league());
    assert.equal(l.sourceRef, '39');
    assert.equal(l.seasons.length, 2);
    assert.equal(l.seasons.find((s) => s.current).label, '2026/27');
    assert.equal(l.seasons[0].coverage.injuries, true);
  });

  test('a scheduled fixture has no details and no score', () => {
    const f = normaliseFixture(fixture());
    assert.equal(f.sourceRef, '592872');
    assert.equal(f.statusKey, 'scheduled');
    assert.equal(f.kickoffUtc, '2026-10-04T14:00:00.000Z');
    assert.equal(f.homeGoals, null);
    assert.equal(f.details, null);
    assert.equal(f.round, 'Regular Season - 7');
  });

  test('a fixture fetched by id carries events, lineups and statistics', () => {
    const f = normaliseFixture(fixture({ status: 'FT', goals: { home: 2, away: 0 }, details: true }));
    assert.equal(f.statusKey, 'finished');
    assert.equal(f.homeGoals, 2);
    assert.deepEqual(f.details.events.map((e) => e.typeKey), ['goal', 'yellow', 'penalty_goal']);
    assert.equal(f.details.events[0].assist.name, 'Phil Foden');
    assert.equal(f.details.events[1].assist, null);
    assert.equal(f.details.events[2].extraMinute, 3);
    assert.equal(f.details.lineups.length, 2);
    assert.equal(f.details.lineups[0].players.filter((p) => p.role === 'starter').length, 11);
    assert.equal(f.details.lineups[1].coach.name, 'C. Ancelotti');
    const city = f.details.teamStats.find((s) => s.teamRef === '50');
    assert.equal(city.stats.find((s) => s.label === 'Ball Possession').value, 64);
    assert.equal(city.stats.find((s) => s.label === 'expected_goals').value, 2.41);
    const kdb = f.details.playerStats.find((p) => p.player.name === 'Kevin De Bruyne');
    assert.equal(kdb.goals, 1);
    assert.equal(kdb.shotsOnTarget, 2);
    assert.equal(kdb.passAccuracy, 68);
  });

  test('a round given as a number is kept as text', () => {
    const item = fixture();
    item.league.round = 1;
    assert.equal(normaliseFixture(item).round, '1');
  });

  test('standings, squads, profiles and injuries', () => {
    const s = normaliseStandings(standingsFor());
    assert.equal(s.rows.length, 2);
    assert.equal(s.rows[0].groupName, '');
    assert.equal(s.rows[0].home.won, 2);
    assert.equal(normaliseSquad(squad()).players[0].shirtNumber, 17);
    const p = normalisePlayerProfile(profile());
    assert.equal(p.birthDate, '1991-06-28');
    assert.equal(p.heightCm, 181);
    assert.equal(normaliseInjury(injury()).status, 'missing');
    assert.equal(normaliseInjury(injury({ type: 'Questionable' })).status, 'doubtful');
  });
});

describe('The API-Football client', () => {
  const response = (body, { status = 200, headers = {} } = {}) => ({
    status, ok: status >= 200 && status < 300,
    headers: new Headers({ 'x-ratelimit-requests-limit': '7500', 'x-ratelimit-requests-remaining': '7400', ...headers }),
    text: async () => JSON.stringify(body),
  });

  test('refuses to start without a key', () => {
    assert.throws(() => createClient({ db: openDatabase(':memory:'), apiKey: '' }), /No API-Football key/);
  });

  test('sends the key, stores the raw response and counts quota', async () => {
    const db = openDatabase(':memory:');
    let seen;
    const client = createClient({ db, apiKey: 'k', minIntervalMs: 0, fetchImpl: async (url, init) => {
      seen = { url: String(url), key: init.headers['x-apisports-key'] };
      return response(envelope('leagues', [league()]));
    } });
    const { items } = await client.leagues(39);
    assert.equal(items.length, 1);
    assert.equal(seen.key, 'k');
    assert.match(seen.url, /\/leagues\?id=39$/);
    const raw = db.prepare('SELECT * FROM raw_payloads').get();
    assert.equal(raw.endpoint, '/leagues');
    assert.equal(JSON.parse(gunzipSync(raw.body_gz).toString()).get, 'leagues');
    const quota = db.prepare('SELECT * FROM provider_quota').get();
    assert.equal(quota.requests_used, 1);
    assert.equal(quota.remaining, 7400);
    assert.equal(client.requestsUsed, 1);
  });

  test('an error object inside a 200 response is an error', async () => {
    const db = openDatabase(':memory:');
    const client = createClient({ db, apiKey: 'k', minIntervalMs: 0, fetchImpl: async () =>
      response(envelope('fixtures', [], { errors: { plan: 'Free plans do not have access to this season.' } })) });
    await assert.rejects(() => client.fixtures(39, 2026),
      (e) => e instanceof ProviderError && /Free plans/.test(e.message) && e.fatal === true);
  });

  test('a refused key is reported plainly', async () => {
    const db = openDatabase(':memory:');
    const client = createClient({ db, apiKey: 'bad', minIntervalMs: 0, fetchImpl: async () => response({}, { status: 401 }) });
    await assert.rejects(() => client.leagues(39), /refused the key/);
  });

  test('follows every page of a paged endpoint', async () => {
    const db = openDatabase(':memory:');
    const client = createClient({ db, apiKey: 'k', minIntervalMs: 0, fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get('page') ?? 1);
      return response(envelope('injuries', [injury({ playerId: page })], { paging: { current: page, total: 3 } }));
    } });
    const { items } = await client.injuries(39, 2026);
    assert.deepEqual(items.map((i) => i.player.id), [1, 2, 3]);
  });

  test('stops when the provider says the daily quota is gone', async () => {
    const db = openDatabase(':memory:');
    let calls = 0;
    const client = createClient({ db, apiKey: 'k', minIntervalMs: 0, fetchImpl: async () => {
      calls += 1;
      return response(envelope('leagues', [league()]), { headers: { 'x-ratelimit-requests-remaining': '0' } });
    } });
    await client.leagues(39);
    await assert.rejects(() => client.leagues(39), /quota is used up/);
    assert.equal(calls, 1);
  });
});

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db.mjs';
import {
  normaliseLeague, normaliseFixture, normaliseStandings, normaliseSquad, normaliseInjury, SOURCE_KEY,
} from '../server/providers/api-football.mjs';
import {
  importLeague, importFixture, importFixtureDetails, importStandings, importSquad, importInjuries,
} from '../server/ingest.mjs';
import { league, fixture, standingsFor, squad, injury } from './fixtures/api-football.mjs';

let db;
let seasonId;
const T0 = '2026-10-01T09:00:00.000Z';
const LATER = '2026-10-04T20:00:00.000Z';

beforeEach(() => {
  db = openDatabase(':memory:');
  const competitionId = db.prepare("SELECT id FROM competitions WHERE key = 'premier-league'").get().id;
  importLeague(db, competitionId, normaliseLeague(league()), T0);
  seasonId = db.prepare('SELECT id FROM seasons WHERE competition_id = ? AND is_current = 1').get(competitionId).id;
});

const count = (table, where = '1=1', ...args) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;

describe('Seed data', () => {
  test('the eight competitions are seeded with their provider ids', () => {
    const rows = db.prepare('SELECT key, api_football_id FROM competitions ORDER BY ordinal').all();
    assert.equal(rows.length, 8);
    assert.equal(rows.find((r) => r.key === 'premier-league').api_football_id, 39);
    assert.equal(rows.find((r) => r.key === 'mls').api_football_id, 253);
  });

  test('re-opening keeps a competition switched off in Settings switched off', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sokkerliga-'));
    const path = join(dir, 'test.db');
    const first = openDatabase(path);
    first.prepare("UPDATE competitions SET is_enabled = 0 WHERE key = 'mls'").run();
    first.close();
    const second = openDatabase(path);
    assert.equal(second.prepare("SELECT is_enabled FROM competitions WHERE key = 'mls'").get().is_enabled, 0);
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Importing fixtures', () => {
  test('creates the match, both teams, the venue and the provenance', () => {
    const r = importFixture(db, SOURCE_KEY, seasonId, normaliseFixture(fixture()), T0);
    assert.ok(r.created);
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(r.id);
    assert.equal(m.status_key, 'scheduled');
    assert.equal(m.source_ref, '592872');
    assert.equal(m.fetched_at, T0);
    assert.equal(count('teams'), 2);
    assert.equal(count('season_teams'), 2);
    assert.equal(count('external_ids', "entity_type = 'match'"), 1);
  });

  test('importing the same fixture twice changes nothing and records no revision', () => {
    importFixture(db, SOURCE_KEY, seasonId, normaliseFixture(fixture()), T0);
    const r = importFixture(db, SOURCE_KEY, seasonId, normaliseFixture(fixture()), T0);
    assert.equal(r.changed, false);
    assert.equal(count('matches'), 1);
    assert.equal(count('match_revisions'), 0);
  });

  test('a moved kickoff keeps the old time as a revision', () => {
    const { id } = importFixture(db, SOURCE_KEY, seasonId, normaliseFixture(fixture()), T0);
    importFixture(db, SOURCE_KEY, seasonId, normaliseFixture(fixture({ date: '2026-10-05T16:30:00+00:00' })), LATER);
    const rev = db.prepare('SELECT * FROM match_revisions WHERE match_id = ?').get(id);
    assert.equal(rev.fields, 'kickoff_utc');
    assert.equal(JSON.parse(rev.old_json).kickoff_utc, '2026-10-04T14:00:00.000Z');
    assert.equal(db.prepare('SELECT kickoff_utc FROM matches WHERE id = ?').get(id).kickoff_utc, '2026-10-05T16:30:00.000Z');
  });

  test('a result is confirmed only once seen three hours after kickoff', () => {
    const done = fixture({ status: 'FT', goals: { home: 2, away: 0 } });
    const { id } = importFixture(db, SOURCE_KEY, seasonId, normaliseFixture(done), '2026-10-04T16:00:00.000Z');
    assert.equal(db.prepare('SELECT result_confirmed_at FROM matches WHERE id = ?').get(id).result_confirmed_at, null);
    importFixture(db, SOURCE_KEY, seasonId, normaliseFixture(done), '2026-10-04T17:30:00.000Z');
    assert.equal(db.prepare('SELECT result_confirmed_at FROM matches WHERE id = ?').get(id).result_confirmed_at,
      '2026-10-04T17:30:00.000Z');
  });

  test('a corrected score after confirmation is kept as a revision and re-confirmed', () => {
    const { id } = importFixture(db, SOURCE_KEY, seasonId,
      normaliseFixture(fixture({ status: 'FT', goals: { home: 2, away: 0 } })), LATER);
    importFixture(db, SOURCE_KEY, seasonId,
      normaliseFixture(fixture({ status: 'FT', goals: { home: 2, away: 1 } })), '2026-10-05T09:00:00.000Z');
    const rev = db.prepare('SELECT * FROM match_revisions WHERE match_id = ?').get(id);
    assert.match(rev.fields, /away_goals/);
    assert.equal(JSON.parse(rev.old_json).away_goals, 0);
    const m = db.prepare('SELECT away_goals, result_confirmed_at FROM matches WHERE id = ?').get(id);
    assert.equal(m.away_goals, 1);
    assert.equal(m.result_confirmed_at, '2026-10-05T09:00:00.000Z');
  });
});

describe('Importing match details', () => {
  const finished = () => normaliseFixture(fixture({ status: 'FT', goals: { home: 2, away: 0 }, details: true }));

  test('stores events, lineups, team and player statistics, and the managers', () => {
    const f = finished();
    const { id } = importFixture(db, SOURCE_KEY, seasonId, f, LATER);
    importFixtureDetails(db, SOURCE_KEY, id, f.details, LATER);
    assert.equal(count('match_events', 'match_id = ?', id), 3);
    assert.equal(count('lineups', 'match_id = ?', id), 2);
    assert.equal(count('lineup_players', "match_id = ? AND role = 'starter'", id), 22);
    const xg = db.prepare(`SELECT s.value FROM team_match_stats s JOIN teams t ON t.id = s.team_id
                           WHERE s.match_id = ? AND s.stat_key = 'xg' AND t.name = 'Everton'`).get(id);
    assert.equal(xg.value, 0.58);
    assert.equal(count('player_match_stats', 'match_id = ?', id), 2);
    assert.equal(count('team_managers', 'valid_to IS NULL'), 2);
    assert.ok(db.prepare('SELECT details_fetched_at FROM matches WHERE id = ?').get(id).details_fetched_at);
  });

  test('a statistic the seed does not know is kept under its own label', () => {
    const f = finished();
    const { id } = importFixture(db, SOURCE_KEY, seasonId, f, LATER);
    importFixtureDetails(db, SOURCE_KEY, id, f.details, LATER);
    assert.equal(db.prepare("SELECT key FROM stat_types WHERE provider_label = 'Brand New Stat'").get().key, 'brand_new_stat');
  });

  test('re-importing identical details records no revisions', () => {
    const f = finished();
    const { id } = importFixture(db, SOURCE_KEY, seasonId, f, LATER);
    importFixtureDetails(db, SOURCE_KEY, id, f.details, LATER);
    importFixtureDetails(db, SOURCE_KEY, id, f.details, LATER);
    assert.equal(count('match_revisions'), 0);
    assert.equal(count('team_match_stats_revisions'), 0);
  });

  test('a corrected statistic and a changed event list keep their old versions', () => {
    const f = finished();
    const { id } = importFixture(db, SOURCE_KEY, seasonId, f, LATER);
    importFixtureDetails(db, SOURCE_KEY, id, f.details, LATER);
    const g = finished();
    g.details.teamStats[0].stats.find((s) => s.label === 'Corner Kicks').value = 10;
    g.details.events.pop();
    importFixtureDetails(db, SOURCE_KEY, id, g.details, '2026-10-05T09:00:00.000Z');
    const rev = db.prepare("SELECT * FROM team_match_stats_revisions WHERE stat_key = 'corners'").get();
    assert.equal(rev.old_value, 9);
    const events = db.prepare("SELECT old_json FROM match_revisions WHERE fields = 'events'").get();
    assert.equal(JSON.parse(events.old_json).length, 3);
    assert.equal(count('match_events', 'match_id = ?', id), 2);
  });
});

describe('Standings, squads and injuries', () => {
  test('standings are a dated series: an unchanged table adds nothing, a new update adds a set', () => {
    const rows = normaliseStandings(standingsFor()).rows;
    assert.equal(importStandings(db, SOURCE_KEY, seasonId, rows, T0), 2);
    assert.equal(importStandings(db, SOURCE_KEY, seasonId, rows, T0), 0);
    const later = normaliseStandings(standingsFor({ update: '2026-10-05T00:00:00+00:00' })).rows;
    assert.equal(importStandings(db, SOURCE_KEY, seasonId, later, LATER), 2);
    assert.equal(count('standings'), 4);
  });

  test('a player leaving the squad is closed, not deleted; a new number opens a new row', () => {
    importFixture(db, SOURCE_KEY, seasonId, normaliseFixture(fixture()), T0);
    const teamId = db.prepare("SELECT id FROM teams WHERE source_ref = '50'").get().id;
    importSquad(db, SOURCE_KEY, teamId, normaliseSquad(squad()).players, T0);
    assert.equal(count('team_rosters', 'valid_to IS NULL'), 2);
    importSquad(db, SOURCE_KEY, teamId,
      normaliseSquad(squad({ players: [[629, 'Kevin De Bruyne', 10, 'Midfielder']] })).players, LATER);
    assert.equal(count('team_rosters'), 3);
    assert.equal(count('team_rosters', 'valid_to IS NULL'), 1);
    assert.equal(db.prepare('SELECT shirt_number FROM team_rosters WHERE valid_to IS NULL').get().shirt_number, 10);
  });

  test('an empty squad answer does not empty the squad', () => {
    importFixture(db, SOURCE_KEY, seasonId, normaliseFixture(fixture()), T0);
    const teamId = db.prepare("SELECT id FROM teams WHERE source_ref = '50'").get().id;
    importSquad(db, SOURCE_KEY, teamId, normaliseSquad(squad()).players, T0);
    importSquad(db, SOURCE_KEY, teamId, [], LATER);
    assert.equal(count('team_rosters', 'valid_to IS NULL'), 2);
  });

  test('injuries attach to known matches and update in place', () => {
    importFixture(db, SOURCE_KEY, seasonId, normaliseFixture(fixture()), T0);
    assert.equal(importInjuries(db, SOURCE_KEY, [normaliseInjury(injury())], T0), 1);
    importInjuries(db, SOURCE_KEY, [normaliseInjury(injury({ type: 'Questionable' }))], LATER);
    const a = db.prepare('SELECT * FROM availability').get();
    assert.equal(a.status, 'doubtful');
    assert.equal(a.first_reported_at, T0);
    assert.equal(a.last_reported_at, LATER);
    assert.equal(importInjuries(db, SOURCE_KEY, [normaliseInjury(injury({ fixtureId: 999 }))], T0), 0);
  });
});

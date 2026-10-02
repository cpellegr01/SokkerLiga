import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { runJob } from '../server/jobs.mjs';
import {
  listMatches, matchCenter, teamProfile, playerProfile, competitionDetail, search, setFavourite,
  dashboard, listCompetitions, listTeams, listPlayers,
} from '../server/queries.mjs';
import { fakeProvider, fixture, squad } from './fixtures/api-football.mjs';

/* A small season: City v Everton played twice (2–0, then 1–1), and a third
 * meeting still to come. */
const DAY = 86400_000;
const at = (days) => new Date(Date.now() + days * DAY).toISOString().replace('.000Z', '+00:00');
const PLAYED_1 = fixture({ id: 1, date: at(-20), status: 'FT', goals: { home: 2, away: 0 }, halftime: { home: 1, away: 0 } });
const PLAYED_2 = fixture({ id: 2, date: at(-6), status: 'FT', home: { id: 45, name: 'Everton' },
  away: { id: 50, name: 'Manchester City' }, goals: { home: 1, away: 1 }, halftime: { home: 0, away: 1 } });
const UPCOMING = fixture({ id: 3, date: at(2) });

let db;
before(async () => {
  db = openDatabase(':memory:');
  db.prepare("UPDATE competitions SET is_enabled = CASE key WHEN 'premier-league' THEN 1 ELSE 0 END").run();
  const provider = fakeProvider({
    /* This season only; the backfill of earlier seasons finds nothing. */
    fixtures: (leagueId, season) => (season === 2026 ? [PLAYED_1, PLAYED_2, UPCOMING] : []),
    fixturesByIds: (ids) => ids.map((id) => {
      const base = [PLAYED_1, PLAYED_2].find((f) => f.fixture.id === Number(id));
      return fixture({ id: Number(id), date: base.fixture.date, status: 'FT', home: base.teams.home,
        away: base.teams.away, goals: base.goals, halftime: base.score.halftime, details: true });
    }),
    squad: (teamRef) => [String(teamRef) === '50' ? squad()
      : squad({ teamId: 45, players: [[2932, 'Abdoulaye Doucouré', 16, 'Midfielder']] })],
    injuries: [{ player: { id: 643, name: 'Gabriel Jesus', type: 'Missing Fixture', reason: 'Knee Injury' },
      team: { id: 50 }, fixture: { id: 3 }, league: { id: 39, season: 2026 } }],
  });
  const opts = { providerFactory: () => provider };
  for (const key of ['sync_competitions', 'sync_teams', 'sync_fixtures', 'sync_standings', 'sync_squads',
    'sync_players', 'sync_injuries', 'backfill_history']) {
    await runJob(db, key, opts);
  }
  /* sync_results' backlog pulls details for both finished matches. */
  await runJob(db, 'sync_results', opts);
});

const matchId = (ref) => db.prepare('SELECT id FROM matches WHERE source_ref = ?').get(String(ref)).id;
const teamId = (ref) => db.prepare('SELECT id FROM teams WHERE source_ref = ?').get(String(ref)).id;

describe('Read models', () => {
  test('the match list filters by date and marks favourites', () => {
    const upcoming = listMatches(db, { from: new Date().toISOString() });
    assert.deepEqual(upcoming.map((m) => m.id), [matchId(3)]);
    const userId = 'u1';
    setFavourite(db, userId, 'team', teamId(45), true);
    const all = listMatches(db, { userId });
    assert.equal(all.length, 3);
    assert.ok(all.every((m) => m.isFavourite));
    assert.equal(listMatches(db, { userId: 'someone-else', favouritesOnly: true }).length, 0);
    assert.equal(listMatches(db, { userId, favouritesOnly: true }).length, 3);
  });

  test('Match Center looks back from kickoff: form, head-to-head, availability', () => {
    const mc = matchCenter(db, matchId(3));
    assert.equal(mc.match.home.name, 'Manchester City');
    assert.equal(mc.home.form.form, 'DW', 'most recent first: the draw, then the win');
    assert.equal(mc.home.form.points, 4);
    assert.equal(mc.away.form.form, 'DL');
    assert.equal(mc.headToHead.summary.played, 2);
    assert.equal(mc.headToHead.summary.homeTeamWins, 1);
    assert.equal(mc.headToHead.summary.draws, 1);
    assert.equal(mc.headToHead.summary.bothScored, 1);
    assert.equal(mc.availability.length, 1);
    assert.equal(mc.availability[0].name, 'Gabriel Jesus');
    assert.ok(mc.home.restDays >= 7);
    const xg = mc.home.averages.find((a) => a.key === 'xg');
    assert.equal(xg.matches, 2);
    assert.ok(mc.home.keyPlayers.length >= 1);
  });

  test('an old Match Center does not see what happened after it', () => {
    const mc = matchCenter(db, matchId(1));
    assert.equal(mc.headToHead.summary.played, 0);
    assert.equal(mc.home.form.played, 0);
    assert.equal(mc.events.length, 3, 'its own events are shown');
  });

  test('team, player and competition pages', () => {
    const team = teamProfile(db, teamId(50));
    assert.equal(team.team.name, 'Manchester City');
    assert.equal(team.roster.length, 2);
    assert.equal(team.competitions[0].record.played, 2);
    assert.equal(team.upcoming.length, 1);
    assert.equal(team.manager.name, 'Guardiola');

    const kdb = db.prepare("SELECT id FROM players WHERE source_ref = '629'").get().id;
    const player = playerProfile(db, kdb);
    assert.equal(player.player.birthDate, '1991-06-28');
    assert.equal(player.player.heightCm, 181);
    assert.equal(player.teams[0].name, 'Manchester City');
    assert.equal(player.seasons[0].goals, 2);
    assert.equal(player.history.length, 2);

    const comp = competitionDetail(db, db.prepare("SELECT id FROM competitions WHERE key = 'premier-league'").get().id);
    assert.equal(comp.table.groups[0].rows.length, 2);
    assert.equal(comp.results.length, 2);
    assert.equal(comp.fixtures.length, 1);
  });

  test('search finds teams, players and their matches', () => {
    const r = search(db, 'evert');
    assert.equal(r.teams[0].name, 'Everton');
    assert.ok(r.matches.length >= 1);
    assert.match(search(db, 'Bruyne').players[0].name, /De Bruyne/);
    assert.deepEqual(search(db, 'e'), { teams: [], players: [], competitions: [], matches: [] });
  });

  test('lists and dashboard', () => {
    assert.equal(listCompetitions(db).length, 17);
    assert.equal(listTeams(db).length, 2);
    assert.equal(listPlayers(db, { q: 'Jesus' })[0].name, 'Gabriel Jesus');
    const d = dashboard(db, 'u1');
    assert.equal(d.recentResults.length, 0, 'nothing in the last three days');
    assert.ok(d.upcoming.length + d.today.length >= 1);
    assert.equal(d.counts.matchesWithDetails, 2);
  });
});

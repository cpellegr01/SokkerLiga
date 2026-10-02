/* Sample API-Football responses for tests.
 *
 * Built from real responses: lineups-592872.json and
 * player-statistics-sample.json are verbatim provider payloads (Manchester
 * City v Everton, fixture 592872); the rest follow the same documented
 * shapes. Builders take overrides so a test can change one field — a
 * kickoff, a score — and watch how the import reacts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const json = (name) => JSON.parse(readFileSync(join(HERE, name), 'utf8'));

export const LINEUPS = json('lineups-592872.json');
const PLAYER_STATS = json('player-statistics-sample.json');

export const envelope = (get, response, extra = {}) => ({
  get, parameters: {}, errors: [], results: response.length, paging: { current: 1, total: 1 }, response, ...extra,
});

export function league({ id = 39, name = 'Premier League', current = 2026 } = {}) {
  return {
    league: { id, name, type: 'League', logo: `https://media.api-sports.io/football/leagues/${id}.png` },
    country: { name: 'England', code: 'GB-ENG', flag: 'https://media.api-sports.io/flags/gb-eng.svg' },
    seasons: [current - 1, current].map((year) => ({
      year,
      start: `${year}-08-15`,
      end: `${year + 1}-05-24`,
      current: year === current,
      coverage: {
        fixtures: { events: true, lineups: true, statistics_fixtures: true, statistics_players: true },
        standings: true, players: true, injuries: true, predictions: true, odds: true,
      },
    })),
  };
}

export function team({ id = 50, name = 'Manchester City', venueId = 555 } = {}) {
  return {
    team: { id, name, code: name.slice(0, 3).toUpperCase(), country: 'England', founded: 1880, national: false,
      logo: `https://media.api-sports.io/football/teams/${id}.png` },
    venue: { id: venueId, name: `${name} Stadium`, address: 'Somewhere', city: 'Manchester', capacity: 55097,
      surface: 'grass', image: `https://media.api-sports.io/football/venues/${venueId}.png` },
  };
}

export function fixture({
  id = 592872, leagueId = 39, season = 2026, date = '2026-10-04T14:00:00+00:00', status = 'NS',
  home = { id: 50, name: 'Manchester City' }, away = { id: 45, name: 'Everton' },
  goals = { home: null, away: null }, halftime = { home: null, away: null }, referee = 'M. Oliver',
  round = 'Regular Season - 7', details = false,
} = {}) {
  const item = {
    fixture: {
      id, referee, timezone: 'UTC', date, timestamp: Math.floor(Date.parse(date) / 1000),
      periods: { first: null, second: null },
      venue: { id: 555, name: 'Etihad Stadium', city: 'Manchester' },
      status: { long: status, short: status, elapsed: status === 'FT' ? 90 : null, extra: null },
    },
    league: { id: leagueId, name: 'Premier League', country: 'England', logo: '', flag: '', season, round },
    teams: {
      home: { ...home, logo: `https://media.api-sports.io/football/teams/${home.id}.png`, winner: null },
      away: { ...away, logo: `https://media.api-sports.io/football/teams/${away.id}.png`, winner: null },
    },
    goals,
    score: { halftime, fulltime: status === 'FT' ? goals : { home: null, away: null },
      extratime: { home: null, away: null }, penalty: { home: null, away: null } },
  };
  if (details) {
    item.events = [
      { time: { elapsed: 23, extra: null }, team: { id: 50, name: 'Manchester City' },
        player: { id: 629, name: 'Kevin De Bruyne' }, assist: { id: 631, name: 'Phil Foden' },
        type: 'Goal', detail: 'Normal Goal', comments: null },
      { time: { elapsed: 41, extra: null }, team: { id: 45, name: 'Everton' },
        player: { id: 2932, name: 'Abdoulaye Doucouré' }, assist: { id: null, name: null },
        type: 'Card', detail: 'Yellow Card', comments: 'Foul' },
      { time: { elapsed: 90, extra: 3 }, team: { id: 50, name: 'Manchester City' },
        player: { id: 643, name: 'Gabriel Jesus' }, assist: { id: null, name: null },
        type: 'Goal', detail: 'Penalty', comments: null },
    ];
    item.lineups = LINEUPS;
    item.statistics = [
      { team: { id: 50, name: 'Manchester City' }, statistics: [
        { type: 'Shots on Goal', value: 7 }, { type: 'Total Shots', value: 18 },
        { type: 'Ball Possession', value: '64%' }, { type: 'Corner Kicks', value: 9 },
        { type: 'Yellow Cards', value: 1 }, { type: 'expected_goals', value: '2.41' },
        { type: 'Passes %', value: null } ] },
      { team: { id: 45, name: 'Everton' }, statistics: [
        { type: 'Shots on Goal', value: 2 }, { type: 'Total Shots', value: 6 },
        { type: 'Ball Possession', value: '36%' }, { type: 'Corner Kicks', value: 3 },
        { type: 'Yellow Cards', value: 3 }, { type: 'expected_goals', value: '0.58' },
        { type: 'Brand New Stat', value: 4 } ] },
    ];
    item.players = [
      { team: { id: 50, name: 'Manchester City' }, players: [
        { player: { id: 629, name: 'Kevin De Bruyne', photo: 'https://media.api-sports.io/football/players/629.png' },
          statistics: [{ ...PLAYER_STATS, games: { ...PLAYER_STATS.games, position: 'M', number: 17 },
            goals: { total: 1, conceded: 0, assists: null, saves: null }, shots: { total: 4, on: 2 } }] },
      ] },
      { team: { id: 45, name: 'Everton' }, players: [
        { player: { id: 2932, name: 'Abdoulaye Doucouré', photo: null },
          statistics: [{ ...PLAYER_STATS, games: { ...PLAYER_STATS.games, position: 'M', number: 16 },
            cards: { yellow: 1, red: 0 } }] },
      ] },
    ];
  }
  return item;
}

export function standingsFor({ leagueId = 39, season = 2026, update = '2026-10-01T00:00:00+00:00' } = {}) {
  const row = (rank, id, name, points) => ({
    rank, team: { id, name, logo: `https://media.api-sports.io/football/teams/${id}.png` },
    points, goalsDiff: 10 - rank, group: 'Premier League', form: 'WWDLW', status: 'same', description: null,
    all: { played: 6, win: 4, draw: 1, lose: 1, goals: { for: 12, against: 5 } },
    home: { played: 3, win: 2, draw: 1, lose: 0, goals: { for: 7, against: 2 } },
    away: { played: 3, win: 2, draw: 0, lose: 1, goals: { for: 5, against: 3 } },
    update,
  });
  return {
    league: { id: leagueId, name: 'Premier League', country: 'England', logo: '', flag: '', season,
      standings: [[row(1, 50, 'Manchester City', 13), row(2, 45, 'Everton', 11)]] },
  };
}

export function squad({ teamId = 50, players = [[629, 'Kevin De Bruyne', 17, 'Midfielder'], [643, 'Gabriel Jesus', 9, 'Attacker']] } = {}) {
  return {
    team: { id: teamId, name: 'Manchester City', logo: '' },
    players: players.map(([id, name, number, position]) => ({ id, name, age: 30, number, position,
      photo: `https://media.api-sports.io/football/players/${id}.png` })),
  };
}

export function profile({ id = 629, name = 'K. De Bruyne' } = {}) {
  return {
    player: { id, name, firstname: 'Kevin', lastname: 'De Bruyne', age: 35,
      birth: { date: '1991-06-28', place: 'Drongen', country: 'Belgium' }, nationality: 'Belgium',
      height: '181 cm', weight: '70 kg', number: 17, position: 'Midfielder',
      photo: `https://media.api-sports.io/football/players/${id}.png` },
  };
}

export function injury({ playerId = 643, fixtureId = 592872, type = 'Missing Fixture', reason = 'Knee Injury' } = {}) {
  return {
    player: { id: playerId, name: 'Gabriel Jesus', photo: '', type, reason },
    team: { id: 50, name: 'Manchester City', logo: '' },
    fixture: { id: fixtureId, timezone: 'UTC', date: '2026-10-04T14:00:00+00:00', timestamp: 0 },
    league: { id: 39, season: 2026, name: 'Premier League', country: 'England', logo: '', flag: '' },
  };
}

/** A fake provider with the same methods as the real client. */
export function fakeProvider(overrides = {}) {
  const calls = [];
  const reply = (name, items) => async (...args) => {
    calls.push([name, ...args]);
    return { items: typeof items === 'function' ? items(...args) : items, fetchedAt: new Date().toISOString() };
  };
  return {
    calls,
    requestsUsed: 0,
    leagues: reply('leagues', overrides.leagues ?? ((id) => [league({ id })])),
    teams: reply('teams', overrides.teams ?? [team(), team({ id: 45, name: 'Everton', venueId: 556 })]),
    fixtures: reply('fixtures', overrides.fixtures ?? [fixture()]),
    fixturesByIds: reply('fixturesByIds', overrides.fixturesByIds ?? ((ids) => ids.map((id) => fixture({
      id: Number(id), status: 'FT', date: '2026-09-27T14:00:00+00:00', goals: { home: 2, away: 0 },
      halftime: { home: 1, away: 0 }, details: true })))),
    standings: reply('standings', overrides.standings ?? [standingsFor()]),
    squad: reply('squad', overrides.squad ?? [squad()]),
    playerProfile: reply('playerProfile', overrides.playerProfile ?? ((id) => [profile({ id: Number(id) })])),
    injuries: reply('injuries', overrides.injuries ?? [injury()]),
  };
}

/* Read models for the UI: matches, Match Center, teams, players,
 * competitions, search, favourites.
 *
 * Everything here reads only from SokkerLiga's own database. Anything that
 * looks back from a match — form, head-to-head, the table, season averages —
 * is computed as of that match's kickoff, so an old Match Center shows what
 * was known before that game, not what happened after it.
 */

import { ValidationError } from './db.mjs';

const nowIso = () => new Date().toISOString();

/* ---------------------------------------------------------- match rows */

const MATCH_SELECT = `
  SELECT m.id, m.kickoff_utc, m.round, m.status_key, m.status_detail, m.elapsed,
         m.home_goals, m.away_goals, m.home_ht, m.away_ht, m.home_pens, m.away_pens,
         m.venue_name, m.venue_city, m.referee, m.result_confirmed_at, m.details_fetched_at,
         m.season_id, s.label AS season_label, s.year AS season_year,
         c.id AS competition_id, c.name AS competition_name, c.logo_url AS competition_logo,
         c.country_name, c.kind AS competition_kind,
         ht.id AS home_id, ht.name AS home_name, ht.logo_url AS home_logo,
         at.id AS away_id, at.name AS away_name, at.logo_url AS away_logo
  FROM matches m
  JOIN seasons s ON s.id = m.season_id
  JOIN competitions c ON c.id = s.competition_id
  JOIN teams ht ON ht.id = m.home_team_id
  JOIN teams at ON at.id = m.away_team_id`;

function shapeMatch(r) {
  if (!r) return null;
  return {
    id: r.id, kickoffUtc: r.kickoff_utc, round: r.round, status: r.status_key, statusDetail: r.status_detail,
    elapsed: r.elapsed, venue: r.venue_name, venueCity: r.venue_city, referee: r.referee,
    score: r.home_goals === null ? null : {
      home: r.home_goals, away: r.away_goals, homeHt: r.home_ht, awayHt: r.away_ht,
      homePens: r.home_pens, awayPens: r.away_pens,
    },
    resultConfirmed: !!r.result_confirmed_at,
    competition: { id: r.competition_id, name: r.competition_name, logo: r.competition_logo,
      country: r.country_name, kind: r.competition_kind },
    season: { id: r.season_id, label: r.season_label, year: r.season_year },
    home: { id: r.home_id, name: r.home_name, logo: r.home_logo },
    away: { id: r.away_id, name: r.away_name, logo: r.away_logo },
  };
}

const FINAL = "('finished', 'awarded')";
const FAVOURITE = Symbol('favourite user id');

/** Matches filtered for the Matches page and the dashboard. */
export function listMatches(db, { from, to, competition, team, country, status, userId, favouritesOnly, limit = 300 } = {}) {
  const where = ['c.is_enabled = 1'];
  const args = [];
  if (from) { where.push('m.kickoff_utc >= ?'); args.push(from); }
  if (to) { where.push('m.kickoff_utc < ?'); args.push(to); }
  if (competition) { where.push('c.id = ?'); args.push(Number(competition)); }
  if (team) { where.push('(m.home_team_id = ? OR m.away_team_id = ?)'); args.push(Number(team), Number(team)); }
  if (country) { where.push('c.country_name = ?'); args.push(country); }
  if (status) { where.push('m.status_key = ?'); args.push(status); }
  let favouriteRank = '0';
  if (userId) {
    favouriteRank = `(EXISTS (SELECT 1 FROM user_favourites f WHERE f.user_id = ? AND (
        (f.entity_type = 'competition' AND f.entity_id = c.id) OR
        (f.entity_type = 'team' AND f.entity_id IN (m.home_team_id, m.away_team_id)))))`;
    if (favouritesOnly) { where.push(favouriteRank); args.push(FAVOURITE); }
  }
  /* Parameters bind in text order: the favourite test in the select list,
   * then the filters (which may repeat the favourite test), then the limit. */
  const select = MATCH_SELECT.replace('SELECT m.id', `SELECT ${favouriteRank} AS is_favourite, m.id`);
  const whereArgs = args.flatMap((a) => (a === FAVOURITE ? [userId] : [a]));
  const rows = db.prepare(`SELECT * FROM (${select} WHERE ${where.join(' AND ')})
                           ORDER BY kickoff_utc, competition_name LIMIT ?`)
    .all(...(userId ? [userId] : []), ...whereArgs, Number(limit));
  return rows.map((r) => ({ ...shapeMatch(r), isFavourite: !!r.is_favourite }));
}

/* --------------------------------------------------- looking back in time */

function resultFor(teamId, r) {
  const isHome = r.home_team_id === teamId;
  const gf = isHome ? r.home_goals : r.away_goals;
  const ga = isHome ? r.away_goals : r.home_goals;
  return { outcome: gf > ga ? 'W' : gf < ga ? 'L' : 'D', goalsFor: gf, goalsAgainst: ga, isHome };
}

/** A team's finished matches before a moment, newest first. */
export function teamResults(db, teamId, before, { limit = 10, venue = 'all', seasonId = null } = {}) {
  const venueClause = venue === 'home' ? 'm.home_team_id = ?' : venue === 'away' ? 'm.away_team_id = ?'
    : '(m.home_team_id = ? OR m.away_team_id = ?)';
  const venueArgs = venue === 'all' ? [teamId, teamId] : [teamId];
  const seasonClause = seasonId ? 'AND m.season_id = ?' : '';
  const rows = db.prepare(`${MATCH_SELECT}
    WHERE ${venueClause} AND m.status_key IN ${FINAL} AND m.home_goals IS NOT NULL AND m.kickoff_utc < ? ${seasonClause}
    ORDER BY m.kickoff_utc DESC LIMIT ?`)
    .all(...venueArgs, before, ...(seasonId ? [seasonId] : []), limit);
  return rows.map((r) => ({ ...shapeMatch(r), ...resultFor(teamId, { ...r, home_team_id: r.home_id }) }));
}

function summarise(results) {
  const n = results.length;
  const sum = (f) => results.reduce((a, r) => a + f(r), 0);
  return {
    played: n,
    won: results.filter((r) => r.outcome === 'W').length,
    drawn: results.filter((r) => r.outcome === 'D').length,
    lost: results.filter((r) => r.outcome === 'L').length,
    goalsFor: sum((r) => r.goalsFor),
    goalsAgainst: sum((r) => r.goalsAgainst),
    points: sum((r) => (r.outcome === 'W' ? 3 : r.outcome === 'D' ? 1 : 0)),
    cleanSheets: results.filter((r) => r.goalsAgainst === 0).length,
    failedToScore: results.filter((r) => r.goalsFor === 0).length,
    form: results.slice(0, 5).map((r) => r.outcome).join(''),
  };
}

/** Per-match averages of a team's statistics in a season, before a moment. */
export function teamStatAverages(db, teamId, seasonId, before) {
  const rows = db.prepare(`
    SELECT st.key, st.name, st.unit,
           AVG(own.value) AS avg_for, AVG(opp.value) AS avg_against, COUNT(own.value) AS matches
    FROM matches m
    JOIN team_match_stats own ON own.match_id = m.id AND own.team_id = ?
    JOIN stat_types st ON st.key = own.stat_key
    LEFT JOIN team_match_stats opp ON opp.match_id = m.id AND opp.stat_key = own.stat_key AND opp.team_id <> ?
    WHERE m.season_id = ? AND m.kickoff_utc < ? AND m.status_key IN ${FINAL}
    GROUP BY st.key ORDER BY st.ordinal`).all(teamId, teamId, seasonId, before);
  return rows.map((r) => ({ key: r.key, name: r.name, unit: r.unit, matches: r.matches,
    for: r.avg_for === null ? null : Number(r.avg_for.toFixed(2)),
    against: r.avg_against === null ? null : Number(r.avg_against.toFixed(2)) }));
}

/** The latest table snapshot for a season taken before a moment. */
export function standingsAsOf(db, seasonId, at = nowIso()) {
  const snapshot = db.prepare('SELECT MAX(as_of) AS as_of FROM standings WHERE season_id = ? AND as_of <= ?')
    .get(seasonId, at)?.as_of;
  if (!snapshot) return { asOf: null, groups: [] };
  const rows = db.prepare(`
    SELECT s.*, t.name AS team_name, t.logo_url AS team_logo FROM standings s JOIN teams t ON t.id = s.team_id
    WHERE s.season_id = ? AND s.as_of = ? ORDER BY s.group_name, s.position`).all(seasonId, snapshot);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.group_name)) groups.set(r.group_name, []);
    groups.get(r.group_name).push({
      teamId: r.team_id, teamName: r.team_name, teamLogo: r.team_logo, position: r.position,
      played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, goalsFor: r.goals_for,
      goalsAgainst: r.goals_against, goalDiff: r.goal_diff, points: r.points, form: r.form,
      description: r.description,
      home: { played: r.home_played, won: r.home_won, drawn: r.home_drawn, lost: r.home_lost,
        goalsFor: r.home_goals_for, goalsAgainst: r.home_goals_against },
      away: { played: r.away_played, won: r.away_won, drawn: r.away_drawn, lost: r.away_lost,
        goalsFor: r.away_goals_for, goalsAgainst: r.away_goals_against },
    });
  }
  return { asOf: snapshot, groups: [...groups].map(([name, rows]) => ({ name, rows })) };
}

/** Top contributors for a team in a season, before a moment. */
export function keyPlayers(db, teamId, seasonId, before, limit = 6) {
  return db.prepare(`
    SELECT p.id, p.name, p.photo_url, p.position,
           COUNT(*) AS appearances, SUM(COALESCE(ps.minutes, 0)) AS minutes,
           SUM(COALESCE(ps.goals, 0)) AS goals, SUM(COALESCE(ps.assists, 0)) AS assists,
           SUM(COALESCE(ps.shots, 0)) AS shots, SUM(COALESCE(ps.shots_on_target, 0)) AS shots_on_target,
           ROUND(AVG(ps.rating), 2) AS rating
    FROM player_match_stats ps
    JOIN matches m ON m.id = ps.match_id
    JOIN players p ON p.id = ps.player_id
    WHERE ps.team_id = ? AND m.season_id = ? AND m.kickoff_utc < ? AND COALESCE(ps.minutes, 0) > 0
    GROUP BY p.id
    ORDER BY (SUM(COALESCE(ps.goals, 0)) + SUM(COALESCE(ps.assists, 0))) DESC, minutes DESC
    LIMIT ?`).all(teamId, seasonId, before, limit)
    .map((r) => ({ id: r.id, name: r.name, photo: r.photo_url, position: r.position, appearances: r.appearances,
      minutes: r.minutes, goals: r.goals, assists: r.assists, shots: r.shots, shotsOnTarget: r.shots_on_target,
      rating: r.rating }));
}

function headToHead(db, a, b, before, limit = 10) {
  const rows = db.prepare(`${MATCH_SELECT}
    WHERE ((m.home_team_id = ? AND m.away_team_id = ?) OR (m.home_team_id = ? AND m.away_team_id = ?))
      AND m.status_key IN ${FINAL} AND m.home_goals IS NOT NULL AND m.kickoff_utc < ?
    ORDER BY m.kickoff_utc DESC LIMIT ?`).all(a, b, b, a, before, limit).map(shapeMatch);
  const tally = { played: rows.length, homeTeamWins: 0, awayTeamWins: 0, draws: 0, goals: 0, bothScored: 0, over25: 0 };
  for (const m of rows) {
    const aGoals = m.home.id === a ? m.score.home : m.score.away;
    const bGoals = m.home.id === a ? m.score.away : m.score.home;
    if (aGoals > bGoals) tally.homeTeamWins += 1; else if (aGoals < bGoals) tally.awayTeamWins += 1; else tally.draws += 1;
    tally.goals += m.score.home + m.score.away;
    if (m.score.home > 0 && m.score.away > 0) tally.bothScored += 1;
    if (m.score.home + m.score.away > 2.5) tally.over25 += 1;
  }
  return { matches: rows, summary: tally };
}

/* ---------------------------------------------------------- Match Center */

export function matchCenter(db, id) {
  const row = db.prepare(`${MATCH_SELECT} WHERE m.id = ?`).get(Number(id));
  if (!row) return null;
  const match = shapeMatch(row);
  const before = match.kickoffUtc;
  const seasonId = match.season.id;

  const side = (teamId, venue) => {
    const all = teamResults(db, teamId, before, { limit: 10 });
    const atVenue = teamResults(db, teamId, before, { limit: 10, venue });
    const season = teamResults(db, teamId, before, { limit: 100, seasonId });
    const seasonHome = season.filter((r) => r.isHome);
    const seasonAway = season.filter((r) => !r.isHome);
    const restDays = all[0] ? Math.floor((Date.parse(before) - Date.parse(all[0].kickoffUtc)) / 86400_000) : null;
    const last14 = teamResults(db, teamId, before, { limit: 20 })
      .filter((r) => Date.parse(before) - Date.parse(r.kickoffUtc) <= 14 * 86400_000).length;
    return {
      recent: all,
      form: summarise(all.slice(0, 5)),
      last10: summarise(all),
      venueForm: summarise(atVenue),
      season: summarise(season),
      seasonHome: summarise(seasonHome),
      seasonAway: summarise(seasonAway),
      averages: teamStatAverages(db, teamId, seasonId, before),
      keyPlayers: keyPlayers(db, teamId, seasonId, before),
      restDays,
      matchesLast14Days: last14,
    };
  };

  const table = standingsAsOf(db, seasonId, before);
  const position = (teamId) => {
    for (const g of table.groups) {
      const r = g.rows.find((x) => x.teamId === teamId);
      if (r) return { ...r, group: g.name };
    }
    return null;
  };

  const lineups = db.prepare(`
    SELECT l.team_id, l.formation, l.status, l.fetched_at, mg.name AS manager_name, mg.photo_url AS manager_photo
    FROM lineups l LEFT JOIN managers mg ON mg.id = l.manager_id WHERE l.match_id = ?`).all(match.id)
    .map((l) => ({
      teamId: l.team_id, formation: l.formation, status: l.status, fetchedAt: l.fetched_at,
      manager: l.manager_name ? { name: l.manager_name, photo: l.manager_photo } : null,
      players: db.prepare(`
        SELECT lp.player_id AS id, p.name, p.photo_url AS photo, lp.role, lp.position, lp.grid, lp.shirt_number AS number
        FROM lineup_players lp JOIN players p ON p.id = lp.player_id
        WHERE lp.match_id = ? AND lp.team_id = ? ORDER BY lp.role DESC, lp.grid, lp.shirt_number`).all(match.id, l.team_id),
    }));

  const availability = db.prepare(`
    SELECT a.player_id AS id, p.name, p.photo_url AS photo, p.position, a.team_id AS teamId, a.status, a.reason,
           a.last_reported_at AS reportedAt
    FROM availability a JOIN players p ON p.id = a.player_id WHERE a.match_id = ? ORDER BY a.status DESC, p.name`)
    .all(match.id);

  const events = db.prepare(`
    SELECT e.seq, e.minute, e.extra_minute AS extraMinute, e.team_id AS teamId, e.player_id AS playerId,
           e.player_name AS playerName, e.assist_player_id AS assistId, e.assist_name AS assistName,
           e.type_key AS type, e.detail
    FROM match_events e WHERE e.match_id = ? ORDER BY e.seq`).all(match.id);

  const stats = db.prepare(`
    SELECT st.key, st.name, st.unit,
           MAX(CASE WHEN s.team_id = ? THEN s.value END) AS home,
           MAX(CASE WHEN s.team_id = ? THEN s.value END) AS away
    FROM team_match_stats s JOIN stat_types st ON st.key = s.stat_key
    WHERE s.match_id = ? GROUP BY st.key ORDER BY st.ordinal`).all(match.home.id, match.away.id, match.id);

  const playerStats = db.prepare(`
    SELECT ps.*, p.name, p.photo_url AS photo FROM player_match_stats ps JOIN players p ON p.id = ps.player_id
    WHERE ps.match_id = ? ORDER BY ps.team_id, COALESCE(ps.rating, 0) DESC`).all(match.id);

  const revisions = db.prepare(`SELECT changed_at AS changedAt, fields FROM match_revisions
                                WHERE match_id = ? AND fields NOT LIKE 'player_stats:%' ORDER BY changed_at`).all(match.id);

  return {
    match,
    positions: { home: position(match.home.id), away: position(match.away.id), asOf: table.asOf },
    home: side(match.home.id, 'home'),
    away: side(match.away.id, 'away'),
    headToHead: headToHead(db, match.home.id, match.away.id, before),
    lineups, availability, events, stats, playerStats, revisions,
  };
}

/* ------------------------------------------------------------------ teams */

export function teamProfile(db, id) {
  const team = db.prepare(`
    SELECT t.*, v.name AS venue_name, v.city AS venue_city, v.capacity AS venue_capacity, v.image_url AS venue_image
    FROM teams t LEFT JOIN venues v ON v.id = t.venue_id WHERE t.id = ?`).get(Number(id));
  if (!team) return null;
  const now = nowIso();

  const seasons = db.prepare(`
    SELECT s.id, s.label, s.year, c.id AS competition_id, c.name AS competition_name, c.logo_url AS competition_logo
    FROM season_teams st JOIN seasons s ON s.id = st.season_id JOIN competitions c ON c.id = s.competition_id
    WHERE st.team_id = ? AND s.is_current = 1 ORDER BY c.ordinal`).all(team.id);

  const competitions = seasons.map((s) => {
    const table = standingsAsOf(db, s.id, now);
    let standing = null;
    for (const g of table.groups) {
      const r = g.rows.find((x) => x.teamId === team.id);
      if (r) standing = { ...r, group: g.name };
    }
    const results = teamResults(db, team.id, now, { limit: 100, seasonId: s.id });
    return {
      competition: { id: s.competition_id, name: s.competition_name, logo: s.competition_logo },
      season: { id: s.id, label: s.label },
      standing,
      record: summarise(results),
      home: summarise(results.filter((r) => r.isHome)),
      away: summarise(results.filter((r) => !r.isHome)),
      averages: teamStatAverages(db, team.id, s.id, now),
    };
  });

  const manager = db.prepare(`
    SELECT mg.name, mg.photo_url AS photo, tm.valid_from AS since FROM team_managers tm
    JOIN managers mg ON mg.id = tm.manager_id WHERE tm.team_id = ? AND tm.valid_to IS NULL`).get(team.id) ?? null;

  const primarySeason = seasons[0]?.id ?? null;
  const roster = db.prepare(`
    SELECT p.id, p.name, p.photo_url AS photo, p.birth_date AS birthDate, p.nationality,
           r.shirt_number AS number, COALESCE(r.position, p.position) AS position,
           (SELECT COUNT(*) FROM player_match_stats ps JOIN matches m ON m.id = ps.match_id
             WHERE ps.player_id = p.id AND ps.team_id = r.team_id AND m.season_id = ? AND COALESCE(ps.minutes, 0) > 0) AS appearances,
           (SELECT SUM(COALESCE(ps.goals, 0)) FROM player_match_stats ps JOIN matches m ON m.id = ps.match_id
             WHERE ps.player_id = p.id AND ps.team_id = r.team_id AND m.season_id = ?) AS goals,
           (SELECT SUM(COALESCE(ps.assists, 0)) FROM player_match_stats ps JOIN matches m ON m.id = ps.match_id
             WHERE ps.player_id = p.id AND ps.team_id = r.team_id AND m.season_id = ?) AS assists
    FROM team_rosters r JOIN players p ON p.id = r.player_id
    WHERE r.team_id = ? AND r.valid_to IS NULL
    ORDER BY CASE COALESCE(r.position, p.position) WHEN 'Goalkeeper' THEN 1 WHEN 'Defender' THEN 2
             WHEN 'Midfielder' THEN 3 WHEN 'Attacker' THEN 4 ELSE 5 END, r.shirt_number`)
    .all(primarySeason, primarySeason, primarySeason, team.id);

  const upcoming = db.prepare(`${MATCH_SELECT}
    WHERE (m.home_team_id = ? OR m.away_team_id = ?) AND m.kickoff_utc >= ? AND m.status_key IN ('scheduled', 'live', 'postponed')
    ORDER BY m.kickoff_utc LIMIT 10`).all(team.id, team.id, now).map(shapeMatch);

  return {
    team: {
      id: team.id, name: team.name, code: team.code, country: team.country_name, founded: team.founded,
      logo: team.logo_url,
      venue: team.venue_name ? { name: team.venue_name, city: team.venue_city, capacity: team.venue_capacity,
        image: team.venue_image } : null,
      sourceRef: team.source_ref, fetchedAt: team.fetched_at,
    },
    manager, competitions, roster,
    recent: teamResults(db, team.id, now, { limit: 10 }),
    form: summarise(teamResults(db, team.id, now, { limit: 5 })),
    upcoming,
  };
}

/* ---------------------------------------------------------------- players */

const ageOn = (birthDate, at = new Date()) => {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  let age = at.getUTCFullYear() - b.getUTCFullYear();
  const m = at.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < b.getUTCDate())) age -= 1;
  return age;
};

export function playerProfile(db, id) {
  const p = db.prepare('SELECT * FROM players WHERE id = ?').get(Number(id));
  if (!p) return null;
  const teams = db.prepare(`
    SELECT t.id, t.name, t.logo_url AS logo, r.shirt_number AS number, r.position, r.valid_from AS since
    FROM team_rosters r JOIN teams t ON t.id = r.team_id WHERE r.player_id = ? AND r.valid_to IS NULL`).all(p.id);

  const seasons = db.prepare(`
    SELECT s.id AS season_id, s.label, c.name AS competition_name, c.id AS competition_id, t.name AS team_name,
           COUNT(*) FILTER (WHERE COALESCE(ps.minutes, 0) > 0) AS appearances,
           SUM(COALESCE(ps.minutes, 0)) AS minutes, SUM(COALESCE(ps.goals, 0)) AS goals,
           SUM(COALESCE(ps.assists, 0)) AS assists, SUM(COALESCE(ps.shots, 0)) AS shots,
           SUM(COALESCE(ps.shots_on_target, 0)) AS shots_on_target, SUM(COALESCE(ps.yellow, 0)) AS yellow,
           SUM(COALESCE(ps.red, 0)) AS red, ROUND(AVG(ps.rating), 2) AS rating
    FROM player_match_stats ps JOIN matches m ON m.id = ps.match_id
    JOIN seasons s ON s.id = m.season_id JOIN competitions c ON c.id = s.competition_id
    JOIN teams t ON t.id = ps.team_id
    WHERE ps.player_id = ? GROUP BY s.id, ps.team_id ORDER BY s.year DESC, c.ordinal`).all(p.id)
    .map((r) => ({ seasonId: r.season_id, season: r.label, competition: { id: r.competition_id, name: r.competition_name },
      team: r.team_name, appearances: r.appearances, minutes: r.minutes, goals: r.goals, assists: r.assists,
      shots: r.shots, shotsOnTarget: r.shots_on_target, yellow: r.yellow, red: r.red, rating: r.rating }));

  const history = db.prepare(`
    SELECT ps.*, m.kickoff_utc, m.home_goals, m.away_goals, m.home_team_id, m.status_key,
           ht.name AS home_name, at.name AS away_name, c.name AS competition_name
    FROM player_match_stats ps JOIN matches m ON m.id = ps.match_id
    JOIN teams ht ON ht.id = m.home_team_id JOIN teams at ON at.id = m.away_team_id
    JOIN seasons s ON s.id = m.season_id JOIN competitions c ON c.id = s.competition_id
    WHERE ps.player_id = ? ORDER BY m.kickoff_utc DESC LIMIT 20`).all(p.id)
    .map((r) => ({
      matchId: r.match_id, kickoffUtc: r.kickoff_utc, competition: r.competition_name,
      home: r.home_name, away: r.away_name, score: r.home_goals === null ? null : `${r.home_goals}–${r.away_goals}`,
      wasHome: r.home_team_id === r.team_id, minutes: r.minutes, rating: r.rating, goals: r.goals, assists: r.assists,
      shots: r.shots, shotsOnTarget: r.shots_on_target, yellow: r.yellow, red: r.red,
    }));

  const availability = db.prepare(`
    SELECT a.status, a.reason, a.last_reported_at AS reportedAt, m.id AS matchId, m.kickoff_utc AS kickoffUtc,
           ht.name AS home, at.name AS away
    FROM availability a JOIN matches m ON m.id = a.match_id
    JOIN teams ht ON ht.id = m.home_team_id JOIN teams at ON at.id = m.away_team_id
    WHERE a.player_id = ? AND m.kickoff_utc >= ? ORDER BY m.kickoff_utc LIMIT 5`).all(p.id, nowIso());

  return {
    player: {
      id: p.id, name: p.name, firstName: p.first_name, lastName: p.last_name, birthDate: p.birth_date,
      age: ageOn(p.birth_date), nationality: p.nationality, heightCm: p.height_cm, position: p.position,
      photo: p.photo_url, profiledAt: p.profiled_at, fetchedAt: p.fetched_at,
    },
    teams, seasons, history, availability,
    recentForm: history.slice(0, 5),
  };
}

export function listPlayers(db, { q = '', team, limit = 100 } = {}) {
  const where = [];
  const args = [];
  if (q) { where.push('p.name LIKE ?'); args.push(`%${q}%`); }
  if (team) { where.push('r.team_id = ?'); args.push(Number(team)); }
  return db.prepare(`
    SELECT p.id, p.name, p.photo_url AS photo, p.position, p.nationality, t.id AS team_id, t.name AS team_name,
           t.logo_url AS team_logo
    FROM players p
    LEFT JOIN team_rosters r ON r.player_id = p.id AND r.valid_to IS NULL
    LEFT JOIN teams t ON t.id = r.team_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : 'WHERE r.id IS NOT NULL'}
    ORDER BY p.name LIMIT ?`).all(...args, Number(limit))
    .map((r) => ({ id: r.id, name: r.name, photo: r.photo, position: r.position, nationality: r.nationality,
      team: r.team_id ? { id: r.team_id, name: r.team_name, logo: r.team_logo } : null }));
}

export function listTeams(db, { q = '', competition } = {}) {
  const where = ['s.is_current = 1', 'c.is_enabled = 1'];
  const args = [];
  if (q) { where.push('t.name LIKE ?'); args.push(`%${q}%`); }
  if (competition) { where.push('c.id = ?'); args.push(Number(competition)); }
  const rows = db.prepare(`
    SELECT t.id, t.name, t.logo_url AS logo, t.country_name AS country,
           GROUP_CONCAT(c.name, ' · ') AS competitions
    FROM teams t JOIN season_teams st ON st.team_id = t.id
    JOIN seasons s ON s.id = st.season_id JOIN competitions c ON c.id = s.competition_id
    WHERE ${where.join(' AND ')} GROUP BY t.id ORDER BY t.name`).all(...args);
  return rows;
}

/* ----------------------------------------------------------- competitions */

export function listCompetitions(db) {
  return db.prepare(`
    SELECT c.id, c.key, c.name, c.country_name AS country, c.kind, c.logo_url AS logo, c.flag_url AS flag,
           c.is_enabled AS isEnabled, s.id AS season_id, s.label AS season_label,
           (SELECT COUNT(*) FROM season_teams st WHERE st.season_id = s.id) AS teams,
           (SELECT COUNT(*) FROM matches m WHERE m.season_id = s.id) AS matches
    FROM competitions c LEFT JOIN seasons s ON s.competition_id = c.id AND s.is_current = 1
    ORDER BY c.ordinal`).all()
    .map((r) => ({ ...r, isEnabled: !!r.isEnabled,
      season: r.season_id ? { id: r.season_id, label: r.season_label } : null }));
}

export function competitionDetail(db, id, seasonId = null) {
  const c = db.prepare('SELECT * FROM competitions WHERE id = ?').get(Number(id));
  if (!c) return null;
  const seasons = db.prepare(`SELECT id, label, year, is_current AS isCurrent,
                                (SELECT COUNT(*) FROM matches m WHERE m.season_id = seasons.id) AS matches
                              FROM seasons WHERE competition_id = ? ORDER BY year DESC`).all(c.id);
  const season = seasons.find((s) => s.id === Number(seasonId)) ?? seasons.find((s) => s.isCurrent) ?? seasons[0] ?? null;
  const now = nowIso();
  const results = season ? db.prepare(`${MATCH_SELECT}
    WHERE m.season_id = ? AND m.kickoff_utc < ? AND m.status_key IN ${FINAL}
    ORDER BY m.kickoff_utc DESC LIMIT 20`).all(season.id, now).map(shapeMatch) : [];
  const fixtures = season ? db.prepare(`${MATCH_SELECT}
    WHERE m.season_id = ? AND m.kickoff_utc >= ? ORDER BY m.kickoff_utc LIMIT 20`).all(season.id, now).map(shapeMatch) : [];
  return {
    competition: { id: c.id, name: c.name, country: c.country_name, kind: c.kind, logo: c.logo_url, flag: c.flag_url,
      isEnabled: !!c.is_enabled },
    seasons: seasons.map((s) => ({ ...s, isCurrent: !!s.isCurrent })),
    season,
    table: season ? standingsAsOf(db, season.id, now) : { asOf: null, groups: [] },
    results, fixtures,
  };
}

export function setCompetitionEnabled(db, id, enabled) {
  const info = db.prepare('UPDATE competitions SET is_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, Number(id));
  if (!info.changes) throw new ValidationError('That competition does not exist.', 404);
}

/* ----------------------------------------------------------------- search */

export function search(db, q) {
  const term = String(q ?? '').trim();
  if (term.length < 2) return { teams: [], players: [], competitions: [], matches: [] };
  const like = `%${term}%`;
  const teams = db.prepare('SELECT id, name, logo_url AS logo, country_name AS country FROM teams WHERE name LIKE ? ORDER BY name LIMIT 8')
    .all(like);
  const players = db.prepare(`
    SELECT p.id, p.name, p.photo_url AS photo, p.position, t.name AS team
    FROM players p LEFT JOIN team_rosters r ON r.player_id = p.id AND r.valid_to IS NULL
    LEFT JOIN teams t ON t.id = r.team_id
    WHERE p.name LIKE ? GROUP BY p.id ORDER BY (r.id IS NULL), p.name LIMIT 8`).all(like);
  const competitions = db.prepare(`SELECT id, name, logo_url AS logo, country_name AS country FROM competitions
                                   WHERE name LIKE ? OR country_name LIKE ? ORDER BY ordinal LIMIT 5`).all(like, like);
  /* Matches: upcoming and recent games of the teams that matched. */
  const teamIds = teams.map((t) => t.id);
  const matches = teamIds.length ? db.prepare(`${MATCH_SELECT}
    WHERE (m.home_team_id IN (${teamIds.map(() => '?').join(',')}) OR m.away_team_id IN (${teamIds.map(() => '?').join(',')}))
      AND m.kickoff_utc BETWEEN ? AND ?
    ORDER BY ABS(julianday(m.kickoff_utc) - julianday('now')) LIMIT 8`)
    .all(...teamIds, ...teamIds, new Date(Date.now() - 30 * 86400_000).toISOString(),
      new Date(Date.now() + 30 * 86400_000).toISOString()).map(shapeMatch) : [];
  return { teams, players, competitions, matches };
}

/* ------------------------------------------------------------- favourites */

export function favourites(db, userId) {
  return db.prepare('SELECT entity_type AS type, entity_id AS id FROM user_favourites WHERE user_id = ?').all(userId);
}

export function setFavourite(db, userId, type, id, on) {
  if (!['competition', 'team'].includes(type)) throw new ValidationError('Only competitions and teams can be favourites.');
  const table = type === 'competition' ? 'competitions' : 'teams';
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(Number(id))) throw new ValidationError('Not found.', 404);
  if (on) {
    db.prepare('INSERT OR IGNORE INTO user_favourites (user_id, entity_type, entity_id, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, type, Number(id), nowIso());
  } else {
    db.prepare('DELETE FROM user_favourites WHERE user_id = ? AND entity_type = ? AND entity_id = ?').run(userId, type, Number(id));
  }
  return favourites(db, userId);
}

/* -------------------------------------------------------------- dashboard */

export function dashboard(db, userId, { dayStart, dayEnd } = {}) {
  const start = dayStart ?? new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();
  const end = dayEnd ?? new Date(Date.parse(start) + 86400_000).toISOString();
  const weekEnd = new Date(Date.parse(start) + 8 * 86400_000).toISOString();
  return {
    today: listMatches(db, { from: start, to: end, userId }),
    upcoming: listMatches(db, { from: end, to: weekEnd, userId, limit: 60 }),
    recentResults: db.prepare(`${MATCH_SELECT}
      WHERE c.is_enabled = 1 AND m.status_key IN ${FINAL} AND m.kickoff_utc BETWEEN ? AND ?
      ORDER BY m.kickoff_utc DESC LIMIT 12`)
      .all(new Date(Date.parse(start) - 3 * 86400_000).toISOString(), start).map(shapeMatch),
    counts: db.prepare(`SELECT
        (SELECT COUNT(*) FROM matches) AS matches,
        (SELECT COUNT(*) FROM teams) AS teams,
        (SELECT COUNT(*) FROM players) AS players,
        (SELECT COUNT(*) FROM matches WHERE details_fetched_at IS NOT NULL) AS matchesWithDetails`).get(),
  };
}

/* ------------------------------------------------------- match players */

/** Both squads for one match, for picking a player market in the bet slip:
 *  current squad members, most goals in the last year first. */
export function matchPlayers(db, id) {
  const m = db.prepare(`SELECT m.home_team_id, m.away_team_id, m.kickoff_utc, ht.name AS home, at.name AS away
                        FROM matches m JOIN teams ht ON ht.id = m.home_team_id JOIN teams at ON at.id = m.away_team_id
                        WHERE m.id = ?`).get(Number(id));
  if (!m) throw new ValidationError('That match does not exist.', 404);
  const since = new Date(Date.parse(m.kickoff_utc) - 365 * 86400_000).toISOString();
  const squad = db.prepare(`
    SELECT p.id, p.name, COALESCE(r.position, p.position) AS position,
           (SELECT COALESCE(SUM(ps.goals), 0) FROM player_match_stats ps JOIN matches x ON x.id = ps.match_id
            WHERE ps.player_id = p.id AND x.kickoff_utc BETWEEN ? AND ?) AS goals
    FROM team_rosters r JOIN players p ON p.id = r.player_id
    WHERE r.team_id = ? AND r.valid_to IS NULL AND COALESCE(r.position, p.position, '') <> 'Goalkeeper'
    ORDER BY goals DESC, p.name`);
  return {
    home: { name: m.home, players: squad.all(since, m.kickoff_utc, m.home_team_id) },
    away: { name: m.away, players: squad.all(since, m.kickoff_utc, m.away_team_id) },
  };
}

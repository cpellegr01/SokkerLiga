/* The match-analysis packet, as of a moment — the only door to the data
 * for prediction.
 *
 * Every query here is limited to what was knowable at `asOf`:
 *  - a result counts only if the match kicked off at least RESULT_LAG before
 *    `asOf` (it had finished), and corrections the provider made after `asOf`
 *    are undone using match_revisions;
 *  - the league table is rebuilt from those results, not read from the
 *    provider's table (which for past seasons is the final one);
 *  - injury reports and lineups count only if SokkerLiga had them by `asOf`.
 *
 * The live Analyze button uses asOf = now. A backtest uses asOf = some time
 * before kickoff and goes through this same function, which is what keeps
 * a backtest honest. test/features.test.mjs checks the rules.
 */

import { createHash } from 'node:crypto';
import { fitRatings, lambdas, scoreMatrix, topScores, round } from './model/goals.mjs';
import { dispersion } from './model/markets.mjs';

export const BUILDER_VERSION = '1';

const DAY = 86400_000;
/* A match that kicked off this long ago has finished. */
const RESULT_LAG_MS = 3 * 3600_000;
const HISTORY_DAYS = 1100;
const FINAL = "('finished', 'awarded')";

const iso = (ms) => new Date(ms).toISOString();

/* ------------------------------------------------------ results as known */

/**
 * Finished matches before `asOf`, with any correction made after `asOf`
 * undone. Returns plain rows { id, homeId, awayId, homeGoals, awayGoals,
 * kickoffUtc, competitionId, seasonId, referee }.
 */
export function knownResults(db, asOf, { sinceDays = HISTORY_DAYS, teamIds = null } = {}) {
  const cutoff = iso(Date.parse(asOf) - RESULT_LAG_MS);
  const since = iso(Date.parse(asOf) - sinceDays * DAY);
  const teamClause = teamIds ? `AND (m.home_team_id IN (${teamIds.join(',')}) OR m.away_team_id IN (${teamIds.join(',')}))` : '';
  const rows = db.prepare(`
    SELECT m.id, m.home_team_id AS homeId, m.away_team_id AS awayId, m.home_goals AS homeGoals,
           m.away_goals AS awayGoals, m.home_et, m.away_et, m.kickoff_utc AS kickoffUtc, m.status_key,
           m.referee, s.competition_id AS competitionId, m.season_id AS seasonId
    FROM matches m JOIN seasons s ON s.id = m.season_id
    WHERE m.kickoff_utc <= ? AND m.kickoff_utc >= ? ${teamClause}
      AND (m.status_key IN ${FINAL} OR EXISTS (SELECT 1 FROM match_revisions r WHERE r.match_id = m.id AND r.changed_at > ?))
    ORDER BY m.kickoff_utc`).all(cutoff, since, asOf);

  /* The oldest revision made after asOf holds the values as they stood at
   * asOf for every field it lists. */
  const laterRevision = db.prepare(`SELECT old_json FROM match_revisions
                                    WHERE match_id = ? AND changed_at > ? AND fields NOT LIKE 'player_stats:%'
                                      AND fields <> 'events' ORDER BY changed_at`);
  const out = [];
  for (const r of rows) {
    const asKnown = { home_goals: r.homeGoals, away_goals: r.awayGoals, status_key: r.status_key,
      home_et: r.home_et, away_et: r.away_et, kickoff_utc: r.kickoffUtc };
    const revisions = laterRevision.all(r.id, asOf);
    const seen = new Set();
    for (const rev of revisions) {
      for (const [k, v] of Object.entries(JSON.parse(rev.old_json))) {
        if (!seen.has(k) && k in asKnown) { asKnown[k] = v; seen.add(k); }
      }
    }
    if (!['finished', 'awarded'].includes(asKnown.status_key)) continue;
    if (asKnown.home_goals === null || asKnown.away_goals === null) continue;
    if (Date.parse(asKnown.kickoff_utc) > Date.parse(cutoff)) continue;
    /* Ratings and markets are about regular time: take extra-time goals off. */
    out.push({
      id: r.id, homeId: r.homeId, awayId: r.awayId, competitionId: r.competitionId, seasonId: r.seasonId,
      kickoffUtc: asKnown.kickoff_utc, referee: r.referee,
      homeGoals: asKnown.home_goals - (asKnown.home_et ?? 0),
      awayGoals: asKnown.away_goals - (asKnown.away_et ?? 0),
    });
  }
  return out;
}

/* ------------------------------------------------------------ summaries */

function form(results, teamId, { venue = 'all', limit = 5 } = {}) {
  const mine = results
    .filter((r) => (venue === 'home' ? r.homeId === teamId : venue === 'away' ? r.awayId === teamId
      : r.homeId === teamId || r.awayId === teamId))
    .slice(-limit).reverse();
  const rows = mine.map((r) => {
    const home = r.homeId === teamId;
    const gf = home ? r.homeGoals : r.awayGoals;
    const ga = home ? r.awayGoals : r.homeGoals;
    return { matchId: r.id, date: r.kickoffUtc.slice(0, 10), home, gf, ga, result: gf > ga ? 'W' : gf < ga ? 'L' : 'D' };
  });
  return {
    played: rows.length,
    sequence: rows.map((r) => r.result).join(''),
    points: rows.reduce((a, r) => a + (r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0), 0),
    goalsFor: rows.reduce((a, r) => a + r.gf, 0),
    goalsAgainst: rows.reduce((a, r) => a + r.ga, 0),
    matches: rows,
  };
}

/** The league table rebuilt from known results of one season. */
export function tableFromResults(results, seasonId) {
  const t = new Map();
  const row = (id) => {
    if (!t.has(id)) t.set(id, { teamId: id, played: 0, won: 0, drawn: 0, lost: 0, gf: 0, ga: 0, points: 0 });
    return t.get(id);
  };
  for (const r of results.filter((x) => x.seasonId === seasonId)) {
    const h = row(r.homeId);
    const a = row(r.awayId);
    h.played += 1; a.played += 1;
    h.gf += r.homeGoals; h.ga += r.awayGoals; a.gf += r.awayGoals; a.ga += r.homeGoals;
    if (r.homeGoals > r.awayGoals) { h.won += 1; a.lost += 1; h.points += 3; } else if (r.homeGoals < r.awayGoals) {
      a.won += 1; h.lost += 1; a.points += 3;
    } else { h.drawn += 1; a.drawn += 1; h.points += 1; a.points += 1; }
  }
  return [...t.values()]
    .sort((x, y) => y.points - x.points || (y.gf - y.ga) - (x.gf - x.ga) || y.gf - x.gf)
    .map((r, i) => ({ ...r, position: i + 1, goalDiff: r.gf - r.ga }));
}

/* Time-weighted per-match averages of a team statistic, for and against,
 * from matches finished before the cutoff. */
function statRates(db, teamId, statKeys, cutoff, { halfLifeDays = 180, limit = 30 } = {}) {
  const keys = statKeys.map((k) => `'${k}'`).join(',');
  const rows = db.prepare(`
    SELECT m.id, m.kickoff_utc,
           SUM(CASE WHEN s.team_id = ? THEN s.value END) AS own,
           SUM(CASE WHEN s.team_id <> ? THEN s.value END) AS opp
    FROM matches m JOIN team_match_stats s ON s.match_id = m.id AND s.stat_key IN (${keys})
    WHERE (m.home_team_id = ? OR m.away_team_id = ?) AND m.kickoff_utc <= ? AND m.status_key IN ${FINAL}
    GROUP BY m.id HAVING own IS NOT NULL AND opp IS NOT NULL
    ORDER BY m.kickoff_utc DESC LIMIT ?`).all(teamId, teamId, teamId, teamId, cutoff, limit);
  const t0 = Date.parse(cutoff);
  let w = 0; let own = 0; let opp = 0;
  for (const r of rows) {
    const wt = Math.exp(-Math.LN2 * ((t0 - Date.parse(r.kickoff_utc)) / DAY) / halfLifeDays);
    w += wt; own += wt * r.own; opp += wt * r.opp;
  }
  return { matches: rows.length, weight: w, for: w ? own / w : null, against: w ? opp / w : null };
}

/* Per-team-per-match average and the spread of match totals in a
 * competition, over the year before the cutoff. */
function competitionRates(db, competitionId, statKeys, cutoff) {
  const keys = statKeys.map((k) => `'${k}'`).join(',');
  const totals = db.prepare(`
    SELECT SUM(s.value) AS total FROM matches m
    JOIN seasons se ON se.id = m.season_id AND se.competition_id = ?
    JOIN team_match_stats s ON s.match_id = m.id AND s.stat_key IN (${keys})
    WHERE m.kickoff_utc <= ? AND m.kickoff_utc >= ? AND m.status_key IN ${FINAL}
    GROUP BY m.id HAVING COUNT(DISTINCT s.team_id) = 2`)
    .all(competitionId, cutoff, iso(Date.parse(cutoff) - 365 * DAY)).map((r) => r.total);
  const mean = totals.length ? totals.reduce((a, x) => a + x, 0) / totals.length : null;
  return { matches: totals.length, perTeam: mean === null ? null : mean / 2, total: mean, size: dispersion(totals) };
}

function refereeRate(db, referee, cutoff) {
  if (!referee) return null;
  const rows = db.prepare(`
    SELECT SUM(s.value) AS total FROM matches m
    JOIN team_match_stats s ON s.match_id = m.id AND s.stat_key IN ('yellow_cards', 'red_cards')
    WHERE m.referee = ? AND m.kickoff_utc <= ? AND m.status_key IN ${FINAL} GROUP BY m.id`).all(referee, cutoff);
  if (!rows.length) return { matches: 0, average: null };
  return { matches: rows.length, average: rows.reduce((a, r) => a + r.total, 0) / rows.length };
}

/* Who is missing, and how much they usually matter: share of the team's
 * minutes and goals over the year before the cutoff. */
function absences(db, matchId, teamId, asOf, cutoff) {
  const players = db.prepare(`
    SELECT a.player_id AS id, p.name, p.position, a.status, a.reason
    FROM availability a JOIN players p ON p.id = a.player_id
    WHERE a.match_id = ? AND a.team_id = ? AND a.first_reported_at <= ?`).all(matchId, teamId, asOf);
  if (!players.length) return [];
  const since = iso(Date.parse(cutoff) - 365 * DAY);
  const team = db.prepare(`
    SELECT SUM(COALESCE(ps.minutes, 0)) AS minutes, SUM(COALESCE(ps.goals, 0)) AS goals, COUNT(DISTINCT ps.match_id) AS matches
    FROM player_match_stats ps JOIN matches m ON m.id = ps.match_id
    WHERE ps.team_id = ? AND m.kickoff_utc BETWEEN ? AND ?`).get(teamId, since, cutoff);
  const stat = db.prepare(`
    SELECT SUM(COALESCE(ps.minutes, 0)) AS minutes, SUM(COALESCE(ps.goals, 0)) AS goals,
           SUM(COALESCE(ps.assists, 0)) AS assists, COUNT(*) FILTER (WHERE COALESCE(ps.minutes, 0) > 0) AS apps
    FROM player_match_stats ps JOIN matches m ON m.id = ps.match_id
    WHERE ps.player_id = ? AND ps.team_id = ? AND m.kickoff_utc BETWEEN ? AND ?`);
  return players.map((p) => {
    const s = stat.get(p.id, teamId, since, cutoff);
    /* An eleven-man team plays 11 × 90 minutes a match. */
    const minutesShare = team?.matches ? (s.minutes ?? 0) / (team.matches * 990) : null;
    return {
      name: p.name, position: p.position, status: p.status, reason: p.reason,
      appearances: s.apps ?? 0, goals: s.goals ?? 0, assists: s.assists ?? 0,
      minutesShare: minutesShare === null ? null : round(minutesShare, 3),
      goalShare: team?.goals ? round((s.goals ?? 0) / team.goals, 3) : null,
    };
  }).sort((a, b) => (b.minutesShare ?? 0) - (a.minutesShare ?? 0));
}

function lineup(db, matchId, teamId, asOf) {
  const l = db.prepare('SELECT formation, status, fetched_at FROM lineups WHERE match_id = ? AND team_id = ? AND fetched_at <= ?')
    .get(matchId, teamId, asOf);
  if (!l) return null;
  const players = db.prepare(`SELECT p.name, lp.position, lp.role FROM lineup_players lp JOIN players p ON p.id = lp.player_id
                              WHERE lp.match_id = ? AND lp.team_id = ? AND lp.role = 'starter'`).all(matchId, teamId);
  return { formation: l.formation, status: l.status, starters: players.map((p) => `${p.name} (${p.position ?? '?'})`) };
}

/* ---------------------------------------------------------------- build */

/**
 * Build the packet for one match as of a moment.
 * Returns { features, freshness, model, history } — `history` (the matches
 * the model was fitted on) is not stored in the snapshot; it can be rebuilt
 * from the database with the same asOf.
 */
export function buildFeatures(db, matchId, asOf) {
  const m = db.prepare(`
    SELECT m.*, s.competition_id, s.label AS season_label, c.name AS competition_name, c.kind AS competition_kind,
           ht.name AS home_name, at.name AS away_name
    FROM matches m JOIN seasons s ON s.id = m.season_id JOIN competitions c ON c.id = s.competition_id
    JOIN teams ht ON ht.id = m.home_team_id JOIN teams at ON at.id = m.away_team_id WHERE m.id = ?`).get(matchId);
  if (!m) throw new Error('That match does not exist.');

  const cutoff = iso(Date.parse(asOf) - RESULT_LAG_MS);
  const history = knownResults(db, asOf);
  const H = m.home_team_id;
  const A = m.away_team_id;

  /* ------- the goals model, fitted on everything known before asOf */
  const fit = fitRatings(history, { asOf: cutoff });
  let goals = null;
  if (fit.ok) {
    const l = lambdas(fit, H, A, m.competition_id);
    goals = {
      expectedHome: round(l.home, 3), expectedAway: round(l.away, 3), rho: fit.rho,
      homeAdvantage: round(fit.home.get(m.competition_id) ?? 0, 3),
      ratings: {
        home: { attack: round(fit.attack.get(H) ?? 0, 3), defence: round(fit.defence.get(H) ?? 0, 3),
          weightedMatches: round(fit.exposure.get(H) ?? 0, 1) },
        away: { attack: round(fit.attack.get(A) ?? 0, 3), defence: round(fit.defence.get(A) ?? 0, 3),
          weightedMatches: round(fit.exposure.get(A) ?? 0, 1) },
      },
      fittedOn: fit.matches,
      likelyScores: topScores(scoreMatrix(l.home, l.away, fit.rho), 6),
    };
  }

  /* ------- corners and cards rates */
  const corners = {
    home: statRates(db, H, ['corners'], cutoff), away: statRates(db, A, ['corners'], cutoff),
    competition: competitionRates(db, m.competition_id, ['corners'], cutoff),
  };
  const cards = {
    home: statRates(db, H, ['yellow_cards', 'red_cards'], cutoff), away: statRates(db, A, ['yellow_cards', 'red_cards'], cutoff),
    competition: competitionRates(db, m.competition_id, ['yellow_cards', 'red_cards'], cutoff),
    referee: refereeRate(db, m.referee, cutoff),
  };

  /* ------- form, table, schedule, head-to-head */
  const table = tableFromResults(history, m.season_id);
  const pos = (id) => table.find((r) => r.teamId === id) ?? null;
  const daysSince = (id) => {
    const last = [...history].reverse().find((r) => r.homeId === id || r.awayId === id);
    return last ? Math.floor((Date.parse(m.kickoff_utc) - Date.parse(last.kickoffUtc)) / DAY) : null;
  };
  const recentCount = (id) => history.filter((r) => (r.homeId === id || r.awayId === id)
    && Date.parse(m.kickoff_utc) - Date.parse(r.kickoffUtc) <= 14 * DAY).length;
  const h2h = history.filter((r) => (r.homeId === H && r.awayId === A) || (r.homeId === A && r.awayId === H))
    .slice(-6).reverse().map((r) => ({ date: r.kickoffUtc.slice(0, 10), home: r.homeId === H ? m.home_name : m.away_name,
      score: `${r.homeGoals}-${r.awayGoals}` }));

  const xgRates = { home: statRates(db, H, ['xg'], cutoff, { limit: 10 }), away: statRates(db, A, ['xg'], cutoff, { limit: 10 }) };
  const shotRates = {
    home: statRates(db, H, ['shots_on_target'], cutoff, { limit: 10 }), away: statRates(db, A, ['shots_on_target'], cutoff, { limit: 10 }),
  };

  const side = (id, venue) => ({
    form5: form(history, id, { limit: 5 }),
    form10: form(history, id, { limit: 10 }),
    venueForm: form(history, id, { venue, limit: 8 }),
    table: pos(id),
    restDays: daysSince(id),
    matchesLast14Days: recentCount(id),
    xgPerMatch: xgRates[venue].matches ? { for: round(xgRates[venue].for, 2), against: round(xgRates[venue].against, 2), matches: xgRates[venue].matches } : null,
    shotsOnTargetPerMatch: shotRates[venue].matches ? { for: round(shotRates[venue].for, 2), against: round(shotRates[venue].against, 2), matches: shotRates[venue].matches } : null,
    cornersPerMatch: corners[venue].matches ? { for: round(corners[venue].for, 2), against: round(corners[venue].against, 2), matches: corners[venue].matches } : null,
    cardsPerMatch: cards[venue].matches ? { for: round(cards[venue].for, 2), against: round(cards[venue].against, 2), matches: cards[venue].matches } : null,
    absences: absences(db, m.id, id, asOf, cutoff),
    lineup: lineup(db, m.id, id, asOf),
  });

  const features = {
    match: {
      id: m.id, competition: m.competition_name, competitionKind: m.competition_kind, season: m.season_label,
      round: m.round, kickoffUtc: m.kickoff_utc, venue: m.venue_name, referee: m.referee,
      home: m.home_name, away: m.away_name,
    },
    asOf,
    home: side(H, 'home'),
    away: side(A, 'away'),
    headToHead: h2h,
    goalsModel: goals,
    countModels: {
      corners: corners.competition.perTeam === null ? null : {
        competitionTotalPerMatch: round(corners.competition.total, 2), competitionMatches: corners.competition.matches,
        dispersionSize: Number.isFinite(corners.competition.size) ? round(corners.competition.size, 2) : null,
      },
      cards: cards.competition.perTeam === null ? null : {
        competitionTotalPerMatch: round(cards.competition.total, 2), competitionMatches: cards.competition.matches,
        dispersionSize: Number.isFinite(cards.competition.size) ? round(cards.competition.size, 2) : null,
        referee: cards.referee ? { name: m.referee, matches: cards.referee.matches,
          cardsPerMatch: cards.referee.average === null ? null : round(cards.referee.average, 2) } : null,
      },
    },
  };

  const freshness = {
    latestResultUsed: history.length ? history[history.length - 1].kickoffUtc : null,
    resultsKnown: history.length,
    lineupsConfirmed: !!(features.home.lineup && features.away.lineup),
    injuryReports: features.home.absences.length + features.away.absences.length,
    statsMatches: { home: corners.home.matches, away: corners.away.matches },
  };

  const json = JSON.stringify(features);
  return {
    features, freshness, json,
    sha256: createHash('sha256').update(json).digest('hex'),
    model: { fit, goals, corners, cards, competitionId: m.competition_id, homeId: H, awayId: A },
  };
}

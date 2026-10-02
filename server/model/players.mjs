/* Player markets — anytime goalscorer.
 *
 * A player's expected goals in this match are
 *
 *     λ_team × share × expected minutes / 90
 *
 * where λ_team is the goals model's expected goals for his team, and
 * `share` is his share of the team's scoring rate while he is on the pitch:
 * his goals per 90 over the year before the match (shrunk toward a position
 * prior with a few pseudo-90s, so three lucky games are not a striker),
 * divided by the team's goals per match. P(scores) = 1 − e^(−expected).
 *
 * Expected minutes: from the confirmed lineup when SokkerLiga had it by
 * asOf (starter: his usual minutes as a starter; substitute: a fraction);
 * otherwise his average over the team's last five matches. Reported
 * missing → not priced; doubtful → half.
 *
 * Like everything in the model, only data from before asOf is read.
 */

export const SCORER_MODEL = { key: 'scorer-share', version: '1' };

const DAY = 86400_000;
const WINDOW_DAYS = 365;
const PRIOR_90S = 3;
/* Goals per 90 for an average player in each position, in a team scoring
 * 1.4 a match; scaled to the team's own rate. */
const POSITION_PRIOR = { Attacker: 0.38, Midfielder: 0.12, Defender: 0.04, Goalkeeper: 0 };
const MAX_PER_TEAM = 8;

const iso = (ms) => new Date(ms).toISOString();

function positionGroup(pos) {
  const p = String(pos ?? '').toLowerCase();
  if (p.startsWith('g')) return 'Goalkeeper';
  if (p.startsWith('d')) return 'Defender';
  if (p.startsWith('m')) return 'Midfielder';
  if (p.startsWith('a') || p.startsWith('f')) return 'Attacker';
  return 'Midfielder';
}

/**
 * @returns [{ market: 'anytime_scorer', line: null, selection: 'p:<id>', p, playerId, playerName, teamId,
 *             expectedMinutes, confidenceScore }]
 */
export function priceScorers(db, { matchId, asOf, cutoff, sides }) {
  const out = [];
  for (const { teamId, lambda } of sides) {
    out.push(...teamScorers(db, { matchId, teamId, lambda, asOf, cutoff }));
  }
  return out;
}

function teamScorers(db, { matchId, teamId, lambda, asOf, cutoff }) {
  const since = iso(Date.parse(cutoff) - WINDOW_DAYS * DAY);
  const teamMatches = db.prepare(`
    SELECT m.id, m.kickoff_utc,
           CASE WHEN m.home_team_id = ? THEN m.home_goals - COALESCE(m.home_et, 0) ELSE m.away_goals - COALESCE(m.away_et, 0) END AS gf
    FROM matches m
    WHERE (m.home_team_id = ? OR m.away_team_id = ?) AND m.kickoff_utc BETWEEN ? AND ?
      AND m.status_key = 'finished' AND EXISTS (SELECT 1 FROM player_match_stats ps WHERE ps.match_id = m.id AND ps.team_id = ?)
    ORDER BY m.kickoff_utc DESC`).all(teamId, teamId, teamId, since, cutoff, teamId);
  if (teamMatches.length < 5) return [];
  const teamGoals90 = Math.max(0.5, teamMatches.reduce((a, m) => a + (m.gf ?? 0), 0) / teamMatches.length);
  const recentIds = teamMatches.slice(0, 5).map((m) => m.id);

  /* Candidates: on the squad at asOf, or in a lineup SokkerLiga had by asOf. */
  const lineupKnown = !!db.prepare('SELECT 1 FROM lineups WHERE match_id = ? AND team_id = ? AND fetched_at <= ?')
    .get(matchId, teamId, asOf);
  const lineupRole = new Map(lineupKnown
    ? db.prepare('SELECT player_id, role FROM lineup_players WHERE match_id = ? AND team_id = ?').all(matchId, teamId)
      .map((r) => [r.player_id, r.role])
    : []);
  const squad = db.prepare(`
    SELECT p.id, p.name, COALESCE(r.position, p.position) AS position FROM team_rosters r JOIN players p ON p.id = r.player_id
    WHERE r.team_id = ? AND r.valid_from <= ? AND (r.valid_to IS NULL OR r.valid_to > ?)`).all(teamId, asOf, asOf);
  const candidates = new Map(squad.map((p) => [p.id, p]));
  for (const id of lineupRole.keys()) {
    if (!candidates.has(id)) {
      const p = db.prepare('SELECT id, name, position FROM players WHERE id = ?').get(id);
      if (p) candidates.set(id, p);
    }
  }
  const absent = new Map(db.prepare(`SELECT player_id, status FROM availability
                                      WHERE match_id = ? AND team_id = ? AND first_reported_at <= ?`)
    .all(matchId, teamId, asOf).map((r) => [r.player_id, r.status]));

  const stats = db.prepare(`
    SELECT SUM(COALESCE(ps.minutes, 0)) AS minutes, SUM(COALESCE(ps.goals, 0)) AS goals,
           SUM(CASE WHEN ps.is_substitute = 0 AND ps.minutes > 0 THEN ps.minutes END) AS start_minutes,
           COUNT(*) FILTER (WHERE ps.is_substitute = 0 AND ps.minutes > 0) AS starts
    FROM player_match_stats ps JOIN matches m ON m.id = ps.match_id
    WHERE ps.player_id = ? AND ps.team_id = ? AND m.kickoff_utc BETWEEN ? AND ?`);
  const recent = db.prepare(`SELECT SUM(COALESCE(minutes, 0)) AS minutes FROM player_match_stats
                             WHERE player_id = ? AND team_id = ? AND match_id IN (${recentIds.join(',')})`);

  const priced = [];
  for (const p of candidates.values()) {
    if (absent.get(p.id) === 'missing') continue;
    const group = positionGroup(p.position);
    if (group === 'Goalkeeper') continue;
    const s = stats.get(p.id, teamId, since, cutoff);
    const minutes = s.minutes ?? 0;
    const role = lineupRole.get(p.id);
    if (lineupKnown && !role) continue;           // not in the matchday squad
    if (!role && minutes < 270) continue;         // too little evidence without a lineup

    const startAvg = s.starts ? s.start_minutes / s.starts : 80;
    let expectedMinutes;
    if (role === 'starter') expectedMinutes = Math.min(90, Math.max(60, startAvg));
    else if (role === 'sub') expectedMinutes = 0.55 * 22;
    else expectedMinutes = (recent.get(p.id, teamId).minutes ?? 0) / recentIds.length;
    if (absent.get(p.id) === 'doubtful') expectedMinutes *= 0.5;
    if (expectedMinutes < 15) continue;

    const prior90 = POSITION_PRIOR[group] * (teamGoals90 / 1.4);
    const goals90 = ((s.goals ?? 0) + PRIOR_90S * prior90) / (minutes / 90 + PRIOR_90S);
    const share = goals90 / teamGoals90;
    const expected = lambda * share * (expectedMinutes / 90);
    const prob = 1 - Math.exp(-expected);
    if (prob < 0.05) continue;

    /* Confidence: how much of the evidence is his own, and whether the
     * lineup was known. */
    const evidence = Math.min(1, minutes / 1800);
    const score = 0.6 * evidence + 0.3 * (lineupKnown ? 1 : 0) + 0.1;
    priced.push({
      market: 'anytime_scorer', line: null, selection: `p:${p.id}`, p: Math.min(0.95, prob),
      playerId: p.id, playerName: p.name, teamId, expectedMinutes: Math.round(expectedMinutes),
      confidenceScore: Math.round(score * 1000) / 1000,
    });
  }
  return priced.sort((a, b) => b.p - a.p).slice(0, MAX_PER_TEAM);
}

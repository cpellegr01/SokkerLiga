/* A simulated league written straight into a test database: teams, a
 * season of results with corners and cards, and one fixture still to play.
 * Deterministic, so analysis tests see the same numbers every run. */

const DAY = 86400_000;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function poissonDraw(l, r) {
  const L = Math.exp(-l);
  let k = 0; let p = 1;
  do { k += 1; p *= r(); } while (p > L);
  return k - 1;
}

/**
 * @returns {{ seasonId, teamIds, upcomingId, lastKickoff, matchIds }}
 */
export function seedLeague(db, { teams = 10, start = Date.now() - 200 * DAY, seed = 11, upcomingInDays = 2 } = {}) {
  const r = rng(seed);
  const comp = db.prepare("SELECT id FROM competitions WHERE key = 'premier-league'").get().id;
  db.prepare(`INSERT INTO seasons (competition_id, year, label, start_date, end_date, is_current) VALUES (?, 2026, '2026/27', ?, ?, 1)
              ON CONFLICT(competition_id, year) DO UPDATE SET is_current = 1`).run(comp, new Date(start).toISOString().slice(0, 10), '2027-05-30');
  const seasonId = db.prepare('SELECT id FROM seasons WHERE competition_id = ? AND year = 2026').get(comp).id;
  const now = new Date().toISOString();

  const teamIds = [];
  const strength = [];
  for (let i = 0; i < teams; i += 1) {
    const id = Number(db.prepare(`INSERT INTO teams (name, source_key, source_ref, fetched_at) VALUES (?, 'api-football', ?, ?)`)
      .run(`Team ${String.fromCharCode(65 + i)}`, `t${seed}-${i}`, now).lastInsertRowid);
    teamIds.push(id);
    strength.push({ attack: 0.35 - i * 0.07, defence: -0.25 + i * 0.05, corners: 6.5 - i * 0.3, cards: 1.6 + i * 0.08 });
  }

  const insertMatch = db.prepare(`INSERT INTO matches (season_id, kickoff_utc, home_team_id, away_team_id, status_key,
      home_goals, away_goals, referee, result_confirmed_at, source_key, source_ref, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'api-football', ?, ?)`);
  const insertStat = db.prepare(`INSERT INTO team_match_stats (match_id, team_id, stat_key, value, source_key, fetched_at)
      VALUES (?, ?, ?, ?, 'api-football', ?)`);
  const matchIds = [];
  let t = start;
  let n = 0;
  for (let h = 0; h < teams; h += 1) {
    for (let a = 0; a < teams; a += 1) {
      if (h === a) continue;
      t += 1.6 * DAY;
      const kickoff = new Date(t).toISOString();
      const lh = Math.exp(0.15 + 0.25 + strength[h].attack + strength[a].defence);
      const la = Math.exp(0.15 + strength[a].attack + strength[h].defence);
      const id = Number(insertMatch.run(seasonId, kickoff, teamIds[h], teamIds[a], 'finished',
        poissonDraw(lh, r), poissonDraw(la, r), n % 3 === 0 ? 'Ref One' : 'Ref Two',
        new Date(t + 4 * 3600_000).toISOString(), `m${seed}-${n}`, now).lastInsertRowid);
      insertStat.run(id, teamIds[h], 'corners', poissonDraw(strength[h].corners, r), now);
      insertStat.run(id, teamIds[a], 'corners', poissonDraw(strength[a].corners - 0.8, r), now);
      insertStat.run(id, teamIds[h], 'yellow_cards', poissonDraw(strength[h].cards, r), now);
      insertStat.run(id, teamIds[a], 'yellow_cards', poissonDraw(strength[a].cards + 0.3, r), now);
      matchIds.push(id);
      n += 1;
    }
  }
  const upcomingKickoff = new Date(Date.now() + upcomingInDays * DAY).toISOString();
  const upcomingId = Number(insertMatch.run(seasonId, upcomingKickoff, teamIds[0], teamIds[teams - 1], 'scheduled',
    null, null, 'Ref One', null, `m${seed}-up`, now).lastInsertRowid);
  return { seasonId, teamIds, upcomingId, matchIds, lastKickoff: new Date(t).toISOString() };
}

/** A stand-in for the Claude adapter that records what it was given. */
export function fakeExplainer({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    model: 'fake-explainer',
    promptKey: 'match-analysis',
    promptVersion: '1',
    async explain({ packet, candidates }) {
      calls.push({ packet, candidates });
      if (fail) { const e = new Error(fail.message); e.status = fail.status; throw e; }
      return {
        servedBy: 'fake-explainer',
        usage: { inputTokens: 5000, outputTokens: 1200, costCents: 4.4 },
        explanation: {
          summary: 'Team A are clear favourites on form and ratings.',
          narrative: 'Long form.',
          keyFactors: [{ label: 'Form', favours: 'home', evidence: '13 of 15 points' }],
          marketViews: candidates.slice(0, 2).map((c, i) => ({
            candidateId: c.candidate_id, stance: i === 0 ? 'support' : 'caution',
            factorsFor: [{ label: 'Attack rating', evidence: 'Best in the league' }],
            factorsAgainst: i === 0 ? [] : [{ label: 'Thin sample', evidence: 'Only 9 matches' }],
          })),
          dataGaps: ['No xG for this competition'],
        },
      };
    },
  };
}

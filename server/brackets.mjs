/* Knockout brackets, built from the fixtures already stored.
 *
 * The provider gives each match a round name ("Round of 16", "Quarter-
 * finals", "Final", "Play-offs - Round One"); group and league-phase rounds
 * are left out. Within a round, matches between the same two teams are one
 * tie: one leg, two legs (aggregate, then extra time and penalties in the
 * second leg), or a best-of-three series (MLS). Rounds are ordered by when
 * they are played; ties are arranged so that the two ties feeding a later
 * tie sit next to each other, as in a printed bracket.
 */

const GROUP_ROUND = /regular season|league stage|league phase|group|^league [a-z]\b|matchday|^league$/i;
const QUALIFYING = /qualif|preliminary/i;
const THIRD_PLACE = /3rd place|third place/i;

/** Competitions with knockout matches, for the picker. */
export function bracketCompetitions(db) {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.logo_url AS logo, c.country_name AS country, s.id AS season_id, s.label, s.is_current, m.round
    FROM matches m JOIN seasons s ON s.id = m.season_id JOIN competitions c ON c.id = s.competition_id
    WHERE c.is_enabled = 1 AND m.round IS NOT NULL
    GROUP BY c.id, s.id, m.round`).all();
  const by = new Map();
  for (const r of rows) {
    if (GROUP_ROUND.test(r.round) || QUALIFYING.test(r.round)) continue;
    if (!by.has(r.id)) by.set(r.id, { id: r.id, name: r.name, logo: r.logo, country: r.country, seasons: new Map() });
    by.get(r.id).seasons.set(r.season_id, { id: r.season_id, label: r.label, isCurrent: !!r.is_current });
  }
  return [...by.values()].map((c) => ({ ...c, seasons: [...c.seasons.values()].sort((a, b) => b.label.localeCompare(a.label)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function tieOf(legs) {
  const [a, b] = [legs[0].home, legs[0].away];
  const team = (t) => ({ id: t.id, name: t.name, logo: t.logo, goals: 0, wins: 0, pens: null, winner: false });
  const A = team(a);
  const B = team(b);
  const side = (id) => (id === A.id ? A : B);
  const decided = legs.every((l) => ['finished', 'awarded'].includes(l.status));
  for (const l of legs) {
    if (l.homeGoals === null) continue;
    side(l.home.id).goals += l.homeGoals;
    side(l.away.id).goals += l.awayGoals;
    let homeWon = l.homeGoals > l.awayGoals;
    let awayWon = l.awayGoals > l.homeGoals;
    if (!homeWon && !awayWon && l.homePens !== null) { homeWon = l.homePens > l.awayPens; awayWon = !homeWon; }
    if (homeWon) side(l.home.id).wins += 1;
    if (awayWon) side(l.away.id).wins += 1;
  }
  const last = legs[legs.length - 1];
  if (last.homePens !== null && last.awayPens !== null) {
    side(last.home.id).pens = last.homePens;
    side(last.away.id).pens = last.awayPens;
  }
  const series = legs.length >= 3;
  if (decided) {
    let w = null;
    if (series) w = A.wins === B.wins ? null : A.wins > B.wins ? A : B;
    else if (A.goals !== B.goals) w = A.goals > B.goals ? A : B;
    else if (A.pens !== null) w = A.pens > B.pens ? A : B;
    if (w) w.winner = true;
  }
  return {
    key: legs.map((l) => l.id).join('-'), kind: series ? 'series' : legs.length === 2 ? 'two-legs' : 'single',
    decided: decided && (A.winner || B.winner),
    teams: [A, B],
    legs: legs.map((l) => ({ matchId: l.id, kickoffUtc: l.kickoffUtc, status: l.status, home: l.home.name, away: l.away.name,
      score: l.homeGoals === null ? null : `${l.homeGoals}–${l.awayGoals}`,
      pens: l.homePens === null ? null : `${l.homePens}–${l.awayPens}` })),
    firstKickoff: legs[0].kickoffUtc,
  };
}

/**
 * @returns {{ competition, season, rounds: [{ name, ties }], thirdPlace, qualifying: [{ name, ties }] }}
 */
export function bracket(db, competitionId, seasonId = null) {
  const season = seasonId
    ? db.prepare('SELECT * FROM seasons WHERE id = ? AND competition_id = ?').get(Number(seasonId), Number(competitionId))
    : db.prepare(`SELECT s.* FROM seasons s WHERE s.competition_id = ? AND EXISTS (SELECT 1 FROM matches m WHERE m.season_id = s.id)
                  ORDER BY s.is_current DESC, s.year DESC LIMIT 1`).get(Number(competitionId));
  const competition = db.prepare('SELECT id, name, logo_url AS logo, country_name AS country FROM competitions WHERE id = ?')
    .get(Number(competitionId));
  if (!competition || !season) return { competition: competition ?? null, season: null, rounds: [], thirdPlace: null, qualifying: [] };

  const rows = db.prepare(`
    SELECT m.id, m.round, m.kickoff_utc, m.status_key, m.home_goals, m.away_goals, m.home_pens, m.away_pens,
           ht.id AS hid, ht.name AS hname, ht.logo_url AS hlogo, at.id AS aid, at.name AS aname, at.logo_url AS alogo
    FROM matches m JOIN teams ht ON ht.id = m.home_team_id JOIN teams at ON at.id = m.away_team_id
    WHERE m.season_id = ? AND m.round IS NOT NULL AND m.status_key NOT IN ('cancelled')
    ORDER BY m.kickoff_utc`).all(season.id);

  const rounds = new Map();
  for (const r of rows) {
    if (GROUP_ROUND.test(r.round)) continue;
    if (!rounds.has(r.round)) rounds.set(r.round, []);
    rounds.get(r.round).push({
      id: r.id, kickoffUtc: r.kickoff_utc, status: r.status_key, homeGoals: r.home_goals, awayGoals: r.away_goals,
      homePens: r.home_pens, awayPens: r.away_pens,
      home: { id: r.hid, name: r.hname, logo: r.hlogo }, away: { id: r.aid, name: r.aname, logo: r.alogo },
    });
  }

  const built = [...rounds].map(([name, matches]) => {
    const ties = new Map();
    for (const m of matches) {
      const k = [m.home.id, m.away.id].sort((x, y) => x - y).join('|');
      if (!ties.has(k)) ties.set(k, []);
      ties.get(k).push(m);
    }
    return { name, firstKickoff: matches[0].kickoffUtc, ties: [...ties.values()].map(tieOf) };
  }).sort((a, b) => a.firstKickoff.localeCompare(b.firstKickoff));

  const thirdPlace = built.find((r) => THIRD_PLACE.test(r.name)) ?? null;
  const qualifying = built.filter((r) => QUALIFYING.test(r.name));
  const main = built.filter((r) => !THIRD_PLACE.test(r.name) && !QUALIFYING.test(r.name));

  /* Arrange from the final backwards: the ties whose teams play in a later
   * tie go together, in that tie's order. */
  for (let i = main.length - 2; i >= 0; i -= 1) {
    const later = main[i + 1].ties;
    const pool = [...main[i].ties];
    const ordered = [];
    for (const t of later) {
      const ids = new Set(t.teams.map((x) => x.id));
      for (let j = 0; j < pool.length; j += 1) {
        if (pool[j].teams.some((x) => ids.has(x.id))) { ordered.push(pool[j]); pool.splice(j, 1); j -= 1; }
      }
    }
    main[i].ties = [...ordered, ...pool.sort((a, b) => a.firstKickoff.localeCompare(b.firstKickoff))];
  }

  /* Rounds still to come: halve until the final, each slot waiting for
   * the winners of two neighbouring ties. Until the fixtures exist this is
   * the bracket's order, not a confirmed draw. */
  const NAMES = { 1: 'Final', 2: 'Semi-finals', 4: 'Quarter-finals', 8: 'Round of 16', 16: 'Round of 32' };
  const label = (t) => t.placeholder ?? t.teams.map((x) => x.name).join(' v ');
  const projected = [];
  let prev = main.at(-1)?.ties ?? [];
  while (prev.length > 1 && (prev.length & (prev.length - 1)) === 0) {
    const ties = [];
    for (let i = 0; i < prev.length; i += 2) {
      ties.push({ key: `p${projected.length}-${i}`, kind: 'projected', decided: false, legs: [],
        slots: [prev[i], prev[i + 1]].map((t) => {
          const w = t.teams?.find((x) => x.winner);
          return w ? { id: w.id, name: w.name, logo: w.logo } : { placeholder: `Winner of ${label(t)}` };
        }) });
    }
    projected.push({ name: NAMES[ties.length] ?? `Round of ${ties.length * 2}`, ties, projected: true });
    prev = ties.map((t) => ({ placeholder: t.slots.map((x) => x.name ?? x.placeholder.replace(/^Winner of /, '')).join(' / '), teams: null }));
  }

  return {
    competition,
    season: { id: season.id, label: season.label },
    rounds: [...main.map(({ name, ties }) => ({ name, ties })), ...projected],
    thirdPlace: thirdPlace ? { name: thirdPlace.name, ties: thirdPlace.ties } : null,
    qualifying: qualifying.map(({ name, ties }) => ({ name, ties })),
  };
}

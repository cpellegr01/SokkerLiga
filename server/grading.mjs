/* Grading: did a selection win?
 *
 * One rule set per market type, used for both predictions and bet legs, so
 * the two can never disagree. Pure: takes the match facts, returns an
 * outcome — or null when the facts are not enough (a corners market with no
 * corner counts), in which case nothing is graded automatically.
 *
 * Rules follow the common bookmaker conventions; betting apps differ at the
 * edges, which is why every bet can be corrected by hand.
 *  - Regular time only (extra time and penalties do not count).
 *  - Whole-line totals and Asian handicaps can push; quarter lines split
 *    the stake over the two neighbouring lines (half won / half lost).
 *  - Draw no bet: a draw is a push.
 *  - Postponed, cancelled or abandoned: pending for 48 hours, then void.
 *    Awarded matches (decided off the pitch) are void.
 *  - Anytime scorer: a goal in regular time (stoppage time included, extra
 *    time not); own goals do not count; a player who did not play is void.
 */

const VOID_AFTER_MS = 48 * 3600_000;

/** Facts for grading one match, read from the database. */
export function matchFacts(db, matchId) {
  const m = db.prepare(`SELECT id, status_key, kickoff_utc, home_team_id, away_team_id, home_goals, away_goals,
                               home_et, away_et, result_confirmed_at FROM matches WHERE id = ?`).get(matchId);
  if (!m) return null;
  const stat = (keys) => {
    const rows = db.prepare(`SELECT team_id, SUM(value) AS v FROM team_match_stats
                             WHERE match_id = ? AND stat_key IN (${keys.map(() => '?').join(',')}) GROUP BY team_id`)
      .all(matchId, ...keys);
    const home = rows.find((r) => r.team_id === m.home_team_id)?.v;
    const away = rows.find((r) => r.team_id === m.away_team_id)?.v;
    return home === undefined || away === undefined || home === null || away === null ? null : home + away;
  };
  /* Who scored in regular time (minute 90 + stoppage is still regular
   * time; extra time is minute 91 onward), and who played at all. */
  const scorers = new Set(db.prepare(`SELECT player_id FROM match_events WHERE match_id = ? AND player_id IS NOT NULL
                                        AND type_key IN ('goal', 'penalty_goal') AND COALESCE(minute, 0) <= 90`)
    .all(matchId).map((r) => r.player_id));
  const appearances = db.prepare('SELECT player_id, minutes FROM player_match_stats WHERE match_id = ?').all(matchId);
  return {
    status: m.status_key,
    kickoffUtc: m.kickoff_utc,
    scorers,
    played: appearances.length ? new Set(appearances.filter((r) => (r.minutes ?? 0) > 0).map((r) => r.player_id)) : null,
    confirmed: !!m.result_confirmed_at,
    /* Regular time: extra-time goals come off the final score. */
    home: m.home_goals === null ? null : m.home_goals - (m.home_et ?? 0),
    away: m.away_goals === null ? null : m.away_goals - (m.away_et ?? 0),
    corners: stat(['corners']),
    cards: stat(['yellow_cards', 'red_cards']),
  };
}

/**
 * @returns {'won'|'lost'|'push'|'void'|'half_won'|'half_lost'|'pending'|null}
 *   pending: not decided yet. null: decided, but the facts needed are missing.
 */
export function grade(market, line, selection, facts, now = Date.now()) {
  if (!facts) return null;
  if (['postponed', 'cancelled', 'abandoned', 'suspended'].includes(facts.status)) {
    return now - Date.parse(facts.kickoffUtc) >= VOID_AFTER_MS ? 'void' : 'pending';
  }
  if (facts.status === 'awarded') return 'void';
  if (facts.status !== 'finished' || !facts.confirmed) return 'pending';
  if (facts.home === null || facts.away === null) return null;

  const { home: h, away: a } = facts;
  const diff = h - a;
  switch (market) {
    case 'match_result':
      return outcome(selection === 'home' ? diff > 0 : selection === 'away' ? diff < 0 : diff === 0);
    case 'double_chance':
      return outcome({ home_draw: diff >= 0, home_away: diff !== 0, draw_away: diff <= 0 }[selection]);
    case 'draw_no_bet':
      if (diff === 0) return 'push';
      return outcome(selection === 'home' ? diff > 0 : diff < 0);
    case 'btts':
      return outcome(selection === 'yes' ? h > 0 && a > 0 : !(h > 0 && a > 0));
    case 'over_under':
      return total(h + a, line, selection);
    case 'home_total':
      return total(h, line, selection);
    case 'away_total':
      return total(a, line, selection);
    case 'corners_ou':
      return facts.corners === null ? null : total(facts.corners, line, selection);
    case 'cards_ou':
      return facts.cards === null ? null : total(facts.cards, line, selection);
    case 'asian_handicap':
      /* The line is the home side's; the away side has the opposite line. */
      return asian(selection === 'home' ? diff : -diff, selection === 'home' ? line : -line);
    case 'european_handicap': {
      const adj = diff + line;
      return outcome(selection === 'home' ? adj > 0 : selection === 'away' ? adj < 0 : adj === 0);
    }
    case 'anytime_scorer': {
      const id = playerOf(selection);
      if (id === null || !facts.played) return null;
      if (!facts.played.has(id)) return 'void';
      return outcome(facts.scorers.has(id));
    }
    default:
      return null;
  }
}

const outcome = (won) => (won ? 'won' : 'lost');

/** Player markets key their selection by player: 'p:123'. */
export const playerOf = (selection) => {
  const m = /^p:(\d+)$/.exec(selection ?? '');
  return m ? Number(m[1]) : null;
};

function total(n, line, selection) {
  if (n === line) return 'push';
  return outcome(selection === 'over' ? n > line : n < line);
}

/** One side of an Asian handicap: `margin` is that side's goal margin. */
function asian(margin, line) {
  if (Math.abs(line % 0.5) === 0.25) {
    const a = asian(margin, line - 0.25);
    const b = asian(margin, line + 0.25);
    if (a === b) return a;
    const pair = [a, b].sort().join('+');
    if (pair === 'push+won') return 'half_won';
    if (pair === 'lost+push') return 'half_lost';
    return a; // cannot happen for adjacent half-lines
  }
  const adj = margin + line;
  if (adj === 0) return 'push';
  return outcome(adj > 0);
}

/* ------------------------------------------------------- money */

/** Multiplier on the stake that comes back, per leg outcome. */
export function returnFactor(outcome, odds) {
  switch (outcome) {
    case 'won': return odds;
    case 'lost': return 0;
    case 'push': case 'void': return 1;
    case 'half_won': return (odds + 1) / 2;
    case 'half_lost': return 0.5;
    default: return null;
  }
}

/**
 * Settle a whole bet from its legs' outcomes.
 * Single: the leg decides. Parlay: any lost leg loses it; void and pushed
 * legs drop out (factor 1); half results apply proportionally; any leg
 * still pending (or ungradable) keeps the bet pending.
 * @returns {{ outcome, profitMinor }}
 */
export function settleBet({ stakeMinor, totalOdds, legs }) {
  if (legs.some((l) => l.outcome === 'lost')) return { outcome: 'lost', profitMinor: -stakeMinor };
  if (legs.some((l) => !l.outcome || l.outcome === 'pending')) return { outcome: 'pending', profitMinor: null };

  if (legs.length === 1) {
    const f = returnFactor(legs[0].outcome, totalOdds);
    return { outcome: legs[0].outcome, profitMinor: Math.round(stakeMinor * f) - stakeMinor };
  }
  /* A parlay's quoted total can differ from the product of the legs (boosts,
   * rounding); scale each leg so the legs multiply to the quoted total. */
  const product = legs.reduce((a, l) => a * l.odds, 1);
  const scale = (totalOdds / product) ** (1 / legs.length);
  const factor = legs.reduce((a, l) => a * returnFactor(l.outcome, l.odds * scale), 1);
  const profitMinor = Math.round(stakeMinor * factor) - stakeMinor;
  const allVoid = legs.every((l) => l.outcome === 'void');
  const out = allVoid ? 'void' : profitMinor > 0 ? 'won' : profitMinor < 0 ? 'lost' : 'push';
  return { outcome: out, profitMinor };
}

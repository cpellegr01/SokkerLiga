/* Bets recorded by hand, their settlement, and the Betting History.
 *
 * SokkerLiga never places a bet. Claudio bets in his betting app, then
 * records it here with the odds he got. At that moment each leg is linked
 * to the model's latest prediction made before both the bet and kickoff,
 * and the model's probability, fair odds, edge and EV are frozen onto the
 * leg — later re-analysis never changes what the bet was judged against.
 *
 * Settlement is automatic once a result is confirmed (grading.mjs) and
 * written as history rows; a manual correction is another row and takes
 * precedence over automatic settlement from then on.
 */

import { ValidationError, transaction } from './db.mjs';
import { grade, matchFacts, settleBet, playerOf } from './grading.mjs';
import { parseOdds, parseMoney, oddsHint, parseContractPrice } from '../src/odds.js';
import { selectionLabel } from '../src/markets.js';

const nowIso = () => new Date().toISOString();

/* ---------------------------------------------------------- sportsbooks */

export function listSportsbooks(db) {
  return db.prepare('SELECT key, name, currency, is_active AS isActive FROM sportsbooks ORDER BY is_active DESC, name').all()
    .map((s) => ({ ...s, isActive: !!s.isActive }));
}

export function saveSportsbook(db, { key, name, currency = 'USD', isActive = true }) {
  const clean = String(name ?? '').trim();
  if (!clean) throw new ValidationError('Give the betting app a name.');
  const cur = String(currency).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur)) throw new ValidationError('Currency must be a three-letter code such as USD, EUR or GBP.');
  const k = key ?? clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!k) throw new ValidationError('That name cannot be used.');
  db.prepare(`INSERT INTO sportsbooks (key, name, currency, is_active, created_at) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET name = excluded.name, currency = excluded.currency, is_active = excluded.is_active`)
    .run(k, clean, cur, isActive ? 1 : 0, nowIso());
  return listSportsbooks(db);
}

/* ------------------------------------------------------------ helpers */

function selectionId(db, matchId, market, line, selection) {
  const mt = db.prepare('SELECT has_line FROM market_types WHERE key = ?').get(market);
  if (!mt) throw new ValidationError(`Unknown market: ${market}`);
  const l = mt.has_line ? Number(line) : null;
  if (mt.has_line && !Number.isFinite(l)) throw new ValidationError('This market needs a line, such as 2.5.');
  db.prepare('INSERT OR IGNORE INTO markets (match_id, market_type_key, line) VALUES (?, ?, ?)').run(matchId, market, l);
  const marketId = db.prepare('SELECT id FROM markets WHERE match_id = ? AND market_type_key = ? AND line IS ?')
    .get(matchId, market, l).id;
  db.prepare('INSERT OR IGNORE INTO selections (market_id, key) VALUES (?, ?)').run(marketId, selection);
  return db.prepare('SELECT id FROM selections WHERE market_id = ? AND key = ?').get(marketId, selection).id;
}

/* The model's view at the moment of the bet: the latest prediction for this
 * selection made before both the bet and kickoff. */
function modelAtBet(db, selectionId, placedAt) {
  const p = db.prepare(`
    SELECT p.id, COALESCE(p.calibrated_probability, p.model_probability) AS model_probability, p.fair_odds,
           r.id AS rec_id, r.decision
    FROM predictions p JOIN matches m ON m.id = p.match_id
    LEFT JOIN recommendations r ON r.prediction_id = p.id
    WHERE p.selection_id = ? AND p.created_at <= ? AND p.created_at < m.kickoff_utc
    ORDER BY p.created_at DESC, p.id DESC LIMIT 1`).get(selectionId, placedAt);
  return p ?? null;
}

const VALID_SELECTIONS = {
  match_result: ['home', 'draw', 'away'], double_chance: ['home_draw', 'home_away', 'draw_away'],
  draw_no_bet: ['home', 'away'], over_under: ['over', 'under'], btts: ['yes', 'no'],
  asian_handicap: ['home', 'away'], european_handicap: ['home', 'draw', 'away'],
  home_total: ['over', 'under'], away_total: ['over', 'under'], corners_ou: ['over', 'under'], cards_ou: ['over', 'under'],
};

/* The price actually paid per contract, as odds: 14 contracts for 9.52 is
 * 68¢ each, decimal 1.4706. */
function fillOdds(stakeMinor, contracts) {
  const cents = stakeMinor / contracts;
  return { decimal: Math.round((contracts * 100 / stakeMinor) * 10000) / 10000, format: 'percent',
    text: `${Number(cents.toFixed(2))}¢` };
}

/** Validate and normalise a bet as sent by the bet slip. */
function normaliseBet(db, input) {
  const book = db.prepare('SELECT * FROM sportsbooks WHERE key = ?').get(input.sportsbook);
  if (!book) throw new ValidationError('Choose the betting app the bet was placed with.');
  const stakeMinor = Number.isInteger(input.stakeMinor) ? input.stakeMinor : parseMoney(input.stake);
  if (!stakeMinor || stakeMinor <= 0) throw new ValidationError('Enter how much you bet.');
  /* Fees as the app states them, on top of the bet; lost whatever happens. */
  const charge = (minor, typed, label) => {
    if (Number.isInteger(minor)) return minor;
    if (typed === undefined || typed === null || String(typed).trim() === '') return 0;
    const raw = String(typed).trim().replace(/^[^0-9.,-]+/, '').replace(',', '.');
    const v = /^-?\d*\.?\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(v) || v < 0) throw new ValidationError(`${label} must be an amount, such as 0.28.`);
    return Math.round(v * 100);
  };
  const feeMinor = charge(input.feeMinor, input.fee, 'Fees');
  const commissionMinor = charge(input.commissionMinor, input.commission, 'Commissions');
  const legs = Array.isArray(input.legs) ? input.legs : [];
  if (!legs.length) throw new ValidationError('A bet needs at least one selection.');

  /* Contracts (Robinhood, Kalshi…): each pays exactly 1.00 if it wins, so
   * the payout is the contract count. A contract bet can give its limit
   * price instead of odds: the price actually paid is bet ÷ contracts. */
  let contracts = null;
  if (input.contracts !== undefined && input.contracts !== null && String(input.contracts).trim() !== '') {
    contracts = Number(String(input.contracts).replace(',', '.'));
    if (!(contracts > 0)) throw new ValidationError('Contracts must be a number above zero, such as 14.');
    if (contracts * 100 <= stakeMinor) throw new ValidationError('The contracts would pay back no more than the bet; check the bet and the contracts.');
  }
  const limitPrice = parseContractPrice(input.limitPrice);
  if (input.limitPrice && String(input.limitPrice).trim() !== '' && limitPrice === null) {
    throw new ValidationError('The limit price must be between 1¢ and 99¢, such as 68¢.');
  }
  if (limitPrice !== null && !contracts) throw new ValidationError('A limit price needs the number of contracts.');
  const filled = contracts ? fillOdds(stakeMinor, contracts) : null;
  const placedAt = input.placedAt ? new Date(input.placedAt) : new Date();
  if (Number.isNaN(placedAt.getTime())) throw new ValidationError('That date and time are not valid.');
  if (placedAt.getTime() > Date.now() + 5 * 60_000) throw new ValidationError('A bet cannot be placed in the future.');

  const seen = new Set();
  const out = legs.map((leg, i) => {
    const match = db.prepare('SELECT id, kickoff_utc FROM matches WHERE id = ?').get(Number(leg.matchId));
    if (!match) throw new ValidationError(`Selection ${i + 1}: that match does not exist.`);
    if (leg.market === 'anytime_scorer') {
      const pid = playerOf(leg.selection);
      if (pid === null || !db.prepare('SELECT 1 FROM players WHERE id = ?').get(pid)) {
        throw new ValidationError(`Selection ${i + 1}: choose the player.`);
      }
    } else if (!VALID_SELECTIONS[leg.market]?.includes(leg.selection)) {
      throw new ValidationError(`Selection ${i + 1}: "${leg.selection}" is not a valid choice for this market.`);
    }
    const typed = String(leg.odds ?? '').trim();
    const odds = !typed && filled && legs.length === 1 ? filled : parseOdds(leg.odds);
    if (!odds) throw new ValidationError(`Selection ${i + 1}: ${oddsHint(leg.odds).message}`);
    const selId = selectionId(db, match.id, leg.market, leg.line, leg.selection);
    if (seen.has(selId)) throw new ValidationError('The same selection is in the bet twice.');
    seen.add(selId);
    return { ordinal: i + 1, matchId: match.id, selectionId: selId, odds, closingOdds: parseOdds(leg.closingOdds)?.decimal ?? null };
  });

  const kind = out.length > 1 ? 'parlay' : 'single';
  const product = out.reduce((a, l) => a * l.odds.decimal, 1);
  const total = input.totalOdds ? parseOdds(input.totalOdds) : null;
  if (input.totalOdds && !total) throw new ValidationError('The total odds are not valid.');
  let totalOdds = Math.round((total?.decimal ?? product) * 10000) / 10000;
  if (contracts) totalOdds = filled.decimal;
  return {
    book, stakeMinor, feeMinor, commissionMinor, contracts, limitPrice, placedAt: placedAt.toISOString(), kind, legs: out, totalOdds,
    totalOddsText: total?.text ?? null, notes: input.notes?.trim() || null,
    potentialPayoutMinor: contracts ? Math.round(contracts * 100) : Math.round(stakeMinor * totalOdds),
  };
}

function writeLegs(db, betId, bet) {
  const insert = db.prepare(`INSERT INTO bet_legs (bet_id, ordinal, match_id, selection_id, odds_taken, odds_text, odds_format,
      prediction_id, recommendation_id, model_probability_at_bet, fair_odds_at_bet, edge_at_bet, ev_at_bet,
      followed_recommendation, closing_odds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const leg of bet.legs) {
    const m = modelAtBet(db, leg.selectionId, bet.placedAt);
    const p = m?.model_probability ?? null;
    const o = leg.odds.decimal;
    insert.run(betId, leg.ordinal, leg.matchId, leg.selectionId, o, leg.odds.text, leg.odds.format,
      m?.id ?? null, m?.rec_id ?? null, p, m?.fair_odds ?? null,
      p === null ? null : round(p - 1 / o), p === null ? null : round(p * (o - 1) - (1 - p)),
      m ? (m.decision === 'recommend' ? 1 : 0) : null, leg.closingOdds);
  }
}

const round = (x) => Math.round(x * 10000) / 10000;

/* ------------------------------------------------------------ writes */

export function createBet(db, userId, input) {
  const bet = normaliseBet(db, input);
  const id = transaction(db, () => {
    const at = nowIso();
    const betId = Number(db.prepare(`INSERT INTO bets (user_id, placed_at, sportsbook_key, kind, stake_minor, fee_minor, commission_minor, contracts, limit_price,
        currency, total_odds, total_odds_text, potential_payout_minor, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, bet.placedAt, bet.book.key, bet.kind, bet.stakeMinor, bet.feeMinor, bet.commissionMinor, bet.contracts, bet.limitPrice, bet.book.currency, bet.totalOdds,
        bet.totalOddsText, bet.potentialPayoutMinor, bet.notes, at, at).lastInsertRowid);
    writeLegs(db, betId, bet);
    return betId;
  });
  settleBets(db, { betIds: [id] });
  return getBet(db, id, userId);
}

function snapshotBet(db, id) {
  const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(id);
  const legs = db.prepare('SELECT * FROM bet_legs WHERE bet_id = ? AND replaced_at IS NULL ORDER BY ordinal').all(id);
  return JSON.stringify({ bet, legs });
}

/* Fixing a typo keeps the previous version in bet_revisions. The model
 * values are re-derived for the (possibly changed) selections, still as of
 * the bet's placed_at — never as of the edit. */
export function updateBet(db, userId, id, input) {
  const existing = db.prepare('SELECT * FROM bets WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(Number(id), userId);
  if (!existing) throw new ValidationError('That bet does not exist.', 404);
  const bet = normaliseBet(db, input);
  transaction(db, () => {
    const at = nowIso();
    db.prepare('INSERT INTO bet_revisions (bet_id, changed_at, reason, old_json) VALUES (?, ?, ?, ?)')
      .run(existing.id, at, input.reason?.trim() || 'Edited', snapshotBet(db, existing.id));
    /* The old legs stay, marked replaced, so their settlement history keeps
     * pointing at real rows; the new legs are written alongside. */
    db.prepare('UPDATE bet_legs SET replaced_at = ? WHERE bet_id = ? AND replaced_at IS NULL').run(at, existing.id);
    db.prepare(`UPDATE bets SET placed_at = ?, sportsbook_key = ?, kind = ?, stake_minor = ?, fee_minor = ?, commission_minor = ?, contracts = ?, limit_price = ?, currency = ?,
                  total_odds = ?, total_odds_text = ?, potential_payout_minor = ?, notes = ?, updated_at = ? WHERE id = ?`)
      .run(bet.placedAt, bet.book.key, bet.kind, bet.stakeMinor, bet.feeMinor, bet.commissionMinor, bet.contracts, bet.limitPrice, bet.book.currency, bet.totalOdds, bet.totalOddsText,
        bet.potentialPayoutMinor, bet.notes, at, existing.id);
    writeLegs(db, existing.id, bet);
  });
  settleBets(db, { betIds: [existing.id], reconsider: true });
  return getBet(db, existing.id, userId);
}

export function deleteBet(db, userId, id, reason = 'Deleted') {
  const existing = db.prepare('SELECT * FROM bets WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(Number(id), userId);
  if (!existing) throw new ValidationError('That bet does not exist.', 404);
  transaction(db, () => {
    const at = nowIso();
    db.prepare('INSERT INTO bet_revisions (bet_id, changed_at, reason, old_json) VALUES (?, ?, ?, ?)')
      .run(existing.id, at, reason, snapshotBet(db, existing.id));
    db.prepare('UPDATE bets SET deleted_at = ?, updated_at = ? WHERE id = ?').run(at, at, existing.id);
  });
}

/** A manual result for the whole bet; it stands over automatic settlement. */
export function correctSettlement(db, userId, id, { outcome, profit, reason }) {
  const bet = db.prepare('SELECT * FROM bets WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(Number(id), userId);
  if (!bet) throw new ValidationError('That bet does not exist.', 404);
  if (!['won', 'lost', 'push', 'void', 'half_won', 'half_lost', 'pending'].includes(outcome)) {
    throw new ValidationError('Choose the result the betting app gave.');
  }
  if (!reason?.trim()) throw new ValidationError('Say why the result is being corrected.');
  let profitMinor;
  if (profit !== undefined && profit !== null && profit !== '') {
    const v = Number(String(profit).replace(',', '.'));
    if (!Number.isFinite(v)) throw new ValidationError('The profit or loss is not a number.');
    profitMinor = Math.round(v * 100);
  } else {
    profitMinor = outcome === 'pending' ? null : settleBet({ stakeMinor: bet.stake_minor, totalOdds: bet.total_odds,
      legs: [{ outcome, odds: bet.total_odds }] }).profitMinor - (bet.fee_minor ?? 0) - (bet.commission_minor ?? 0);
  }
  db.prepare(`INSERT INTO settlements (bet_id, bet_leg_id, outcome, source, reason, profit_minor, settled_at)
              VALUES (?, NULL, ?, 'manual', ?, ?, ?)`).run(bet.id, outcome, reason.trim(), profitMinor, nowIso());
  return getBet(db, bet.id, userId);
}

/* ------------------------------------------------------------ settling */

const currentRow = (db, betId, legId) => db.prepare(`
  SELECT * FROM settlements WHERE bet_id = ? AND bet_leg_id IS ? ORDER BY id DESC LIMIT 1`).get(betId, legId);

/**
 * Settle (or re-settle) bets from match results. Adds a row only when the
 * outcome changes; a bet whose latest row is a manual correction is left
 * alone. Returns the number of rows written.
 */
export function settleBets(db, { betIds = null, matchIds = null, reconsider = false, now = Date.now() } = {}) {
  let bets;
  if (betIds) {
    bets = db.prepare(`SELECT * FROM bets WHERE deleted_at IS NULL AND id IN (${betIds.map(() => '?').join(',')})`).all(...betIds);
  } else if (matchIds) {
    bets = db.prepare(`SELECT DISTINCT b.* FROM bets b JOIN bet_legs l ON l.bet_id = b.id
                       WHERE b.deleted_at IS NULL AND l.replaced_at IS NULL AND l.match_id IN (${matchIds.map(() => '?').join(',')})`).all(...matchIds);
  } else {
    bets = db.prepare('SELECT * FROM bets WHERE deleted_at IS NULL').all();
  }
  let written = 0;
  const at = new Date(now).toISOString();
  for (const bet of bets) {
    const head = currentRow(db, bet.id, null);
    if (head?.source === 'manual' && !reconsider) continue;
    const legs = db.prepare(`SELECT l.*, mk.market_type_key AS market, mk.line, s.key AS selection
                             FROM bet_legs l JOIN selections s ON s.id = l.selection_id JOIN markets mk ON mk.id = s.market_id
                             WHERE l.bet_id = ? AND l.replaced_at IS NULL ORDER BY l.ordinal`).all(bet.id);
    const graded = legs.map((l) => ({ ...l, odds: l.odds_taken,
      outcome: grade(l.market, l.line, l.selection, matchFacts(db, l.match_id), now) }));
    transaction(db, () => {
      for (const l of graded) {
        const o = l.outcome ?? 'pending';
        const cur = currentRow(db, bet.id, l.id);
        if (cur?.outcome !== o && !(cur === undefined && o === 'pending')) {
          db.prepare(`INSERT INTO settlements (bet_id, bet_leg_id, outcome, source, reason, settled_at)
                      VALUES (?, ?, ?, 'auto', ?, ?)`)
            .run(bet.id, l.id, o, l.outcome === null ? 'Not enough match data to settle automatically' : null, at);
          written += 1;
        }
      }
      if (head?.source === 'manual' && reconsider) return;
      const result = settleBet({ stakeMinor: bet.stake_minor, totalOdds: bet.total_odds, legs: graded });
      /* Fees are never returned, whatever the result. */
      if (result.profitMinor !== null) result.profitMinor -= (bet.fee_minor ?? 0) + (bet.commission_minor ?? 0);
      if (head?.outcome !== result.outcome || (head?.profit_minor ?? null) !== result.profitMinor) {
        if (!(head === undefined && result.outcome === 'pending')) {
          db.prepare(`INSERT INTO settlements (bet_id, bet_leg_id, outcome, source, reason, profit_minor, settled_at)
                      VALUES (?, NULL, ?, 'auto', NULL, ?, ?)`).run(bet.id, result.outcome, result.profitMinor, at);
          written += 1;
        }
      }
    });
  }
  return written;
}

/** Grade current predictions of finished matches; re-grade if a result changed. */
export function gradePredictions(db, { now = Date.now() } = {}) {
  const rows = db.prepare(`
    SELECT p.id, p.match_id, mk.market_type_key AS market, mk.line, s.key AS selection
    FROM predictions p JOIN selections s ON s.id = p.selection_id JOIN markets mk ON mk.id = s.market_id
    JOIN matches m ON m.id = p.match_id
    WHERE p.superseded_by IS NULL AND m.kickoff_utc < ?`).all(new Date(now).toISOString());
  const facts = new Map();
  const last = db.prepare('SELECT outcome FROM prediction_grades WHERE prediction_id = ? ORDER BY id DESC LIMIT 1');
  const insert = db.prepare("INSERT INTO prediction_grades (prediction_id, outcome, source, graded_at) VALUES (?, ?, 'auto', ?)");
  const at = new Date(now).toISOString();
  let written = 0;
  transaction(db, () => {
    for (const r of rows) {
      if (!facts.has(r.match_id)) facts.set(r.match_id, matchFacts(db, r.match_id));
      const o = grade(r.market, r.line, r.selection, facts.get(r.match_id), now);
      if (!o || o === 'pending') continue;
      if (last.get(r.id)?.outcome === o) continue;
      insert.run(r.id, o, at);
      written += 1;
    }
  });
  return written;
}

/* --------------------------------------------------------------- reads */

const BET_SELECT = `
  SELECT b.*, sb.name AS sportsbook_name,
         (SELECT outcome FROM settlements st WHERE st.bet_id = b.id AND st.bet_leg_id IS NULL ORDER BY st.id DESC LIMIT 1) AS outcome,
         (SELECT profit_minor FROM settlements st WHERE st.bet_id = b.id AND st.bet_leg_id IS NULL ORDER BY st.id DESC LIMIT 1) AS profit_minor,
         (SELECT source FROM settlements st WHERE st.bet_id = b.id AND st.bet_leg_id IS NULL ORDER BY st.id DESC LIMIT 1) AS settled_by
  FROM bets b JOIN sportsbooks sb ON sb.key = b.sportsbook_key`;

function shapeBet(db, b) {
  const legs = db.prepare(`
    SELECT l.*, mk.market_type_key AS market, mk.line, s.key AS selection, mt.name AS market_name,
           m.kickoff_utc, m.status_key, m.home_goals, m.away_goals, ht.name AS home, at.name AS away,
           ht.logo_url AS home_logo, at.logo_url AS away_logo, c.name AS competition, se.competition_id,
           (SELECT outcome FROM settlements st WHERE st.bet_leg_id = l.id ORDER BY st.id DESC LIMIT 1) AS outcome,
           p.confidence_band,
           (SELECT name FROM players pl WHERE s.key LIKE 'p:%' AND pl.id = CAST(substr(s.key, 3) AS INTEGER)) AS player_name
    FROM bet_legs l JOIN selections s ON s.id = l.selection_id JOIN markets mk ON mk.id = s.market_id
    JOIN market_types mt ON mt.key = mk.market_type_key
    JOIN matches m ON m.id = l.match_id JOIN seasons se ON se.id = m.season_id JOIN competitions c ON c.id = se.competition_id
    JOIN teams ht ON ht.id = m.home_team_id JOIN teams at ON at.id = m.away_team_id
    LEFT JOIN predictions p ON p.id = l.prediction_id
    WHERE l.bet_id = ? AND l.replaced_at IS NULL ORDER BY l.ordinal`).all(b.id);
  return {
    id: b.id, placedAt: b.placed_at, sportsbook: { key: b.sportsbook_key, name: b.sportsbook_name }, kind: b.kind,
    stakeMinor: b.stake_minor, feeMinor: b.fee_minor ?? 0, commissionMinor: b.commission_minor ?? 0,
    totalCostMinor: b.stake_minor + (b.fee_minor ?? 0) + (b.commission_minor ?? 0), contracts: b.contracts ?? null, limitPrice: b.limit_price ?? null, currency: b.currency, totalOdds: b.total_odds, totalOddsText: b.total_odds_text,
    potentialPayoutMinor: b.potential_payout_minor, notes: b.notes, createdAt: b.created_at, updatedAt: b.updated_at,
    outcome: b.outcome ?? 'pending', profitMinor: b.profit_minor ?? null, settledBy: b.settled_by ?? null,
    legs: legs.map((l) => ({
      id: l.id, matchId: l.match_id, market: l.market, line: l.line, selection: l.selection, marketName: l.market_name,
      label: selectionLabel(l.market, l.line, l.selection, l.home, l.away, l.player_name), playerName: l.player_name,
      home: l.home, away: l.away, homeLogo: l.home_logo, awayLogo: l.away_logo, competition: l.competition,
      competitionId: l.competition_id,
      kickoffUtc: l.kickoff_utc, status: l.status_key,
      score: l.home_goals === null ? null : `${l.home_goals}–${l.away_goals}`,
      odds: l.odds_taken, oddsText: l.odds_text, oddsFormat: l.odds_format,
      modelProbability: l.model_probability_at_bet, fairOdds: l.fair_odds_at_bet, edge: l.edge_at_bet, ev: l.ev_at_bet,
      followedRecommendation: l.followed_recommendation === null ? null : !!l.followed_recommendation,
      confidence: l.confidence_band, closingOdds: l.closing_odds,
      clv: l.closing_odds ? round(l.odds_taken / l.closing_odds - 1) : null,
      outcome: l.outcome ?? 'pending',
    })),
  };
}

/** The price at kickoff, typed in by hand (there is no odds feed), for
 *  closing-line value: did the price taken beat where the market closed? */
export function setClosingOdds(db, userId, betId, legId, value) {
  const leg = db.prepare(`SELECT l.id FROM bet_legs l JOIN bets b ON b.id = l.bet_id
                          WHERE l.id = ? AND b.id = ? AND b.user_id = ? AND b.deleted_at IS NULL AND l.replaced_at IS NULL`)
    .get(Number(legId), Number(betId), userId);
  if (!leg) throw new ValidationError('That selection does not exist.', 404);
  let decimal = null;
  if (value !== null && value !== undefined && String(value).trim() !== '') {
    decimal = parseOdds(value)?.decimal ?? null;
    if (!decimal) throw new ValidationError(oddsHint(value).message);
  }
  db.prepare('UPDATE bet_legs SET closing_odds = ? WHERE id = ?').run(decimal, leg.id);
  return getBet(db, betId, userId);
}

export function getBet(db, id, userId) {
  const b = db.prepare(`${BET_SELECT} WHERE b.id = ? AND b.user_id = ?`).get(Number(id), userId);
  if (!b) return null;
  const bet = shapeBet(db, b);
  bet.deleted = !!b.deleted_at;
  bet.settlements = db.prepare(`SELECT outcome, source, reason, profit_minor AS profitMinor, settled_at AS settledAt
                                FROM settlements WHERE bet_id = ? AND bet_leg_id IS NULL ORDER BY id`).all(b.id);
  bet.revisions = db.prepare('SELECT changed_at AS changedAt, reason FROM bet_revisions WHERE bet_id = ? ORDER BY id').all(b.id);
  return bet;
}

export function listBets(db, userId, { status } = {}) {
  const rows = db.prepare(`SELECT * FROM (${BET_SELECT} WHERE b.user_id = ? AND b.deleted_at IS NULL)
                           ${status === 'open' ? "WHERE outcome IS NULL OR outcome = 'pending'"
    : status === 'settled' ? "WHERE outcome IS NOT NULL AND outcome <> 'pending'" : ''}
                           ORDER BY placed_at DESC`).all(userId);
  return rows.map((b) => shapeBet(db, b));
}

/* ------------------------------------------------------------- history */

const ODDS_BANDS = [[1, 1.5, '1.01–1.49'], [1.5, 2, '1.50–1.99'], [2, 3, '2.00–2.99'], [3, 5, '3.00–4.99'], [5, Infinity, '5.00+']];
const oddsBand = (o) => ODDS_BANDS.find(([lo, hi]) => o >= lo && o < hi)?.[2] ?? '—';

function tally(bets) {
  const settled = bets.filter((b) => b.outcome !== 'pending');
  const sum = (f) => settled.reduce((a, b) => a + f(b), 0);
  const won = settled.filter((b) => b.outcome === 'won' || b.outcome === 'half_won').length;
  const lost = settled.filter((b) => b.outcome === 'lost' || b.outcome === 'half_lost').length;
  const pushed = settled.filter((b) => b.outcome === 'push' || b.outcome === 'void').length;
  const staked = sum((b) => b.stakeMinor);
  const fees = sum((b) => b.feeMinor + b.commissionMinor);
  const profit = sum((b) => b.profitMinor ?? 0);
  const edges = bets.flatMap((b) => b.legs.map((l) => l.edge)).filter((e) => e !== null);
  const clv = bets.flatMap((b) => b.legs.map((l) => l.clv)).filter((c) => c !== null);
  return {
    bets: bets.length, settled: settled.length, open: bets.length - settled.length, won, lost, pushed,
    winRate: won + lost ? won / (won + lost) : null,
    stakedMinor: staked, feesMinor: fees, returnedMinor: staked + fees + profit, profitMinor: profit,
    roi: staked + fees ? profit / (staked + fees) : null,
    averageOdds: bets.length ? bets.reduce((a, b) => a + b.totalOdds, 0) / bets.length : null,
    averageEdge: edges.length ? edges.reduce((a, e) => a + e, 0) / edges.length : null,
    closing: { legs: clv.length, beat: clv.filter((c) => c > 0).length,
      averageClv: clv.length ? clv.reduce((a, c) => a + c, 0) / clv.length : null },
  };
}

function breakdown(bets, keyOf) {
  const groups = new Map();
  for (const b of bets) {
    for (const k of [keyOf(b)].flat()) {
      if (k === null || k === undefined) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(b);
    }
  }
  return [...groups].map(([key, list]) => ({ key, ...tally(list) })).sort((a, b) => b.bets - a.bets);
}

/**
 * Betting History: totals, breakdowns and P/L over time, in one currency
 * (amounts in different currencies are never added together).
 */
export function bettingHistory(db, userId, filters = {}) {
  let bets = listBets(db, userId);
  const currencies = [...new Set(bets.map((b) => b.currency))];
  const currency = filters.currency ?? currencies[0] ?? 'USD';
  bets = bets.filter((b) => b.currency === currency);
  if (filters.from) bets = bets.filter((b) => b.placedAt >= filters.from);
  if (filters.to) bets = bets.filter((b) => b.placedAt < filters.to);
  if (filters.sportsbook) bets = bets.filter((b) => b.sportsbook.key === filters.sportsbook);
  if (filters.kind) bets = bets.filter((b) => b.kind === filters.kind);
  if (filters.competition) bets = bets.filter((b) => b.legs.some((l) => String(l.competition) === filters.competition
    || String(l.competitionId) === filters.competition));
  if (filters.market) bets = bets.filter((b) => b.legs.some((l) => l.market === filters.market));
  if (filters.team) bets = bets.filter((b) => b.legs.some((l) => l.home === filters.team || l.away === filters.team));
  if (filters.followed === 'yes') bets = bets.filter((b) => b.legs.every((l) => l.followedRecommendation === true));
  if (filters.followed === 'no') bets = bets.filter((b) => b.legs.some((l) => l.followedRecommendation !== true));

  const singles = bets.filter((b) => b.kind === 'single');
  /* Running profit, settled bets in the order they were placed. */
  let running = 0;
  const overTime = bets.filter((b) => b.outcome !== 'pending').sort((a, b) => a.placedAt.localeCompare(b.placedAt))
    .map((b) => { running += b.profitMinor ?? 0; return { at: b.placedAt, profitMinor: running }; });

  return {
    currency, currencies,
    totals: tally(bets),
    /* Decision quality, kept apart from luck: bets judged by the edge they
     * had when placed, not by whether they won. */
    byEdge: breakdown(bets.filter((b) => b.kind === 'single'), (b) => (b.legs[0].edge === null ? 'No model view'
      : b.legs[0].edge > 0 ? 'Positive edge when placed' : 'Negative edge when placed')),
    byFollowed: breakdown(bets, (b) => (b.legs.every((l) => l.followedRecommendation === true) ? 'Followed a recommendation'
      : 'Did not follow a recommendation')),
    byCompetition: breakdown(singles, (b) => b.legs[0].competition),
    byTeam: breakdown(singles, (b) => [b.legs[0].home, b.legs[0].away]),
    byMarket: breakdown(bets, (b) => (b.kind === 'parlay' ? 'Parlay' : b.legs[0].marketName)),
    bySportsbook: breakdown(bets, (b) => b.sportsbook.name),
    byConfidence: breakdown(singles, (b) => (b.legs[0].confidence ? `${b.legs[0].confidence[0].toUpperCase()}${b.legs[0].confidence.slice(1)} confidence` : 'No model view')),
    byOdds: breakdown(bets, (b) => oddsBand(b.totalOdds)),
    byMonth: breakdown(bets, (b) => b.placedAt.slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)),
    overTime,
  };
}

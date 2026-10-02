import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { grade, matchFacts } from '../server/grading.mjs';
import { requestAnalysis, runAnalysis, analysisForMatch } from '../server/analysis.mjs';
import { saveSportsbook, createBet, settleBets, setClosingOdds, bettingHistory, getBet } from '../server/bets.mjs';
import { bankroll, saveBankrollSettings, addLedgerEntry, suggestedStake } from '../server/bankroll.mjs';
import { quotaHold, quotaLeft, runJob } from '../server/jobs.mjs';
import { runBacktest } from '../server/backtest.mjs';
import { ask, resolveFilter } from '../server/ask.mjs';
import { selectionLabel } from '../src/markets.js';
import { formatMoney } from '../src/odds.js';
import { seedLeague } from './fixtures/league.mjs';

const DAY = 86400_000;
let db;
let league;
const now = () => new Date().toISOString();

beforeEach(() => {
  db = openDatabase(':memory:');
  league = seedLeague(db);
});

/* A striker and a midfielder for Team A, on the squad, with a season of
 * minutes and goals; a striker for the opponent who is reported missing. */
function seedPlayers() {
  const add = (name, position, ref) => Number(db.prepare(`INSERT INTO players (name, position, source_key, source_ref, fetched_at)
    VALUES (?, ?, 'api-football', ?, ?)`).run(name, position, ref, now()).lastInsertRowid);
  const striker = add('Nine Striker', 'Attacker', 'p9');
  const mid = add('Eight Mid', 'Midfielder', 'p8');
  const away = add('Away Striker', 'Attacker', 'p10');
  const roster = db.prepare(`INSERT INTO team_rosters (team_id, player_id, position, valid_from) VALUES (?, ?, ?, ?)`);
  const since = new Date(Date.now() - 400 * DAY).toISOString();
  roster.run(league.teamIds[0], striker, 'Attacker', since);
  roster.run(league.teamIds[0], mid, 'Midfielder', since);
  roster.run(league.teamIds[9], away, 'Attacker', since);
  const stat = db.prepare(`INSERT INTO player_match_stats (match_id, player_id, team_id, minutes, is_substitute, goals, source_key, fetched_at)
                           VALUES (?, ?, ?, ?, 0, ?, 'api-football', ?)`);
  const matches = db.prepare('SELECT id, home_team_id, away_team_id FROM matches WHERE status_key = ?').all('finished');
  let i = 0;
  for (const m of matches) {
    if (m.home_team_id === league.teamIds[0] || m.away_team_id === league.teamIds[0]) {
      stat.run(m.id, striker, league.teamIds[0], 90, i % 2 === 0 ? 1 : 0, now());
      stat.run(m.id, mid, league.teamIds[0], 80, i % 6 === 0 ? 1 : 0, now());
      i += 1;
    }
    if (m.home_team_id === league.teamIds[9] || m.away_team_id === league.teamIds[9]) {
      stat.run(m.id, away, league.teamIds[9], 90, 1, now());
    }
  }
  const reported = new Date(Date.now() - DAY).toISOString();
  db.prepare(`INSERT INTO availability (player_id, team_id, match_id, status, reason, first_reported_at, last_reported_at, source_key)
              VALUES (?, ?, ?, 'missing', 'Hamstring', ?, ?, 'api-football')`).run(away, league.teamIds[9], league.upcomingId, reported, reported);
  return { striker, mid, away };
}

describe('Anytime goalscorer', () => {
  test('priced from each player\'s scoring share, missing players left out', async () => {
    const p = seedPlayers();
    const run = requestAnalysis(db, league.upcomingId, 'u1');
    await runAnalysis(db, run.id);
    const a = analysisForMatch(db, league.upcomingId).latest;
    const scorers = a.predictions.filter((x) => x.market === 'anytime_scorer');
    const striker = scorers.find((x) => x.selection === `p:${p.striker}`);
    const mid = scorers.find((x) => x.selection === `p:${p.mid}`);
    assert.ok(striker && mid, 'both Team A players priced');
    assert.ok(striker.probability > mid.probability, 'a goal every other game beats one in six');
    assert.ok(striker.probability > 0.25 && striker.probability < 0.8, `${striker.probability}`);
    assert.equal(striker.label, 'Nine Striker to score');
    assert.ok(!scorers.some((x) => x.selection === `p:${p.away}`), 'reported missing');
  });

  test('graded on regular-time goals; own goals and extra time do not count; no appearance is void', () => {
    const p = seedPlayers();
    const m = league.matchIds.find((id) => db.prepare('SELECT 1 FROM player_match_stats WHERE match_id = ? AND player_id = ?').get(id, p.striker));
    const ev = db.prepare(`INSERT INTO match_events (match_id, seq, minute, team_id, player_id, type_key, source_key, fetched_at)
                           VALUES (?, ?, ?, ?, ?, ?, 'api-football', ?)`);
    ev.run(m, 1, 34, league.teamIds[0], p.striker, 'goal', now());
    ev.run(m, 2, 50, league.teamIds[0], p.mid, 'own_goal', now());
    const facts = matchFacts(db, m);
    assert.equal(grade('anytime_scorer', null, `p:${p.striker}`, facts), 'won');
    assert.equal(grade('anytime_scorer', null, `p:${p.mid}`, facts), 'lost', 'an own goal is not a goal for him');
    assert.equal(grade('anytime_scorer', null, `p:${p.away}`, facts), 'void', 'did not play in this match');
    ev.run(m, 3, 105, league.teamIds[0], p.mid, 'goal', now());
    assert.equal(grade('anytime_scorer', null, `p:${p.mid}`, matchFacts(db, m)), 'lost', 'extra time');
    assert.equal(selectionLabel('anytime_scorer', null, 'p:1', 'A', 'B'), 'Player to score');
  });

  test('can be recorded as a bet and settles', () => {
    const p = seedPlayers();
    saveSportsbook(db, { name: 'Book', currency: 'USD' });
    const m = league.matchIds.find((id) => db.prepare('SELECT 1 FROM player_match_stats WHERE match_id = ? AND player_id = ?').get(id, p.striker));
    db.prepare(`INSERT INTO match_events (match_id, seq, minute, team_id, player_id, type_key, source_key, fetched_at)
                VALUES (?, 1, 10, ?, ?, 'penalty_goal', 'api-football', ?)`).run(m, league.teamIds[0], p.striker, now());
    const kickoff = db.prepare('SELECT kickoff_utc FROM matches WHERE id = ?').get(m).kickoff_utc;
    const bet = createBet(db, 'u1', { sportsbook: 'book', stake: '10', placedAt: new Date(Date.parse(kickoff) - 3600_000).toISOString(),
      legs: [{ matchId: m, market: 'anytime_scorer', selection: `p:${p.striker}`, odds: '2.20' }] });
    assert.equal(bet.legs[0].label, 'Nine Striker to score');
    assert.equal(getBet(db, bet.id, 'u1').outcome, 'won');
    assert.throws(() => createBet(db, 'u1', { sportsbook: 'book', stake: '10',
      legs: [{ matchId: m, market: 'anytime_scorer', selection: 'p:999999', odds: '2' }] }), /choose the player/);
  });
});

describe('Bankroll', () => {
  test('balance, exposure and the suggested stake', () => {
    saveSportsbook(db, { name: 'Book', currency: 'USD' });
    const start = new Date(Date.now() - 100 * DAY).toISOString();
    saveBankrollSettings(db, 'u1', { currency: 'USD', starting: '1000', method: 'percent', amount: '2', maxExposurePct: 10, startedAt: start });
    addLedgerEntry(db, 'u1', { currency: 'USD', kind: 'deposit', amount: '200' });
    addLedgerEntry(db, 'u1', { currency: 'USD', kind: 'withdrawal', amount: '50' });
    const past = league.matchIds[80];
    const kick = db.prepare('SELECT kickoff_utc, home_goals, away_goals FROM matches WHERE id = ?').get(past);
    const sel = kick.home_goals > kick.away_goals ? 'home' : kick.home_goals < kick.away_goals ? 'away' : 'draw';
    createBet(db, 'u1', { sportsbook: 'book', stake: '100', placedAt: new Date(Date.parse(kick.kickoff_utc) - 3600_000).toISOString(),
      legs: [{ matchId: past, market: 'match_result', selection: sel, odds: '2.00' }] });
    createBet(db, 'u1', { sportsbook: 'book', stake: '40', legs: [{ matchId: league.upcomingId, market: 'btts', selection: 'yes', odds: '1.9' }] });
    const b = bankroll(db, 'u1').bankrolls[0];
    assert.equal(b.balanceMinor, 100000 + 20000 - 5000 + 10000);
    assert.equal(b.exposureMinor, 4000);
    assert.equal(b.openBets, 1);
    /* 2% of 1,250 = 25.00, under the 10% exposure cap (125 − 40 open = 85). */
    assert.equal(b.suggestedStakeMinor, 2500);
    assert.equal(b.cappedByExposure, false);
    assert.equal(b.overTime.at(-1).balanceMinor, b.balanceMinor);
    assert.throws(() => db.prepare('DELETE FROM bankroll_ledger').run(), /cannot be deleted/);
  });

  test('flat and unit plans, and the exposure cap', () => {
    assert.equal(suggestedStake({ method: 'flat', amount: 1500 }, 100000), 1500);
    assert.equal(suggestedStake({ method: 'unit', amount: 1000 }, 100000), 1000);
    assert.equal(suggestedStake({ method: 'percent', amount: 1 }, 0), 0);
    saveSportsbook(db, { name: 'Book', currency: 'EUR' });
    saveBankrollSettings(db, 'u1', { currency: 'EUR', starting: '100', method: 'flat', amount: '20', maxExposurePct: 25 });
    createBet(db, 'u1', { sportsbook: 'book', stake: '15', legs: [{ matchId: league.upcomingId, market: 'btts', selection: 'no', odds: '2' }] });
    const b = bankroll(db, 'u1').bankrolls.find((x) => x.currency === 'EUR');
    assert.equal(b.suggestedStakeMinor, 1000, '25 allowed open, 15 already out');
    assert.equal(b.cappedByExposure, true);
    assert.throws(() => saveBankrollSettings(db, 'u1', { currency: 'EUR', starting: '100', method: 'percent', amount: '50' }), /between 0.1% and 10%/);
  });
});

describe('Closing prices', () => {
  test('closing odds give closing-line value in the history', () => {
    saveSportsbook(db, { name: 'Book', currency: 'USD' });
    const bet = createBet(db, 'u1', { sportsbook: 'book', stake: '10', legs: [{ matchId: league.upcomingId, market: 'btts', selection: 'yes', odds: '2.10' }] });
    const after = setClosingOdds(db, 'u1', bet.id, bet.legs[0].id, '1.95');
    assert.equal(after.legs[0].closingOdds, 1.95);
    assert.ok(after.legs[0].clv > 0.07);
    const h = bettingHistory(db, 'u1');
    assert.deepEqual({ legs: h.totals.closing.legs, beat: h.totals.closing.beat }, { legs: 1, beat: 1 });
    assert.throws(() => setClosingOdds(db, 'u1', bet.id, bet.legs[0].id, 'abc'), /Not valid odds/);
    assert.equal(setClosingOdds(db, 'u1', bet.id, bet.legs[0].id, '').legs[0].closingOdds, null);
  });
});

describe('Requests and the daily quota', () => {
  const setQuota = (remaining) => db.prepare(`INSERT INTO provider_quota (source_key, day, requests_used, daily_limit, remaining)
    VALUES ('api-football', ?, 0, 7500, ?) ON CONFLICT(source_key, day) DO UPDATE SET remaining = excluded.remaining`)
    .run(new Date().toISOString().slice(0, 10), remaining);

  test('non-essential jobs wait when requests run low; essential ones never do', () => {
    assert.equal(quotaLeft(db), null);
    assert.equal(quotaHold(db, 'deferrable'), null, 'unknown: carry on');
    setQuota(1200);
    assert.match(quotaHold(db, 'deferrable'), /1200 requests left/);
    assert.equal(quotaHold(db, 'normal'), null);
    assert.equal(quotaHold(db, 'essential'), null);
    setQuota(300);
    assert.ok(quotaHold(db, 'normal'));
    assert.equal(quotaHold(db, 'essential'), null);
  });

  test('a held job is logged as skipped and moved to tomorrow; Run now overrides', async () => {
    setQuota(100);
    const calls = [];
    const provider = { requestsUsed: 0, squad: async () => { calls.push('squad'); return { items: [], fetchedAt: now() }; } };
    const run = await runJob(db, 'sync_squads', { providerFactory: () => provider });
    assert.equal(run.status, 'skipped');
    assert.match(run.message, /tomorrow/);
    const next = db.prepare("SELECT next_run_at FROM jobs WHERE key = 'sync_squads'").get().next_run_at;
    assert.ok(next > new Date().toISOString().slice(0, 10));
    db.prepare("UPDATE jobs SET run_requested_at = ? WHERE key = 'sync_squads'").run(now());
    assert.notEqual((await runJob(db, 'sync_squads', { providerFactory: () => provider })).status, 'skipped');
  });
});

describe('Questions over SokkerLiga\'s own history', () => {
  const parserFor = (filter) => ({ calls: [], async parse(q, ctx) { this.calls.push({ q, ctx }); return filter; } });
  const base = { understood: true, clarification: '', restatement: 'Premier League over 2.5 goals predictions', subject: 'predictions',
    source: 'all', competitions: ['premier-league'], markets: ['over_under'], line: 2.5, selection: 'over', confidence: [],
    team: null, favourite: 'none', from: null, to: null, group_by: 'none' };

  test('Claude\'s filter is run against SokkerLiga\'s own numbers', async () => {
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('backtest_from', ?, ?)")
      .run(db.prepare('SELECT kickoff_utc FROM matches WHERE id = ?').get(league.matchIds[40]).kickoff_utc, now());
    await runBacktest(db, { seconds: 60 });
    const parser = parserFor(base);
    const r = await ask(db, 'u1', 'How accurate have our Premier League Over 2.5 predictions been?', parser);
    assert.ok(parser.calls[0].ctx.competitions.some((c) => c.key === 'premier-league'), 'Claude is given the keys');
    assert.equal(r.understood, true);
    assert.ok(r.total.n > 0);
    assert.match(r.answer, /graded selection/);
    assert.ok(r.filter.chips.includes('Premier League'));
    const grouped = await ask(db, 'u1', 'Which markets are best calibrated?', parserFor({ ...base, competitions: [], markets: [],
      line: null, selection: null, group_by: 'market', restatement: 'All predictions by market' }));
    assert.ok(grouped.breakdown.length > 3);
    assert.match(grouped.answer, /Best calibrated/);
  });

  test('unknown keys are dropped and said so; unanswerable questions get a clarification', async () => {
    const f = resolveFilter(db, { ...base, competitions: ['nowhere-league'], team: 'Team A' });
    assert.equal(f.competitions.length, 0);
    assert.match(f.notes[0], /nowhere-league/);
    assert.equal(f.team.name, 'Team A');
    const r = await ask(db, 'u1', 'Who will win the league?', parserFor({ ...base, understood: false, clarification: 'SokkerLiga can only measure past predictions.' }));
    assert.deepEqual([r.understood, r.clarification], [false, 'SokkerLiga can only measure past predictions.']);
    await assert.rejects(() => ask(db, 'u1', 'How accurate?', null), /no Anthropic API key/);
  });

  test('questions about bets use the betting history', async () => {
    saveSportsbook(db, { name: 'Book', currency: 'USD' });
    createBet(db, 'u1', { sportsbook: 'book', stake: '10', legs: [{ matchId: league.upcomingId, market: 'btts', selection: 'yes', odds: '2.10' }] });
    const r = await ask(db, 'u1', 'Did we beat the closing price?', parserFor({ ...base, subject: 'bets', competitions: [], markets: [],
      line: null, selection: null, restatement: 'Your bets against the closing price' }));
    assert.equal(r.kind, 'bets');
    assert.match(r.answer, /No closing prices have been recorded yet/);
  });
});

describe('Fees', () => {
  test('fees come off the profit whatever the result, and count in ROI', () => {
    saveSportsbook(db, { name: 'Robinhood', currency: 'USD' });
    const past = league.matchIds[60];
    const m = db.prepare('SELECT kickoff_utc, home_goals, away_goals FROM matches WHERE id = ?').get(past);
    const won = m.home_goals > m.away_goals ? 'home' : m.home_goals < m.away_goals ? 'away' : 'draw';
    const lost = won === 'home' ? 'away' : 'home';
    const placedAt = new Date(Date.parse(m.kickoff_utc) - 3600_000).toISOString();
    const a = createBet(db, 'u1', { sportsbook: 'robinhood', stake: '9.52', fee: '0.28', placedAt,
      legs: [{ matchId: past, market: 'match_result', selection: won, odds: '68%' }] });
    assert.equal(a.feeMinor, 28);
    assert.equal(a.profitMinor, Math.round(952 / 0.68) - 952 - 28, 'about $4.20');
    const b = createBet(db, 'u1', { sportsbook: 'robinhood', stake: '5', fee: '0.10', placedAt,
      legs: [{ matchId: past, market: 'match_result', selection: lost, odds: '2' }] });
    assert.equal(b.profitMinor, -510);
    const t = bettingHistory(db, 'u1').totals;
    assert.equal(t.feesMinor, 38);
    assert.ok(Math.abs(t.roi - (a.profitMinor - 510) / (952 + 500 + 38)) < 1e-9);
    assert.throws(() => createBet(db, 'u1', { sportsbook: 'robinhood', stake: '5', fee: 'abc',
      legs: [{ matchId: past, market: 'btts', selection: 'yes', odds: '2' }] }), /Fees must be an amount/);
  });
});

describe('Contracts', () => {
  test('each contract pays exactly 1.00: 14 at 68¢ returns 14.00', () => {
    saveSportsbook(db, { name: 'Robinhood', currency: 'USD' });
    const past = league.matchIds[61];
    const m = db.prepare('SELECT kickoff_utc, home_goals, away_goals FROM matches WHERE id = ?').get(past);
    const won = m.home_goals > m.away_goals ? 'home' : m.home_goals < m.away_goals ? 'away' : 'draw';
    const bet = createBet(db, 'u1', { sportsbook: 'robinhood', stake: '9.52', fee: '0.28', contracts: '14',
      placedAt: new Date(Date.parse(m.kickoff_utc) - 3600_000).toISOString(),
      legs: [{ matchId: past, market: 'match_result', selection: won, odds: '68%' }] });
    assert.equal(bet.contracts, 14);
    assert.equal(bet.potentialPayoutMinor, 1400);
    assert.equal(bet.profitMinor, 1400 - 952 - 28, '$4.20 after fees');
    assert.throws(() => createBet(db, 'u1', { sportsbook: 'robinhood', stake: '20', contracts: '14',
      legs: [{ matchId: past, market: 'btts', selection: 'yes', odds: '68%' }] }), /pay back no more than the bet/);
  });
});

describe('Contracts with a limit price', () => {
  test('the limit is kept; the odds come from what was paid per contract', () => {
    saveSportsbook(db, { name: 'Robinhood', currency: 'USD' });
    const bet = createBet(db, 'u1', { sportsbook: 'robinhood', stake: '9.24', fee: '0.28', contracts: '14', limitPrice: '68',
      legs: [{ matchId: league.upcomingId, market: 'btts', selection: 'yes', odds: '' }] });
    assert.equal(bet.limitPrice, 0.68);
    assert.equal(bet.legs[0].oddsText, '66¢', 'filled below the limit: 9.24 ÷ 14');
    assert.equal(bet.potentialPayoutMinor, 1400);
    assert.throws(() => createBet(db, 'u1', { sportsbook: 'robinhood', stake: '9', limitPrice: '68',
      legs: [{ matchId: league.upcomingId, market: 'btts', selection: 'no', odds: '' }] }), /needs the number of contracts/);
  });
});

describe('Commissions', () => {
  test('commissions and fees both come off profit; total cost adds them up', () => {
    saveSportsbook(db, { name: 'Robinhood', currency: 'USD' });
    const past = league.matchIds[62];
    const m = db.prepare('SELECT kickoff_utc, home_goals, away_goals FROM matches WHERE id = ?').get(past);
    const won = m.home_goals > m.away_goals ? 'home' : m.home_goals < m.away_goals ? 'away' : 'draw';
    const bet = createBet(db, 'u1', { sportsbook: 'robinhood', stake: '9.52', commission: '0.14', fee: '0.14', contracts: '14', limitPrice: '68',
      placedAt: new Date(Date.parse(m.kickoff_utc) - 3600_000).toISOString(),
      legs: [{ matchId: past, market: 'match_result', selection: won, odds: '' }] });
    assert.equal(bet.totalCostMinor, 980);
    const again = createBet(db, 'u1', { sportsbook: 'robinhood', stake: '9.52', fee: '0.28', orderAmount: '10.00', contracts: '14', limitPrice: '68',
      legs: [{ matchId: league.upcomingId, market: 'btts', selection: 'yes', odds: '' }] });
    assert.equal(again.orderAmountMinor, 1000);
    assert.match(formatMoney(1000, 'USD'), /^\$10\.00 USD$/);
    assert.equal(bet.profitMinor, 1400 - 980);
  });
});

describe('Hand corrections and the calculated result', () => {
  test('editing a bet, or asking for it, replaces a hand correction with the calculation', async () => {
    const { updateBet, useCalculatedResult, correctSettlement } = await import('../server/bets.mjs');
    saveSportsbook(db, { name: 'Robinhood', currency: 'USD' });
    const past = league.matchIds[63];
    const m = db.prepare('SELECT kickoff_utc, home_goals, away_goals FROM matches WHERE id = ?').get(past);
    const won = m.home_goals > m.away_goals ? 'home' : m.home_goals < m.away_goals ? 'away' : 'draw';
    const body = { sportsbook: 'robinhood', stake: '9.52', fee: '0.28', contracts: '14', limitPrice: '0.68',
      placedAt: new Date(Date.parse(m.kickoff_utc) - 3600_000).toISOString(),
      legs: [{ matchId: past, market: 'match_result', selection: won, odds: '' }] };
    const bet = createBet(db, 'u1', body);
    correctSettlement(db, 'u1', bet.id, { outcome: 'won', profit: '4.48', reason: 'As the app said' });
    assert.equal(getBet(db, bet.id, 'u1').profitMinor, 448);
    const back = useCalculatedResult(db, 'u1', bet.id);
    assert.deepEqual([back.profitMinor, back.settledBy], [420, 'auto']);
    correctSettlement(db, 'u1', bet.id, { outcome: 'won', profit: '5', reason: 'x' });
    const edited = updateBet(db, 'u1', bet.id, body);
    assert.deepEqual([edited.profitMinor, edited.settledBy], [420, 'auto']);
  });
});

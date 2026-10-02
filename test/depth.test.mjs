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

describe('League catalogue', () => {
  test('any league the provider covers can be switched on', async () => {
    const { leagueCatalog, enableFromCatalog } = await import('../server/queries.mjs');
    const items = [
      { league: { id: 5, name: 'UEFA Nations League', type: 'Cup', logo: 'l5' }, country: { name: 'World', code: null, flag: null }, seasons: [{ year: 2026, current: true }] },
      { league: { id: 71, name: 'Serie A', type: 'League', logo: 'l71' }, country: { name: 'Brazil', code: 'BR', flag: 'br' }, seasons: [{ year: 2026, current: true }] },
      { league: { id: 999, name: 'Copa Teste', type: 'Cup', logo: 'l999' }, country: { name: 'Brazil', code: 'BR', flag: 'br' }, seasons: [{ year: 2026, current: true }] },
    ];
    const provider = { requestsUsed: 1, leagueCatalog: async () => ({ items, fetchedAt: now() }) };
    const run = await runJob(db, 'sync_league_catalog', { providerFactory: () => provider });
    assert.equal(run.status, 'ok');
    const cat = leagueCatalog(db);
    assert.equal(cat.length, 3);
    assert.equal(cat.find((l) => l.apiId === 5).isEnabled, true, 'Nations League is a seeded competition, already on');
    assert.equal(cat.find((l) => l.apiId === 999).isEnabled, false);
    const id = enableFromCatalog(db, 999);
    const c = db.prepare('SELECT * FROM competitions WHERE id = ?').get(id);
    assert.deepEqual([c.name, c.kind, c.is_enabled, c.api_football_id], ['Copa Teste', 'cup', 1, 999]);
    assert.equal(enableFromCatalog(db, 999), id, 'switching on twice reuses the row');
  });
});

describe('Brackets', () => {
  test('knockout ties: aggregates, penalties, and pairs that feed the same tie side by side', async () => {
    const { bracket, bracketCompetitions } = await import('../server/brackets.mjs');
    const comp = db.prepare("SELECT id FROM competitions WHERE key = 'champions-league'").get().id;
    const season = Number(db.prepare(`INSERT INTO seasons (competition_id, year, label, start_date, end_date, is_current)
                                      VALUES (?, 2025, '2025/26', '2025-07-01', '2026-06-01', 1)`).run(comp).lastInsertRowid);
    const T = league.teamIds;
    let n = 0;
    const add = (round, day, h, a, hg, ag, pens = [null, null]) => db.prepare(`INSERT INTO matches (season_id, round, kickoff_utc,
        home_team_id, away_team_id, status_key, home_goals, away_goals, home_pens, away_pens, source_key, source_ref, fetched_at)
        VALUES (?, ?, ?, ?, ?, 'finished', ?, ?, ?, ?, 'api-football', ?, ?)`)
      .run(season, round, `2026-0${day}T20:00:00.000Z`, T[h], T[a], hg, ag, pens[0], pens[1], `ko${n += 1}`, now());
    add('League Stage - 1', '1-10', 0, 1, 1, 0);
    /* Quarter-finals, two legs: 0 beat 7, 3 beat 4, 2 beat 5 (pens), 1 beat 6. */
    add('Quarter-finals', '3-01', 7, 0, 1, 1); add('Quarter-finals', '3-08', 0, 7, 2, 0);
    add('Quarter-finals', '3-01', 3, 4, 2, 0); add('Quarter-finals', '3-08', 4, 3, 1, 1);
    add('Quarter-finals', '3-02', 2, 5, 1, 0); add('Quarter-finals', '3-09', 5, 2, 1, 0, [3, 4]);
    add('Quarter-finals', '3-02', 6, 1, 0, 0); add('Quarter-finals', '3-09', 1, 6, 1, 0);
    /* Semis: 0 v 2 and 3 v 1 (drawn in the other order to the quarters). */
    add('Semi-finals', '4-01', 0, 2, 1, 0); add('Semi-finals', '4-08', 2, 0, 0, 0);
    add('Semi-finals', '4-02', 3, 1, 0, 2); add('Semi-finals', '4-09', 1, 3, 0, 0);
    add('3rd Place Final', '5-20', 2, 3, 1, 0);
    add('Final', '5-30', 0, 1, 1, 1, [5, 4]);

    assert.ok(bracketCompetitions(db).some((c) => c.id === comp));
    const b = bracket(db, comp);
    assert.deepEqual(b.rounds.map((r) => r.name), ['Quarter-finals', 'Semi-finals', 'Final']);
    assert.equal(b.thirdPlace.ties.length, 1);
    const final = b.rounds[2].ties[0];
    assert.equal(final.teams.find((t) => t.winner).id, T[0], 'won on penalties');
    const qf = b.rounds[0].ties;
    const winnersInOrder = qf.map((t) => t.teams.find((x) => x.winner).id);
    /* Semi 1 is 0 v 2, semi 2 is 3 v 1: the quarters line up the same way. */
    assert.deepEqual(winnersInOrder, [T[0], T[2], T[3], T[1]]);
    const t25 = qf.find((t) => t.teams.some((x) => x.id === T[5]));
    assert.deepEqual(t25.teams.map((x) => x.goals), [1, 1]);
    assert.equal(t25.kind, 'two-legs');

    /* Another cup with only its quarter-finals known: the semis and final
     * are shown as waiting for winners. */
    const cup = db.prepare("SELECT id FROM competitions WHERE key = 'europa-league'").get().id;
    const s2 = Number(db.prepare(`INSERT INTO seasons (competition_id, year, label, start_date, end_date, is_current)
                                  VALUES (?, 2025, '2025/26', '2025-07-01', '2026-06-01', 1)`).run(cup).lastInsertRowid);
    const one = (h, a, hg, ag) => db.prepare(`INSERT INTO matches (season_id, round, kickoff_utc, home_team_id, away_team_id, status_key,
        home_goals, away_goals, source_key, source_ref, fetched_at) VALUES (?, 'Quarter-finals', '2026-04-01T20:00:00.000Z', ?, ?, ?, ?, ?, 'api-football', ?, ?)`)
      .run(s2, T[h], T[a], hg === null ? 'scheduled' : 'finished', hg, ag, `el${h}${a}`, now());
    one(0, 1, 2, 0); one(2, 3, null, null); one(4, 5, 0, 1); one(6, 7, null, null);
    const p = bracket(db, cup);
    assert.deepEqual(p.rounds.map((r) => r.name), ['Quarter-finals', 'Semi-finals', 'Final']);
    assert.equal(p.rounds[1].ties[0].slots[0].id, T[0], 'a decided tie sends its winner on');
    assert.match(p.rounds[1].ties[0].slots[1].placeholder, /^Winner of /);
    assert.equal(p.rounds[2].ties.length, 1);

    /* A season still in its league phase falls back to the last one with
     * knockouts, and says so; promotion play-offs are kept to one side. */
    const nl = db.prepare("SELECT id FROM competitions WHERE key = 'uefa-nations-league'").get().id;
    const old = Number(db.prepare(`INSERT INTO seasons (competition_id, year, label, start_date, end_date, is_current)
                                   VALUES (?, 2024, '2024/25', '2024-09-01', '2025-06-30', 0)`).run(nl).lastInsertRowid);
    const cur = Number(db.prepare(`INSERT INTO seasons (competition_id, year, label, start_date, end_date, is_current)
                                   VALUES (?, 2026, '2026', '2026-09-01', '2027-06-30', 1)`).run(nl).lastInsertRowid);
    const nm = (season, round, h, a, hg, ag, day) => db.prepare(`INSERT INTO matches (season_id, round, kickoff_utc, home_team_id, away_team_id,
        status_key, home_goals, away_goals, source_key, source_ref, fetched_at) VALUES (?, ?, ?, ?, ?, 'finished', ?, ?, 'api-football', ?, ?)`)
      .run(season, round, day, T[h], T[a], hg, ag, `nl${season}${round}${h}`, now());
    nm(old, 'Play-offs A/B', 4, 5, 1, 0, '2025-03-20T17:00:00.000Z');
    nm(old, 'Semi-finals', 0, 1, 2, 1, '2025-06-04T19:00:00.000Z'); nm(old, 'Semi-finals', 2, 3, 0, 1, '2025-06-05T19:00:00.000Z');
    nm(old, 'Final', 0, 3, 1, 0, '2025-06-08T19:00:00.000Z');
    nm(cur, 'League A - 1', 0, 1, 1, 1, '2026-09-24T18:45:00.000Z');
    const nb = bracket(db, nl);
    assert.equal(nb.season.label, '2024/25');
    assert.deepEqual([nb.note.season, nb.note.showing, nb.note.groupPhaseEnds], ['2026', '2024/25', '2026-09-24T18:45:00.000Z']);
    assert.equal(nb.startsAt, '2025-06-04T19:00:00.000Z');
    assert.deepEqual(nb.rounds.map((r) => r.name), ['Semi-finals', 'Final']);
    assert.deepEqual(nb.sideRounds.map((r) => r.name), ['Play-offs A/B']);
  });
});

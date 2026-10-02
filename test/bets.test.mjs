import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { parseOdds, toAmerican, toFractional, parseMoney, oddsHint } from '../src/odds.js';
import { grade, settleBet } from '../server/grading.mjs';
import {
  saveSportsbook, createBet, updateBet, deleteBet, correctSettlement, settleBets, gradePredictions,
  listBets, getBet, bettingHistory,
} from '../server/bets.mjs';
import { requestAnalysis, runAnalysis } from '../server/analysis.mjs';
import { seedLeague } from './fixtures/league.mjs';

describe('Odds as typed', () => {
  test('decimal, American and fractional all become decimal', () => {
    assert.deepEqual(parseOdds('2.50'), { decimal: 2.5, format: 'decimal', text: '2.50' });
    assert.equal(parseOdds('2,5').decimal, 2.5);
    assert.equal(parseOdds('+150').decimal, 2.5);
    assert.equal(parseOdds('-200').decimal, 1.5);
    assert.equal(parseOdds('150').format, 'american');
    assert.equal(parseOdds('6/4').decimal, 2.5);
    assert.equal(parseOdds('evens').decimal, 2);
    assert.deepEqual(parseOdds('68%'), { decimal: 1.4706, format: 'percent', text: '68%' });
    assert.equal(parseOdds('68¢').decimal, 1.4706);
    assert.equal(parseOdds('68/100').decimal, 1.68, 'a fraction, not a percentage');
    assert.equal(parseOdds('68'), null, 'a bare 68 is refused, not read as decimal 68');
    assert.equal(parseOdds('68.0').decimal, 68);
    assert.match(oddsHint('68').message, /type 68%/);
    for (const bad of ['', '1', '0.9', '+50', 'abc', '3/0', '0%', '100%']) assert.equal(parseOdds(bad), null, bad);
  });

  test('converting back for display, and money in cents', () => {
    assert.equal(toAmerican(2.5), '+150');
    assert.equal(toAmerican(1.5), '-200');
    assert.equal(toFractional(2.5), '3/2');
    assert.equal(parseMoney('12.50'), 1250);
    assert.equal(parseMoney('$10'), 1000);
    assert.equal(parseMoney('0'), null);
  });
});

describe('Grading', () => {
  const ft = (home, away, extra = {}) => ({ status: 'finished', confirmed: true, kickoffUtc: '2026-01-01T15:00:00Z',
    home, away, corners: 10, cards: 4, ...extra });

  test('result markets', () => {
    assert.equal(grade('match_result', null, 'home', ft(2, 1)), 'won');
    assert.equal(grade('match_result', null, 'draw', ft(2, 1)), 'lost');
    assert.equal(grade('double_chance', null, 'draw_away', ft(1, 1)), 'won');
    assert.equal(grade('draw_no_bet', null, 'home', ft(1, 1)), 'push');
    assert.equal(grade('btts', null, 'yes', ft(1, 0)), 'lost');
  });

  test('totals push on a whole line', () => {
    assert.equal(grade('over_under', 2.5, 'over', ft(2, 1)), 'won');
    assert.equal(grade('over_under', 3, 'over', ft(2, 1)), 'push');
    assert.equal(grade('home_total', 1.5, 'under', ft(2, 1)), 'lost');
    assert.equal(grade('corners_ou', 9.5, 'over', ft(0, 0)), 'won');
    assert.equal(grade('cards_ou', 4, 'under', ft(0, 0)), 'push');
  });

  test('Asian handicap: whole, half and quarter lines, both sides', () => {
    assert.equal(grade('asian_handicap', -1, 'home', ft(2, 1)), 'push');
    assert.equal(grade('asian_handicap', -1.5, 'home', ft(2, 1)), 'lost');
    assert.equal(grade('asian_handicap', -0.75, 'home', ft(2, 1)), 'half_won');
    assert.equal(grade('asian_handicap', -0.75, 'away', ft(2, 1)), 'half_lost');
    assert.equal(grade('asian_handicap', -0.25, 'home', ft(1, 1)), 'half_lost');
    assert.equal(grade('asian_handicap', 0.25, 'home', ft(1, 1)), 'half_won');
    assert.equal(grade('asian_handicap', 0, 'away', ft(1, 1)), 'push');
  });

  test('European handicap is three-way', () => {
    assert.equal(grade('european_handicap', -1, 'draw', ft(2, 1)), 'won');
    assert.equal(grade('european_handicap', -1, 'home', ft(3, 1)), 'won');
    assert.equal(grade('european_handicap', 1, 'away', ft(1, 1)), 'lost');
  });

  test('not yet final, postponed, awarded, or missing stats', () => {
    assert.equal(grade('match_result', null, 'home', ft(2, 1, { confirmed: false })), 'pending');
    assert.equal(grade('match_result', null, 'home', ft(null, null, { status: 'live' })), 'pending');
    const postponed = { status: 'postponed', kickoffUtc: '2026-01-01T15:00:00Z' };
    assert.equal(grade('match_result', null, 'home', postponed, Date.parse('2026-01-02T15:00:00Z')), 'pending');
    assert.equal(grade('match_result', null, 'home', postponed, Date.parse('2026-01-04T15:00:00Z')), 'void');
    assert.equal(grade('match_result', null, 'home', ft(3, 0, { status: 'awarded' })), 'void');
    assert.equal(grade('corners_ou', 9.5, 'over', ft(1, 0, { corners: null })), null);
  });
});

describe('Settling a bet', () => {
  test('singles, including half results', () => {
    assert.deepEqual(settleBet({ stakeMinor: 1000, totalOdds: 2.5, legs: [{ outcome: 'won', odds: 2.5 }] }), { outcome: 'won', profitMinor: 1500 });
    assert.deepEqual(settleBet({ stakeMinor: 1000, totalOdds: 1.9, legs: [{ outcome: 'half_won', odds: 1.9 }] }), { outcome: 'half_won', profitMinor: 450 });
    assert.deepEqual(settleBet({ stakeMinor: 1000, totalOdds: 1.9, legs: [{ outcome: 'half_lost', odds: 1.9 }] }), { outcome: 'half_lost', profitMinor: -500 });
    assert.deepEqual(settleBet({ stakeMinor: 1000, totalOdds: 2, legs: [{ outcome: 'push', odds: 2 }] }), { outcome: 'push', profitMinor: 0 });
  });

  test('parlays: a lost leg loses, a void leg drops out, a pending leg waits', () => {
    const legs = (o1, o2) => [{ outcome: o1, odds: 2 }, { outcome: o2, odds: 1.5 }];
    assert.deepEqual(settleBet({ stakeMinor: 1000, totalOdds: 3, legs: legs('won', 'won') }), { outcome: 'won', profitMinor: 2000 });
    assert.equal(settleBet({ stakeMinor: 1000, totalOdds: 3, legs: legs('won', 'lost') }).outcome, 'lost');
    assert.equal(settleBet({ stakeMinor: 1000, totalOdds: 3, legs: legs('pending', 'lost') }).outcome, 'lost');
    assert.equal(settleBet({ stakeMinor: 1000, totalOdds: 3, legs: legs('won', 'pending') }).outcome, 'pending');
    const voided = settleBet({ stakeMinor: 1000, totalOdds: 3, legs: legs('won', 'void') });
    assert.equal(voided.outcome, 'won');
    assert.equal(voided.profitMinor, 1000, 'the void leg drops out: 2.00 on its own');
  });
});

describe('Recording bets', () => {
  let db;
  let league;
  beforeEach(() => {
    db = openDatabase(':memory:');
    league = seedLeague(db);
    saveSportsbook(db, { name: 'My App', currency: 'USD' });
  });
  const single = (over = {}) => ({ sportsbook: 'my-app', stake: '10', legs: [{ matchId: league.upcomingId,
    market: 'match_result', selection: 'home', odds: '+120' }], ...over });

  test('the model’s view at the moment of the bet is frozen onto the leg', async () => {
    const run = requestAnalysis(db, league.upcomingId, 'u1');
    await runAnalysis(db, run.id, { explainer: null });
    const bet = createBet(db, 'u1', single());
    const leg = bet.legs[0];
    assert.equal(bet.kind, 'single');
    assert.equal(bet.totalOdds, 2.2);
    assert.equal(bet.potentialPayoutMinor, 2200);
    assert.equal(leg.oddsText, '+120');
    assert.equal(leg.oddsFormat, 'american');
    assert.ok(leg.modelProbability > 0.5);
    assert.ok(Math.abs(leg.edge - (leg.modelProbability - 1 / 2.2)) < 1e-4);
    assert.ok(Math.abs(leg.ev - (leg.modelProbability * 1.2 - (1 - leg.modelProbability))) < 1e-4);
    assert.equal(typeof leg.followedRecommendation, 'boolean');
    assert.equal(bet.outcome, 'pending');
  });

  test('a bet recorded before any analysis has no model view, and that is fine', () => {
    const bet = createBet(db, 'u1', single());
    assert.equal(bet.legs[0].modelProbability, null);
    assert.equal(bet.legs[0].followedRecommendation, null);
  });

  test('a parlay multiplies its legs unless the app quoted its own total', () => {
    const legs = [
      { matchId: league.upcomingId, market: 'match_result', selection: 'home', odds: '2.0' },
      { matchId: league.upcomingId, market: 'over_under', line: 2.5, selection: 'over', odds: '1.8' },
    ];
    assert.equal(createBet(db, 'u1', single({ legs })).totalOdds, 3.6);
    const boosted = createBet(db, 'u1', single({ legs, totalOdds: '4.0' }));
    assert.equal(boosted.kind, 'parlay');
    assert.equal(boosted.totalOdds, 4);
  });

  test('bad input is refused with a reason', () => {
    assert.throws(() => createBet(db, 'u1', single({ sportsbook: 'nope' })), /betting app/);
    assert.throws(() => createBet(db, 'u1', single({ stake: '0' })), /how much you bet/);
    assert.throws(() => createBet(db, 'u1', single({ legs: [{ matchId: league.upcomingId, market: 'match_result', selection: 'home', odds: 'x' }] })), /Not valid odds/);
    assert.throws(() => createBet(db, 'u1', single({ legs: [{ matchId: league.upcomingId, market: 'over_under', selection: 'over', odds: '2' }] })), /needs a line/);
    assert.throws(() => createBet(db, 'u1', single({ legs: [{ matchId: league.upcomingId, market: 'btts', selection: 'home', odds: '2' }] })), /not a valid choice/);
    assert.throws(() => createBet(db, 'u1', single({ placedAt: new Date(Date.now() + 86400_000).toISOString() })), /future/);
  });

  test('edits keep the previous version; deletes are soft and recorded', () => {
    const bet = createBet(db, 'u1', single());
    const edited = updateBet(db, 'u1', bet.id, { ...single({ stake: '25' }), reason: 'Typo in stake' });
    assert.equal(edited.stakeMinor, 2500);
    assert.equal(edited.revisions[0].reason, 'Typo in stake');
    assert.equal(edited.legs.length, 1, 'only the current legs are shown');
    deleteBet(db, 'u1', bet.id);
    assert.equal(listBets(db, 'u1').length, 0);
    assert.equal(getBet(db, bet.id, 'u1').deleted, true);
    assert.throws(() => db.prepare('DELETE FROM bets WHERE id = ?').run(bet.id), /never deleted/);
  });

  test('settles automatically once the result is confirmed; a correction stands; history adds up', () => {
    const bet = createBet(db, 'u1', single({ stake: '10', legs: [{ matchId: league.upcomingId, market: 'match_result', selection: 'home', odds: '2.5' }] }));
    /* The match is played and confirmed: home wins 2–0. */
    db.prepare(`UPDATE matches SET status_key = 'finished', home_goals = 2, away_goals = 0, kickoff_utc = ?,
                result_confirmed_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 5 * 3600_000).toISOString(), new Date().toISOString(), league.upcomingId);
    settleBets(db);
    let b = getBet(db, bet.id, 'u1');
    assert.equal(b.outcome, 'won');
    assert.equal(b.profitMinor, 1500);
    assert.equal(b.legs[0].outcome, 'won');
    assert.equal(settleBets(db), 0, 'settling again writes nothing');

    correctSettlement(db, 'u1', bet.id, { outcome: 'void', reason: 'App voided it: player withdrawn' });
    settleBets(db);
    b = getBet(db, bet.id, 'u1');
    assert.equal(b.outcome, 'void', 'the manual correction is not overwritten');
    assert.equal(b.settledBy, 'manual');
    assert.equal(b.settlements.length, 2, 'both rows kept');
    assert.throws(() => db.prepare("UPDATE settlements SET outcome = 'won'").run(), /cannot be changed/);

    const h = bettingHistory(db, 'u1');
    assert.equal(h.totals.bets, 1);
    assert.equal(h.totals.pushed, 1);
    assert.equal(h.totals.profitMinor, 0);
  });

  test('history: totals, ROI and breakdowns', () => {
    const played = (home, away) => db.prepare(`UPDATE matches SET status_key = 'finished', home_goals = ?, away_goals = ?,
      kickoff_utc = ?, result_confirmed_at = ? WHERE id = ?`).run(home, away, new Date(Date.now() - 5 * 3600_000).toISOString(),
      new Date().toISOString(), league.upcomingId);
    createBet(db, 'u1', single({ stake: '10', legs: [{ matchId: league.upcomingId, market: 'match_result', selection: 'home', odds: '2.0' }] }));
    createBet(db, 'u1', single({ stake: '10', legs: [{ matchId: league.upcomingId, market: 'btts', selection: 'yes', odds: '1.8' }] }));
    played(1, 0);
    settleBets(db);
    const h = bettingHistory(db, 'u1');
    assert.equal(h.totals.won, 1);
    assert.equal(h.totals.lost, 1);
    assert.equal(h.totals.winRate, 0.5);
    assert.equal(h.totals.stakedMinor, 2000);
    assert.equal(h.totals.profitMinor, 0);
    assert.equal(h.totals.roi, 0);
    assert.equal(h.byMarket.length, 2);
    assert.equal(h.overTime.length, 2);
    assert.ok(h.bySportsbook[0].key === 'My App');
  });

  test('predictions are graded from the result, and re-graded if it changes', async () => {
    const run = requestAnalysis(db, league.upcomingId, 'u1');
    await runAnalysis(db, run.id, { explainer: null });
    db.prepare(`UPDATE matches SET status_key = 'finished', home_goals = 1, away_goals = 1, kickoff_utc = ?,
                result_confirmed_at = ? WHERE id = ?`).run(new Date(Date.now() - 5 * 3600_000).toISOString(),
      new Date().toISOString(), league.upcomingId);
    const n = gradePredictions(db);
    assert.ok(n > 50);
    assert.equal(gradePredictions(db), 0, 'nothing new the second time');
    const draw = db.prepare(`SELECT g.outcome FROM prediction_grades g JOIN predictions p ON p.id = g.prediction_id
      JOIN selections s ON s.id = p.selection_id JOIN markets mk ON mk.id = s.market_id
      WHERE mk.market_type_key = 'match_result' AND s.key = 'draw'`).get();
    assert.equal(draw.outcome, 'won');
    db.prepare('UPDATE matches SET home_goals = 2 WHERE id = ?').run(league.upcomingId);
    assert.ok(gradePredictions(db) > 0, 'a corrected score re-grades');
  });
});

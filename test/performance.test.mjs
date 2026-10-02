import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { fitIsotonic, applyKnots, binMetrics, calibratePriced, reliabilityFactor } from '../server/model/calibration.mjs';
import { trainLearned, predictLearned, scoreResults, INPUTS } from '../server/model/learned.mjs';
import { runBacktest } from '../server/backtest.mjs';
import { performance, fitCalibrations, calibrationFor, trainChallenger, snapshotPerformance } from '../server/performance.mjs';
import { requestAnalysis, runAnalysis, analysisForMatch } from '../server/analysis.mjs';
import { MODEL_KEY, MODEL_VERSION } from '../server/model/goals.mjs';
import { seedLeague } from './fixtures/league.mjs';

const DAY = 86400_000;

describe('Calibration (pure)', () => {
  test('isotonic fit is monotone and pools violators', () => {
    const bins = [
      { p: 0.1, w: 10, wy: 3 }, { p: 0.2, w: 10, wy: 1 }, // violates: 30% then 10%
      { p: 0.5, w: 10, wy: 5 }, { p: 0.8, w: 10, wy: 9 },
    ];
    const knots = fitIsotonic(bins);
    assert.equal(knots.length, 3, 'the first two pooled');
    assert.ok(knots.every((k, i) => i === 0 || (k[0] >= knots[i - 1][0] && k[1] >= knots[i - 1][1])));
    assert.equal(knots[0][1], 0.2);
    assert.equal(applyKnots(knots, 0.65), 0.5 + (0.65 - 0.5) / (0.8 - 0.5) * (0.9 - 0.5));
    assert.equal(applyKnots(knots, 0.01), 0.2, 'flat below the first knot');
    assert.equal(applyKnots(knots, 0.99), 0.9, 'flat above the last');
  });

  test('metrics: a well-calibrated set beats an over-confident one', () => {
    const bins = [{ p: 0.3, w: 100, wy: 30 }, { p: 0.7, w: 100, wy: 70 }];
    const honest = binMetrics(bins);
    const bold = binMetrics(bins, (p) => (p < 0.5 ? 0.1 : 0.9));
    assert.ok(honest.ece < 1e-9);
    assert.ok(bold.logLoss > honest.logLoss && bold.brier > honest.brier && bold.ece > 0.15);
  });

  test('calibrated groups still add up, and double chance follows the match result', () => {
    const priced = [
      { market: 'match_result', line: null, selection: 'home', p: 0.5 },
      { market: 'match_result', line: null, selection: 'draw', p: 0.25 },
      { market: 'match_result', line: null, selection: 'away', p: 0.25 },
      { market: 'double_chance', line: null, selection: 'home_draw', p: 0.75 },
      { market: 'over_under', line: 2.5, selection: 'over', p: 0.6 },
      { market: 'over_under', line: 2.5, selection: 'under', p: 0.4 },
      { market: 'btts', line: null, selection: 'yes', p: 0.55 },
    ];
    const shrink = JSON.stringify([[0, 0.1], [1, 0.8]]);
    const fits = new Map([['match_result', { applied: 1, knots_json: shrink }], ['over_under', { applied: 1, knots_json: shrink }],
      ['btts', { applied: 0, knots_json: shrink }]]);
    const out = calibratePriced(priced, fits);
    const mr = out.filter((x) => x.market === 'match_result');
    assert.ok(Math.abs(mr.reduce((a, x) => a + x.pCal, 0) - 1) < 1e-3);
    assert.ok(Math.abs(out[3].pCal - (mr[0].pCal + mr[1].pCal)) < 1e-3, 'home or draw = home + draw');
    assert.ok(Math.abs(out[4].pCal + out[5].pCal - 1) < 1e-3);
    assert.equal(out[6].pCal, null, 'a fit that did not help is not applied');
  });

  test('confidence factor comes from the calibration record', () => {
    assert.equal(reliabilityFactor(null), 1);
    assert.equal(reliabilityFactor({ holdout_n: 50, applied: 0, raw_ece: 0.2 }), 1, 'too little to judge');
    assert.equal(reliabilityFactor({ holdout_n: 500, applied: 0, raw_ece: 0.01 }), 1);
    assert.equal(reliabilityFactor({ holdout_n: 500, applied: 0, raw_ece: 0.1 }), 0.8);
    assert.ok(Math.abs(reliabilityFactor({ holdout_n: 500, applied: 1, raw_ece: 0.1, cal_ece: 0.05 }) - 0.9) < 1e-9);
  });
});

describe('Learned challenger (pure)', () => {
  test('starts as Dixon–Coles and learns a signal the goals model misses', () => {
    /* Synthetic: Dixon–Coles says 45/27/28, but form decides more than it knows. */
    let s = 7;
    const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
    const dc = { home: 0.45, draw: 0.27, away: 0.28 };
    const rows = Array.from({ length: 3000 }, () => {
      const form = rand() * 2 - 1;
      const pHome = Math.min(0.85, Math.max(0.05, 0.45 + 0.3 * form));
      const pAway = Math.max(0.05, 0.73 - pHome);
      const u = rand();
      const y = u < pHome ? 'home' : u < pHome + pAway ? 'away' : 'draw';
      const x = INPUTS.map((k) => ({ bias: 1, dcHomeVsDraw: Math.log(dc.home / dc.draw), dcAwayVsDraw: Math.log(dc.away / dc.draw),
        formDiff: form }[k] ?? 0));
      return { x, y, dc };
    });
    const start = predictLearned({ home: INPUTS.map((k) => (k === 'dcHomeVsDraw' ? 1 : 0)),
      away: INPUTS.map((k) => (k === 'dcAwayVsDraw' ? 1 : 0)) }, rows[0].x);
    assert.ok(Math.abs(start.home - dc.home) < 1e-9, 'the starting weights reproduce Dixon–Coles');
    const w = trainLearned(rows.slice(0, 2400));
    const test = rows.slice(2400);
    const mine = scoreResults(test, (r) => predictLearned(w, r.x));
    const base = scoreResults(test, (r) => r.dc);
    assert.ok(mine.logLoss < base.logLoss - 0.01, `learned ${mine.logLoss} vs DC ${base.logLoss}`);
    assert.ok(w.home[INPUTS.indexOf('formDiff')] > 0.3);
  });
});

describe('Backtest, performance and calibration on a simulated season', () => {
  let db;
  let league;
  beforeEach(() => {
    db = openDatabase(':memory:');
    league = seedLeague(db, { teams: 12, start: Date.now() - 260 * DAY });
    /* Start the backtest a third of the way into the season. */
    const from = db.prepare('SELECT kickoff_utc FROM matches WHERE id = ?').get(league.matchIds[45]).kickoff_utc;
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('backtest_from', ?, ?)").run(from, from);
  });

  test('every backtest price was made before its match day, through the live pipeline', async () => {
    const r = await runBacktest(db, { seconds: 60 });
    assert.ok(r.matches > 50, `${r.matches} priced`);
    assert.equal(r.remaining, 0);
    const rows = db.prepare(`SELECT b.as_of, m.kickoff_utc FROM backtest_matches b JOIN matches m ON m.id = b.match_id`).all();
    assert.ok(rows.every((x) => x.as_of < x.kickoff_utc), 'asOf before kickoff');
    assert.ok(rows.every((x) => Date.parse(x.kickoff_utc) - Date.parse(x.as_of) < DAY), 'the morning of the match day');
    const graded = db.prepare("SELECT COUNT(*) AS n FROM backtest_predictions WHERE outcome IN ('won', 'lost')").get().n;
    assert.ok(graded > 1000);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backtest_matches WHERE inputs_json IS NULL AND status = ?').get('priced').n, 0);
    /* Run again: nothing left, nothing duplicated. */
    const before = db.prepare('SELECT COUNT(*) AS n FROM backtest_predictions').get().n;
    assert.equal((await runBacktest(db, { seconds: 10 })).matches, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM backtest_predictions').get().n, before);
  });

  test('the model shows skill, and performance breaks down by market, confidence and month', async () => {
    await runBacktest(db, { seconds: 60 });
    const perf = performance(db, { source: 'backtest' });
    assert.ok(perf.total.n > 1000);
    assert.ok(perf.total.brier < perf.total.naiveBrier, 'beats always-guessing-the-hit-rate');
    assert.ok(perf.total.reliability.length >= 5);
    const mr = perf.byMarket.find((m) => m.key === 'match_result');
    assert.ok(mr && mr.n > 100 && mr.label === 'Match result (1X2)');
    assert.ok(perf.byConfidence.length >= 1 && perf.byMonth.length >= 2);
    assert.equal(perf.backtest.matches, perf.backtest.priced);
    const ou = performance(db, { market: 'over_under', line: 2.5, selection: 'over' });
    assert.ok(ou.total.n > 0 && ou.total.n < perf.total.n);
    const favourites = performance(db, { market: 'match_result', favourite: 'home', selection: 'home' });
    assert.ok(favourites.total.n > 0 && favourites.total.saidPct > 0.34);
  });

  test('calibration fits use only graded selections and record the holdout', async () => {
    await runBacktest(db, { seconds: 60 });
    const fits = fitCalibrations(db);
    assert.ok(fits.length >= 3, 'markets with 400+ graded selections');
    const map = calibrationFor(db);
    const ou = map.get('over_under');
    assert.ok(ou.holdout_n > 0 && ou.raw_log_loss > 0);
    assert.equal(ou.applied, ou.cal_log_loss < ou.raw_log_loss && ou.holdout_n >= 100 ? 1 : 0);
    /* A fit made later is not visible to an analysis made earlier. */
    assert.equal(calibrationFor(db, MODEL_KEY, MODEL_VERSION, '2000-01-01T00:00:00Z').size, 0);
    assert.throws(() => db.prepare('UPDATE calibrations SET applied = 1').run(), /cannot be changed/);
    assert.ok(snapshotPerformance(db) > 0);
    assert.match(trainChallenger(db).reason, /training starts at 600/);
  });

  test('an analysis uses the calibration in force and keeps the raw probability beside it', async () => {
    const at = new Date(Date.now() - 3600_000).toISOString();
    db.prepare(`INSERT INTO calibrations (model_key, model_version, market, fitted_at, n, knots_json, holdout_n, raw_log_loss,
                cal_log_loss, raw_brier, cal_brier, raw_ece, cal_ece, applied) VALUES (?, ?, 'btts', ?, 1000, ?, 300, 0.69, 0.68, 0.25, 0.24, 0.1, 0.03, 1)`)
      .run(MODEL_KEY, MODEL_VERSION, at, JSON.stringify([[0, 0.3], [1, 0.7]]));
    const run = requestAnalysis(db, league.upcomingId, 'u1');
    await runAnalysis(db, run.id);
    const a = analysisForMatch(db, league.upcomingId).latest;
    const yes = a.predictions.find((p) => p.market === 'btts' && p.selection === 'yes');
    const no = a.predictions.find((p) => p.market === 'btts' && p.selection === 'no');
    assert.notEqual(yes.calibratedProbability, null);
    assert.equal(yes.probability, yes.calibratedProbability);
    assert.notEqual(yes.rawProbability, yes.calibratedProbability);
    assert.ok(Math.abs(yes.probability + no.probability - 1) < 1e-3);
    assert.ok(Math.abs(yes.fairOdds - 1 / yes.probability) < 0.01, 'fair odds from the calibrated probability');
    assert.deepEqual(a.calibrated, ['btts']);
    const other = a.predictions.find((p) => p.market === 'match_result');
    assert.equal(other.calibratedProbability, null, 'markets without a fit stay raw');
  });
});

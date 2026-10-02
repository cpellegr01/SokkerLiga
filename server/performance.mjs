/* Model Performance — were the predictions right?
 *
 * Reads scored_predictions_v1: every graded selection, from live analyses
 * and from the backtest, in one shape (p, y, weight). Everything here is
 * aggregated in SQL by 10%-wide probability bucket and selection, then
 * rolled up in JavaScript, so a few hundred thousand rows stay quick.
 *
 *   Brier score   mean of (p − outcome)²; lower is better
 *   Log loss      mean of −ln(probability given to what happened); lower is better
 *   Naive Brier   what always saying each selection's own hit rate would score;
 *                 the model has skill when it beats this
 *   Calibration   |said − happened| per bucket, averaged (expected calibration error)
 *
 * Also the nightly jobs: calibration fits, the learned challenger, and
 * dated performance snapshots.
 */

import { transaction, getSetting } from './db.mjs';
import { fitIsotonic, binMetrics, applyKnots } from './model/calibration.mjs';
import { trainLearned, predictLearned, scoreResults, INPUTS, LEARNED_KEY } from './model/learned.mjs';
import { MODEL_KEY, MODEL_VERSION } from './model/goals.mjs';

const VIEW = 'scored_predictions_v1';
const MIN_CALIBRATION_N = 400;
const HOLDOUT = 0.2;

/* ------------------------------------------------------------- filters */

function where(f = {}) {
  const w = ['1=1'];
  const a = [];
  if (f.source) { w.push('source = ?'); a.push(f.source); }
  if (f.competition) { w.push('competition_id = ?'); a.push(Number(f.competition)); }
  if (f.market) { w.push('market = ?'); a.push(f.market); }
  if (f.line !== undefined && f.line !== null && f.line !== '') { w.push('line = ?'); a.push(Number(f.line)); }
  if (f.selection) { w.push('selection = ?'); a.push(f.selection); }
  if (f.confidence) { w.push('confidence_band = ?'); a.push(f.confidence); }
  /* Lists, for questions that name several. */
  const list = (col, values) => {
    if (!Array.isArray(values) || !values.length) return;
    w.push(`${col} IN (${values.map(() => '?').join(',')})`);
    a.push(...values);
  };
  list('competition_id', f.competitions);
  list('market', f.markets);
  list('confidence_band', f.confidences);
  if (f.model) { w.push("model_key || ' v' || model_version = ?"); a.push(f.model); }
  if (f.from) { w.push('kickoff_utc >= ?'); a.push(f.from); }
  if (f.to) { w.push('kickoff_utc < ?'); a.push(f.to); }
  if (f.team) { w.push('(home_team_id = ? OR away_team_id = ?)'); a.push(Number(f.team), Number(f.team)); }
  /* The model's favourite in the match result: the side it gave the most. */
  if (f.favourite === 'home' || f.favourite === 'away') {
    w.push(`EXISTS (SELECT 1 FROM ${VIEW} f WHERE f.match_id = ${VIEW}.match_id AND f.source = ${VIEW}.source
              AND f.model_key = ${VIEW}.model_key AND f.market = 'match_result' AND f.selection = ?
              AND f.p >= (SELECT MAX(g.p) FROM ${VIEW} g WHERE g.match_id = f.match_id AND g.source = f.source
                          AND g.model_key = f.model_key AND g.market = 'match_result'))`);
    a.push(f.favourite);
  }
  /* Selections that pass the given thresholds — "recommendations" for the
   * backtest, which has no recommendation rows of its own. */
  if (f.thresholds) {
    const t = f.thresholds;
    const bands = ['low', 'medium', 'high'].slice(['low', 'medium', 'high'].indexOf(t.minConfidence));
    w.push(`p >= ? AND 1.0 / p >= ? AND 1.0 / p <= ? AND confidence_band IN (${bands.map(() => '?').join(',')})`);
    a.push(t.minProbability, t.minFairOdds ?? 1, t.maxFairOdds, ...bands);
  }
  return { sql: w.join(' AND '), args: a };
}

/* Aggregate by a dimension, then roll up. */
export function grouped(db, dim, f) {
  const { sql, args } = where(f);
  /* By team: each selection counts for both teams in its match. */
  const from = dim === 'team'
    ? `(SELECT *, home_team_id AS team FROM ${VIEW} WHERE ${sql} UNION ALL SELECT *, away_team_id FROM ${VIEW} WHERE ${sql})`
    : `(SELECT * FROM ${VIEW} WHERE ${sql})`;
  const rows = db.prepare(`
    SELECT ${dim} AS k, market, line, selection, MIN(9, CAST(p * 10 AS INTEGER)) AS bucket,
           SUM(w) AS n, SUM(w * y) AS wy, SUM(w * p) AS wp, SUM(w * (p - y) * (p - y)) AS sq,
           SUM(-w * (y * ln(p) + (1 - y) * ln(1 - p))) AS ll
    FROM ${from}
    GROUP BY k, market, line, selection, bucket`).all(...args, ...(dim === 'team' ? args : []));
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.k)) by.set(r.k, []);
    by.get(r.k).push(r);
  }
  return [...by].map(([k, list]) => ({ key: k, ...rollup(list) }));
}

function rollup(rows) {
  let n = 0; let wy = 0; let wp = 0; let sq = 0; let ll = 0;
  const sel = new Map();
  const buckets = Array.from({ length: 10 }, (_, i) => ({ bucket: i, n: 0, wp: 0, wy: 0 }));
  for (const r of rows) {
    n += r.n; wy += r.wy; wp += r.wp; sq += r.sq; ll += r.ll;
    const k = `${r.market}|${r.line}|${r.selection}`;
    const s = sel.get(k) ?? { n: 0, wy: 0 };
    s.n += r.n; s.wy += r.wy; sel.set(k, s);
    const b = buckets[r.bucket];
    b.n += r.n; b.wp += r.wp; b.wy += r.wy;
  }
  if (!n) return { n: 0 };
  let naive = 0;
  for (const s of sel.values()) { const f = s.wy / s.n; naive += s.n * f * (1 - f); }
  let ece = 0;
  for (const b of buckets) ece += Math.abs(b.wp - b.wy);
  const brier = sq / n;
  const naiveBrier = naive / n;
  return {
    n: r1(n), saidPct: wp / n, hitPct: wy / n, brier, logLoss: ll / n, naiveBrier,
    skill: naiveBrier > 0 ? 1 - brier / naiveBrier : null, ece: ece / n,
    reliability: buckets.filter((b) => b.n > 0).map((b) => ({ bucket: b.bucket, n: r1(b.n), said: b.wp / b.n, happened: b.wy / b.n })),
  };
}

const r1 = (x) => Math.round(x * 10) / 10;

/* ---------------------------------------------------------- the cube
 *
 * The page's filters and breakdowns are all coarse (source, competition,
 * confidence, model, month, market, line, selection), so one pass over the
 * view grouped by all of them — a few thousand cells — answers every
 * combination in memory. The cube is rebuilt only when the data change:
 * new backtest rows, new grades or new predictions.
 */

const CUBE_DIMS = ['source', 'competition_id', 'confidence_band', "model_key || ' v' || model_version", 'substr(kickoff_utc, 1, 7)'];
let cubeCache = null;
let teamCache = new Map();

function dataVersion(db) {
  const v = db.prepare(`SELECT (SELECT MAX(id) FROM backtest_predictions) AS b, (SELECT MAX(id) FROM prediction_grades) AS g,
                               (SELECT MAX(id) FROM predictions) AS p`).get();
  return `${v.b}|${v.g}|${v.p}`;
}

function cube(db, version) {
  if (cubeCache?.version === version) return cubeCache.cells;
  const cells = db.prepare(`
    SELECT source, competition_id AS competition, confidence_band AS confidence, model_key || ' v' || model_version AS model,
           substr(kickoff_utc, 1, 7) AS month, market, line, selection, MIN(9, CAST(p * 10 AS INTEGER)) AS bucket,
           SUM(w) AS n, SUM(w * y) AS wy, SUM(w * p) AS wp, SUM(w * (p - y) * (p - y)) AS sq,
           SUM(-w * (y * ln(p) + (1 - y) * ln(1 - p))) AS ll
    FROM ${VIEW} GROUP BY ${CUBE_DIMS.map((_, i) => i + 1).join(', ')}, market, line, selection, bucket`).all();
  cubeCache = { version, cells };
  teamCache = new Map();
  return cells;
}

/* Filters the cube can answer; anything finer (a team, favourites, exact
 * dates, thresholds) goes to SQL. */
function cubeFilter(f) {
  const monthOf = (d) => (d ? String(d).slice(0, 7) : null);
  const exact = (d) => d && !/^\d{4}-\d{2}(-01)?$/.test(String(d).slice(0, 10));
  if (f.team || f.favourite || f.thresholds || exact(f.from) || exact(f.to)) return null;
  const from = monthOf(f.from);
  const to = monthOf(f.to);
  const comps = f.competitions?.length ? new Set(f.competitions.map(Number)) : null;
  const markets = f.markets?.length ? new Set(f.markets) : null;
  const confs = f.confidences?.length ? new Set(f.confidences) : null;
  return (c) => (!f.source || c.source === f.source)
    && (!f.competition || c.competition === Number(f.competition)) && (!comps || comps.has(c.competition))
    && (!f.market || c.market === f.market) && (!markets || markets.has(c.market))
    && (f.line === undefined || f.line === null || f.line === '' || c.line === Number(f.line))
    && (!f.selection || c.selection === f.selection)
    && (!f.confidence || c.confidence === f.confidence) && (!confs || confs.has(c.confidence))
    && (!f.model || c.model === f.model)
    && (!from || c.month >= from) && (!to || c.month < to);
}

function rollupBy(cells, key) {
  const by = new Map();
  for (const c of cells) {
    const k = key(c);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(c);
  }
  return [...by].map(([k, list]) => ({ key: k, ...rollup(list) }));
}

/** The Model Performance page. */
export function performance(db, filters = {}) {
  const f = { ...filters };
  const version = dataVersion(db);
  const test = cubeFilter(f);
  let by;
  if (test) {
    const cells = cube(db, version).filter(test);
    by = (dim) => rollupBy(cells, (c) => (dim === 'all' ? 'all' : c[dim]));
  } else {
    const SQL = { all: "'all'", source: 'source', market: 'market', competition: 'competition_id', confidence: 'confidence_band',
      model: "model_key || ' v' || model_version", month: 'substr(kickoff_utc, 1, 7)' };
    by = (dim) => grouped(db, SQL[dim], f);
  }
  const names = {
    market: new Map(db.prepare('SELECT key, name FROM market_types').all().map((r) => [r.key, r.name])),
    competition: new Map(db.prepare('SELECT id, name FROM competitions').all().map((r) => [r.id, r.name])),
  };
  const order = new Map(db.prepare('SELECT key, ordinal FROM market_types').all().map((r) => [r.key, r.ordinal]));
  const strip = ({ reliability, ...rest }) => rest;
  const teamKey = `${version}|${JSON.stringify(f)}`;
  if (!teamCache.has(teamKey)) teamCache.set(teamKey, teamErrors(db, f));
  return {
    filters: f,
    total: by('all')[0] ?? { key: 'all', n: 0 },
    bySource: by('source').map(strip),
    byMarket: by('market').map((r) => ({ ...strip(r), label: names.market.get(r.key) ?? r.key }))
      .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99)),
    byCompetition: by('competition').map((r) => ({ ...strip(r), label: names.competition.get(r.key) ?? String(r.key) }))
      .sort((a, b) => b.n - a.n),
    byConfidence: by('confidence').map(strip)
      .sort((a, b) => ['high', 'medium', 'low'].indexOf(a.key) - ['high', 'medium', 'low'].indexOf(b.key)),
    byModel: by('model').map(strip),
    byMonth: by('month').map(strip).sort((a, b) => a.key.localeCompare(b.key)),
    teams: teamCache.get(teamKey),
    calibration: calibrationSummary(db),
    challenger: challengerSummary(db),
    backtest: backtestStatus(db),
    options: {
      models: [...new Set(cube(db, version).map((c) => c.model))],
    },
  };
}

/* Which teams the model reads worst: match-result log loss in their
 * matches against the average, for teams with at least 15 graded matches. */
function teamErrors(db, f) {
  const { sql, args } = where({ ...f, market: 'match_result' });
  const rows = db.prepare(`
    SELECT t AS team_id, COUNT(DISTINCT match_id) AS matches, SUM(ll) / COUNT(DISTINCT match_id) AS ll
    FROM (SELECT home_team_id AS t, match_id, -w * (y * ln(p) + (1 - y) * ln(1 - p)) AS ll FROM ${VIEW} WHERE ${sql}
          UNION ALL
          SELECT away_team_id, match_id, -w * (y * ln(p) + (1 - y) * ln(1 - p)) FROM ${VIEW} WHERE ${sql})
    GROUP BY t HAVING matches >= 15`).all(...args, ...args);
  if (!rows.length) return { average: null, worst: [], best: [] };
  const avg = rows.reduce((a, r) => a + r.ll * r.matches, 0) / rows.reduce((a, r) => a + r.matches, 0);
  const name = db.prepare('SELECT name, logo_url FROM teams WHERE id = ?');
  const shaped = rows.map((r) => ({ teamId: r.team_id, ...pick(name.get(r.team_id)), matches: r.matches, logLoss: r.ll, excess: r.ll - avg }))
    .sort((a, b) => b.excess - a.excess);
  return { average: avg, worst: shaped.slice(0, 10), best: shaped.slice(-5).reverse() };
}
const pick = (t) => ({ name: t?.name ?? '?', logo: t?.logo_url ?? null });

/* --------------------------------------------------------- calibration */

/** The latest fit per market made at or before `asOf`. */
export function calibrationFor(db, modelKey = MODEL_KEY, modelVersion = MODEL_VERSION, asOf = new Date().toISOString()) {
  const rows = db.prepare(`
    SELECT c.* FROM calibrations c
    WHERE c.model_key = ? AND c.model_version = ? AND c.fitted_at <= ?
      AND c.id = (SELECT id FROM calibrations c2 WHERE c2.model_key = c.model_key AND c2.model_version = c.model_version
                  AND c2.market = c.market AND c2.fitted_at <= ? ORDER BY c2.fitted_at DESC, c2.id DESC LIMIT 1)`)
    .all(modelKey, modelVersion, asOf, asOf);
  return new Map(rows.map((r) => [r.market, r]));
}

function bins(db, market, from, to) {
  return db.prepare(`
    SELECT ROUND(p_raw * 100) / 100.0 AS p, SUM(w) AS w, SUM(w * y) AS wy FROM ${VIEW}
    WHERE model_key = ? AND model_version = ? AND market = ? AND kickoff_utc >= ? AND kickoff_utc < ?
    GROUP BY ROUND(p_raw * 100) ORDER BY p`).all(MODEL_KEY, MODEL_VERSION, market, from, to);
}

/**
 * Refit every market's calibration from what was graded before `now`.
 * A trial fit on the oldest 80% is scored on the newest 20%; the full fit
 * is applied only if the trial beat the raw probabilities there.
 */
export function fitCalibrations(db, { now = new Date() } = {}) {
  const at = now.toISOString();
  const markets = db.prepare(`SELECT market, SUM(w) AS n, COUNT(*) AS cnt FROM ${VIEW}
                              WHERE model_key = ? AND model_version = ? AND kickoff_utc < ? GROUP BY market`)
    .all(MODEL_KEY, MODEL_VERSION, at);
  const insert = db.prepare(`INSERT INTO calibrations (model_key, model_version, market, fitted_at, n, knots_json, holdout_n,
      raw_log_loss, cal_log_loss, raw_brier, cal_brier, raw_ece, cal_ece, applied)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const out = [];
  transaction(db, () => {
    for (const m of markets) {
      /* Double chance is rebuilt from the calibrated match result instead. */
      if (m.n < MIN_CALIBRATION_N || m.market === 'double_chance') continue;
      /* The newest fifth by count, not by calendar: seasons have gaps. */
      const split = db.prepare(`SELECT kickoff_utc FROM ${VIEW} WHERE model_key = ? AND model_version = ? AND market = ? AND kickoff_utc < ?
                                ORDER BY kickoff_utc LIMIT 1 OFFSET ?`)
        .get(MODEL_KEY, MODEL_VERSION, m.market, at, Math.floor(m.cnt * (1 - HOLDOUT))).kickoff_utc;
      const train = bins(db, m.market, '0000', split);
      const test = bins(db, m.market, split, at);
      const all = bins(db, m.market, '0000', at);
      const trial = fitIsotonic(train);
      const raw = binMetrics(test);
      const cal = binMetrics(test, (p) => applyKnots(trial, p));
      const applied = raw.n >= 100 && cal.logLoss !== null && cal.logLoss < raw.logLoss ? 1 : 0;
      const knots = fitIsotonic(all);
      insert.run(MODEL_KEY, MODEL_VERSION, m.market, at, m.n, JSON.stringify(knots), raw.n,
        raw.logLoss, cal.logLoss, raw.brier, cal.brier, raw.ece, cal.ece, applied);
      out.push({ market: m.market, n: m.n, applied: !!applied });
    }
  });
  return out;
}

function calibrationSummary(db) {
  const fits = calibrationFor(db);
  const names = new Map(db.prepare('SELECT key, name, ordinal FROM market_types').all().map((r) => [r.key, r]));
  return [...fits.values()].map((c) => ({
    market: c.market, label: names.get(c.market)?.name ?? c.market, fittedAt: c.fitted_at, n: c.n, holdoutN: c.holdout_n,
    raw: { logLoss: c.raw_log_loss, brier: c.raw_brier, ece: c.raw_ece },
    calibrated: { logLoss: c.cal_log_loss, brier: c.cal_brier, ece: c.cal_ece },
    applied: !!c.applied, knots: JSON.parse(c.knots_json),
  })).sort((a, b) => (names.get(a.market)?.ordinal ?? 99) - (names.get(b.market)?.ordinal ?? 99));
}

/* ------------------------------------------------------ learned model */

export function latestLearned(db, asOf = new Date().toISOString()) {
  return db.prepare(`SELECT * FROM learned_models WHERE model_key = ? AND trained_at <= ?
                     ORDER BY trained_at DESC, id DESC LIMIT 1`).get(LEARNED_KEY, asOf) ?? null;
}

/* Training rows: backtest inputs with the regular-time result. */
function learnedRows(db, before) {
  return db.prepare(`
    SELECT b.inputs_json, m.kickoff_utc, m.home_goals - COALESCE(m.home_et, 0) AS hg, m.away_goals - COALESCE(m.away_et, 0) AS ag
    FROM backtest_matches b JOIN matches m ON m.id = b.match_id
    WHERE b.model_key = ? AND b.model_version = ? AND b.status = 'priced' AND b.inputs_json IS NOT NULL
      AND m.status_key = 'finished' AND m.home_goals IS NOT NULL AND m.kickoff_utc < ?
    ORDER BY m.kickoff_utc`).all(MODEL_KEY, MODEL_VERSION, before)
    .map((r) => {
      const inp = JSON.parse(r.inputs_json);
      return { x: inp.values, dc: inp.dc, y: r.hg > r.ag ? 'home' : r.hg < r.ag ? 'away' : 'draw', kickoff: r.kickoff_utc };
    });
}

/**
 * Train the challenger: score a fit on the oldest 80% against Dixon–Coles
 * on the newest 20%, then refit on everything and store it as a new
 * version. Needs 600 backtest matches.
 */
export function trainChallenger(db, { now = new Date() } = {}) {
  const at = now.toISOString();
  const rows = learnedRows(db, at);
  if (rows.length < 600) return { trained: false, reason: `Only ${rows.length} backtest matches so far; training starts at 600.` };
  const cut = Math.floor(rows.length * (1 - HOLDOUT));
  const train = rows.slice(0, cut);
  const test = rows.slice(cut);
  const trial = trainLearned(train);
  const mine = scoreResults(test, (r) => predictLearned(trial, r.x));
  const base = scoreResults(test, (r) => r.dc);
  const weights = trainLearned(rows);
  const version = at.slice(0, 16).replace(/[-:T]/g, '');
  db.prepare(`INSERT INTO learned_models (model_key, version, trained_at, n_train, n_test, test_log_loss, baseline_log_loss,
                test_brier, baseline_brier, weights_json, inputs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(model_key, version) DO NOTHING`)
    .run(LEARNED_KEY, version, at, train.length, test.length, mine.logLoss, base.logLoss, mine.brier, base.brier,
      JSON.stringify(weights), JSON.stringify(INPUTS));
  db.prepare(`INSERT INTO models (key, version, name, kind, description, params_json) VALUES (?, ?, ?, 'statistical', ?, ?)
              ON CONFLICT(key, version) DO NOTHING`)
    .run(LEARNED_KEY, version, 'Learned match-result challenger',
      'Multinomial logistic regression on Dixon–Coles plus form, rest, congestion and table position; shadow only.',
      JSON.stringify({ trainedOn: rows.length }));
  return { trained: true, version, test: mine, baseline: base };
}

function challengerSummary(db) {
  const m = latestLearned(db);
  if (!m) return null;
  /* Live: the challenger against Dixon–Coles in the same analyses, for
   * matches that have finished. */
  const live = db.prepare(`
    SELECT c.match_id, c.selection, c.probability AS challenger, p.model_probability AS dc,
           m.home_goals - COALESCE(m.home_et, 0) AS hg, m.away_goals - COALESCE(m.away_et, 0) AS ag
    FROM challenger_predictions c JOIN matches m ON m.id = c.match_id
    JOIN predictions p ON p.analysis_run_id = c.analysis_run_id
    JOIN selections s ON s.id = p.selection_id AND s.key = c.selection
    JOIN markets mk ON mk.id = s.market_id AND mk.market_type_key = 'match_result'
    WHERE m.status_key = 'finished' AND m.result_confirmed_at IS NOT NULL AND p.superseded_by IS NULL`).all();
  const byMatch = new Map();
  for (const r of live) {
    if (!byMatch.has(r.match_id)) byMatch.set(r.match_id, { y: r.hg > r.ag ? 'home' : r.hg < r.ag ? 'away' : 'draw', c: {}, d: {} });
    const x = byMatch.get(r.match_id);
    x.c[r.selection] = r.challenger; x.d[r.selection] = r.dc;
  }
  const rows = [...byMatch.values()].filter((x) => Object.keys(x.c).length === 3);
  return {
    version: m.version, trainedAt: m.trained_at, nTrain: m.n_train, nTest: m.n_test,
    holdout: { challenger: { logLoss: m.test_log_loss, brier: m.test_brier }, dixonColes: { logLoss: m.baseline_log_loss, brier: m.baseline_brier } },
    live: rows.length ? { matches: rows.length, challenger: scoreResults(rows, (r) => r.c), dixonColes: scoreResults(rows, (r) => r.d) } : null,
    inputs: INPUTS, weights: JSON.parse(m.weights_json),
  };
}

/* ------------------------------------------------------- snapshots */

/** Dated headline numbers per source and market, for drift over time. */
export function snapshotPerformance(db, { now = new Date() } = {}) {
  const at = now.toISOString();
  const ins = db.prepare(`INSERT INTO model_performance (model_key, model_version, computed_at, source, segment_json, n, brier,
                            log_loss, naive_brier, ece) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let written = 0;
  transaction(db, () => {
    for (const source of ['backtest', 'live']) {
      for (const r of grouped(db, 'market', { source, model: `${MODEL_KEY} v${MODEL_VERSION}` })) {
        if (!r.n) continue;
        ins.run(MODEL_KEY, MODEL_VERSION, at, source, JSON.stringify({ market: r.key }), r.n, r.brier, r.logLoss, r.naiveBrier, r.ece);
        written += 1;
      }
    }
  });
  return written;
}

/* --------------------------------------------------------- backtest */

/* The backtest starts this long after the first result, so the model has
 * history to stand on; a 'backtest_from' setting overrides it. */
const WARM_UP_DAYS = 150;

export function backtestStart(db) {
  const set = getSetting(db, 'backtest_from');
  if (set) return set;
  const first = db.prepare("SELECT MIN(kickoff_utc) AS k FROM matches WHERE status_key = 'finished'").get().k;
  return first ? new Date(Date.parse(first) + WARM_UP_DAYS * 86400_000).toISOString() : null;
}

/** Finished matches the backtest has not priced yet (and can: details fetched). */
export function backtestRemaining(db, before = new Date(Date.now() - 86400_000).toISOString()) {
  const from = backtestStart(db);
  if (!from) return 0;
  return db.prepare(`
    SELECT COUNT(*) AS n FROM matches m JOIN seasons s ON s.id = m.season_id JOIN competitions c ON c.id = s.competition_id AND c.is_enabled = 1
    WHERE m.status_key = 'finished' AND m.result_confirmed_at IS NOT NULL AND m.details_fetched_at IS NOT NULL
      AND m.kickoff_utc >= ? AND m.kickoff_utc < ?
      AND NOT EXISTS (SELECT 1 FROM backtest_matches b WHERE b.match_id = m.id AND b.model_key = ? AND b.model_version = ?)`)
    .get(from, before, MODEL_KEY, MODEL_VERSION).n;
}

export function backtestStatus(db) {
  const done = db.prepare(`SELECT COUNT(*) AS n, SUM(status = 'priced') AS priced, MIN(m.kickoff_utc) AS first, MAX(m.kickoff_utc) AS last
                           FROM backtest_matches b JOIN matches m ON m.id = b.match_id
                           WHERE b.model_key = ? AND b.model_version = ?`).get(MODEL_KEY, MODEL_VERSION);
  const waiting = db.prepare(`SELECT COUNT(*) AS n FROM matches WHERE status_key = 'finished' AND details_fetched_at IS NULL
                              AND kickoff_utc >= ?`).get(backtestStart(db) ?? '9999').n;
  return { matches: done.n, priced: done.priced ?? 0, first: done.first, last: done.last, from: backtestStart(db),
    remaining: backtestRemaining(db), waitingForDetails: waiting };
}

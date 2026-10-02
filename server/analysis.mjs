/* Analyze Match: the pipeline from inputs to recommendations.
 *
 *   1 features   buildFeatures(match, asOf)            → feature_snapshots
 *   2 probability goals, count and scorer models         → predictions
 *     calibrate  latest fit per market (Phase 4)        → calibrated_probability
 *   3 explain    the explainer (Claude) reads the packet → ai_explanations, factors
 *   4 recommend  thresholds in force                    → recommendations
 *
 * Decisions and fair odds use the calibrated probability where a fit
 * applied; the raw model probability is kept beside it. The learned
 * challenger's match-result view is logged alongside, never used.
 *
 * Predictions are written before Claude is asked anything, so the
 * statistical view stands even when the explanation fails, and its
 * timestamp is the moment it was made. Everything written here is
 * append-only; see the triggers in schema.sql.
 */

import { ValidationError, transaction } from './db.mjs';
import { buildFeatures, BUILDER_VERSION } from './features.mjs';
import { lambdas, scoreMatrix, MODEL_KEY, MODEL_VERSION, round } from './model/goals.mjs';
import { priceGoalsMarkets, priceCountMarket, CORNER_LINES, CARD_LINES } from './model/markets.mjs';
import { priceScorers } from './model/players.mjs';
import { calibratePriced, reliabilityFactor } from './model/calibration.mjs';
import { learnedInputs, predictLearned, LEARNED_KEY } from './model/learned.mjs';
import { calibrationFor, latestLearned } from './performance.mjs';
import { selectionLabel } from '../src/markets.js';

export const BANDS = ['low', 'medium', 'high'];
export const band = (score) => (score >= 0.75 ? 'high' : score >= 0.5 ? 'medium' : 'low');

const DEFAULT_THRESHOLDS = { minConfidence: 'medium', minProbability: 0.55, minFairOdds: 1.3, maxFairOdds: 2.5, markets: [] };

/* ------------------------------------------------------------ requests */

export function requestAnalysis(db, matchId, userId, now = new Date()) {
  const match = db.prepare('SELECT id, kickoff_utc FROM matches WHERE id = ?').get(Number(matchId));
  if (!match) throw new ValidationError('That match does not exist.', 404);
  if (match.kickoff_utc <= now.toISOString()) {
    throw new ValidationError('This match has kicked off. Predictions are only made before kickoff.', 409);
  }
  const pending = db.prepare("SELECT * FROM analysis_runs WHERE match_id = ? AND status IN ('queued', 'running')").get(match.id);
  if (pending) return pending;
  const id = Number(db.prepare('INSERT INTO analysis_runs (match_id, requested_by, requested_at) VALUES (?, ?, ?)')
    .run(match.id, userId, now.toISOString()).lastInsertRowid);
  return db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(id);
}

export const nextQueuedRun = (db) =>
  db.prepare("SELECT * FROM analysis_runs WHERE status = 'queued' ORDER BY requested_at LIMIT 1").get() ?? null;

/* ---------------------------------------------------------- thresholds */

export function thresholdsFor(db, userId, at = new Date().toISOString()) {
  const row = db.prepare(`SELECT * FROM recommendation_thresholds WHERE user_id = ? AND effective_from <= ?
                          ORDER BY effective_from DESC, id DESC LIMIT 1`).get(userId ?? '', at);
  if (!row) return { ...DEFAULT_THRESHOLDS, isDefault: true };
  return { minConfidence: row.min_confidence, minProbability: row.min_probability, minFairOdds: row.min_fair_odds,
    maxFairOdds: row.max_fair_odds,
    markets: JSON.parse(row.markets_json), isDefault: false, effectiveFrom: row.effective_from };
}

/* A change adds a dated row; earlier thresholds stay readable, which is
 * how a past recommendation can be explained after the settings move. */
export function setThresholds(db, userId, t) {
  if (!BANDS.includes(t.minConfidence)) throw new ValidationError('Minimum confidence must be low, medium or high.');
  const p = Number(t.minProbability);
  if (!(p > 0 && p < 1)) throw new ValidationError('Minimum probability must be between 0 and 1.');
  const o = Number(t.maxFairOdds);
  if (!(o > 1)) throw new ValidationError('Maximum fair odds must be above 1.');
  const lo = Number(t.minFairOdds ?? DEFAULT_THRESHOLDS.minFairOdds);
  if (!(lo >= 1) || lo >= o) throw new ValidationError('Minimum fair odds must be at least 1 and below the maximum.');
  const markets = Array.isArray(t.markets) ? t.markets : [];
  const known = new Set(db.prepare('SELECT key FROM market_types').all().map((r) => r.key));
  for (const m of markets) if (!known.has(m)) throw new ValidationError(`Unknown market: ${m}`);
  db.prepare(`INSERT INTO recommendation_thresholds (user_id, min_confidence, min_probability, min_fair_odds, max_fair_odds,
              markets_json, effective_from) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, t.minConfidence, p, lo, o, JSON.stringify(markets), new Date().toISOString());
  return thresholdsFor(db, userId);
}

/** Recommend only if every threshold passes; otherwise Pass, with reasons. */
export function decide(prediction, t) {
  const reasons = [];
  if (BANDS.indexOf(prediction.confidenceBand) < BANDS.indexOf(t.minConfidence)) {
    reasons.push(`Confidence ${prediction.confidenceBand} is below ${t.minConfidence}`);
  }
  if (prediction.p < t.minProbability) {
    reasons.push(`Probability ${(prediction.p * 100).toFixed(1)}% is below ${(t.minProbability * 100).toFixed(0)}%`);
  }
  if (1 / prediction.p > t.maxFairOdds) {
    reasons.push(`Fair odds ${(1 / prediction.p).toFixed(2)} are above ${t.maxFairOdds}`);
  }
  /* A near-certainty is worth almost nothing at any price a bookmaker
   * offers, so it is not a useful recommendation however likely it is. */
  if (1 / prediction.p < (t.minFairOdds ?? 1)) {
    reasons.push(`Fair odds ${(1 / prediction.p).toFixed(2)} are below ${t.minFairOdds} — too short to be worth a bet`);
  }
  if (t.markets.length && !t.markets.includes(prediction.market)) reasons.push('Market switched off in Settings');
  return { decision: reasons.length ? 'pass' : 'recommend', reasons };
}

/* ------------------------------------------------------------- pricing */

const shrink = (value, n, prior, k = 5) => (value === null ? prior : (value * n + prior * k) / (n + k));

/** All predictions for the match from the built features. */
export function priceMatch(built) {
  const { model, freshness } = built;
  const out = [];

  /* Goals markets */
  if (model.fit.ok) {
    const l = lambdas(model.fit, model.homeId, model.awayId, model.competitionId);
    const matrix = scoreMatrix(l.home, l.away, model.fit.rho);
    const sample = Math.min(model.fit.exposure.get(model.homeId) ?? 0, model.fit.exposure.get(model.awayId) ?? 0);
    const score = 0.7 * Math.min(1, sample / 12) + 0.2 * (freshness.lineupsConfirmed ? 1 : 0)
      + 0.1 * (freshness.resultsKnown > 500 ? 1 : 0.5);
    for (const x of priceGoalsMarkets(matrix)) out.push({ ...x, confidenceScore: round(score, 3), confidenceBand: band(score) });
  }

  /* Corners: each side's rate for, against the opponent's rate conceded,
   * both shrunk toward the competition average. */
  const c = model.corners;
  if (c.competition.perTeam && c.home.matches && c.away.matches) {
    const L = c.competition.perTeam;
    const eh = shrink(c.home.for, c.home.matches, L) * shrink(c.away.against, c.away.matches, L) / L;
    const ea = shrink(c.away.for, c.away.matches, L) * shrink(c.home.against, c.home.matches, L) / L;
    const s = Math.min(1, Math.min(c.home.matches, c.away.matches) / 10) * (c.competition.matches >= 30 ? 1 : 0.6);
    const score = 0.9 * s + 0.1;
    for (const x of priceCountMarket('corners_ou', CORNER_LINES, eh + ea, c.competition.size)) {
      out.push({ ...x, confidenceScore: round(score, 3), confidenceBand: band(score), mean: round(eh + ea, 2) });
    }
  }

  /* Cards: cards each side receives, against how many the opponent
   * provokes, scaled by the referee's record when there is one. */
  const k = model.cards;
  if (k.competition.perTeam && k.home.matches && k.away.matches) {
    const L = k.competition.perTeam;
    const eh = shrink(k.home.for, k.home.matches, L) * shrink(k.away.against, k.away.matches, L) / L;
    const ea = shrink(k.away.for, k.away.matches, L) * shrink(k.home.against, k.home.matches, L) / L;
    const ref = k.referee;
    const refKnown = ref && ref.matches >= 5 && ref.average !== null;
    const refFactor = refKnown ? shrink(ref.average, ref.matches, k.competition.total) / k.competition.total : 1;
    const mu = (eh + ea) * refFactor;
    const s = Math.min(1, Math.min(k.home.matches, k.away.matches) / 10) * (k.competition.matches >= 30 ? 1 : 0.6);
    const score = 0.85 * s + 0.15 * (refKnown ? 1 : 0);
    for (const x of priceCountMarket('cards_ou', CARD_LINES, mu, k.competition.size)) {
      out.push({ ...x, confidenceScore: round(score, 3), confidenceBand: band(score), mean: round(mu, 2) });
    }
  }
  return out.map((x) => ({ ...x, p: round(x.p, 4) }));
}

/** Anytime scorers for both sides, from the goals model's expected goals. */
export function priceScorerMarkets(db, built, asOf) {
  const { model } = built;
  if (!model.fit.ok) return [];
  const l = lambdas(model.fit, model.homeId, model.awayId, model.competitionId);
  return priceScorers(db, {
    matchId: built.features.match.id, asOf, cutoff: model.cutoff,
    sides: [{ teamId: model.homeId, lambda: l.home }, { teamId: model.awayId, lambda: l.away }],
  }).map((x) => ({ ...x, p: round(x.p, 4), confidenceBand: band(x.confidenceScore) }));
}

/**
 * Calibration and calibration-informed confidence. Each row gains `pCal`
 * (null where no fit applied) and `pUse`, the probability decisions and fair
 * odds are based on; confidence is scaled by how well calibrated that market
 * has been. Returns { rows, applied } — applied: market → calibration id.
 */
export function finalisePriced(db, priced, asOf) {
  const fits = calibrationFor(db, MODEL_KEY, MODEL_VERSION, asOf);
  const rows = calibratePriced(priced, fits).map((x) => {
    const factor = reliabilityFactor(fits.get(x.market));
    const score = round(x.confidenceScore * factor, 3);
    return { ...x, pUse: x.pCal ?? x.p, confidenceScore: score, confidenceBand: band(score) };
  });
  const applied = Object.fromEntries([...fits].filter(([, f]) => f.applied).map(([m, f]) => [m, f.id]));
  return { rows, applied };
}

/* ---------------------------------------------------------------- run */

function selectionId(db, matchId, market, line, selection) {
  db.prepare('INSERT OR IGNORE INTO markets (match_id, market_type_key, line) VALUES (?, ?, ?)').run(matchId, market, line);
  const marketId = db.prepare('SELECT id FROM markets WHERE match_id = ? AND market_type_key = ? AND line IS ?')
    .get(matchId, market, line).id;
  db.prepare('INSERT OR IGNORE INTO selections (market_id, key) VALUES (?, ?)').run(marketId, selection);
  return db.prepare('SELECT id FROM selections WHERE market_id = ? AND key = ?').get(marketId, selection).id;
}

/* The selections Claude reviews: the full result and goals headline
 * markets, plus the best-supported recommendation in each other market. */
function candidatesFor(priced, decisions) {
  const always = (x) => x.market === 'match_result' || (x.market === 'over_under' && x.line === 2.5) || x.market === 'btts';
  const picked = new Map();
  priced.forEach((x, i) => {
    if (always(x)) { picked.set(`${x.market}|${x.line}|${x.selection}`, i); return; }
    if (decisions[i].decision !== 'recommend') return;
    const prev = [...picked.entries()].find(([k]) => k.startsWith(`${x.market}|`) && !always(priced[picked.get(k)]));
    if (!prev) picked.set(`${x.market}|${x.line}|${x.selection}`, i);
    else if (x.p > priced[prev[1]].p) { picked.delete(prev[0]); picked.set(`${x.market}|${x.line}|${x.selection}`, i); }
  });
  return [...picked.values()].slice(0, 16);
}

/**
 * Run one queued analysis to completion.
 * @param {{explainer?: object|null, now?: () => Date}} opts
 */
export async function runAnalysis(db, runId, { explainer = null, now = () => new Date() } = {}) {
  const run = db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId);
  if (!run || run.status !== 'queued') return null;
  const asOf = now().toISOString();
  db.prepare("UPDATE analysis_runs SET status = 'running', started_at = ?, as_of = ? WHERE id = ?").run(asOf, asOf, runId);

  const fail = (message) => {
    db.prepare("UPDATE analysis_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?")
      .run(now().toISOString(), message, runId);
    return db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId);
  };

  const match = db.prepare(`SELECT m.*, ht.name AS home_name, at.name AS away_name FROM matches m
                            JOIN teams ht ON ht.id = m.home_team_id JOIN teams at ON at.id = m.away_team_id WHERE m.id = ?`)
    .get(run.match_id);
  if (match.kickoff_utc <= asOf) return fail('The match kicked off before the analysis could run.');

  let built;
  let priced;
  let applied;
  try {
    built = buildFeatures(db, match.id, asOf);
    const raw = [...priceMatch(built), ...priceScorerMarkets(db, built, asOf)];
    ({ rows: priced, applied } = finalisePriced(db, raw, asOf));
  } catch (error) {
    return fail(`Could not build the analysis: ${error.message}`);
  }
  if (!priced.length) {
    return fail(built.model.fit.ok ? 'Not enough statistics to price any market.' : built.model.fit.reason);
  }

  const thresholds = thresholdsFor(db, run.requested_by, asOf);
  const decisions = priced.map((x) => decide({ ...x, p: x.pUse }, thresholds));
  const label = (x) => selectionLabel(x.market, x.line, x.selection, match.home_name, match.away_name, x.playerName);

  /* Freeze the inputs and the predictions in one transaction. */
  const predictionIds = transaction(db, () => {
    const snapshotId = Number(db.prepare(`INSERT INTO feature_snapshots
        (match_id, as_of, builder_version, features_json, data_freshness_json, sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(match.id, asOf, BUILDER_VERSION, built.json, JSON.stringify(built.freshness), built.sha256, asOf).lastInsertRowid);
    db.prepare(`UPDATE analysis_runs SET feature_snapshot_id = ?, prob_model_key = ?, prob_model_version = ?,
                  calibration_json = ? WHERE id = ?`)
      .run(snapshotId, MODEL_KEY, MODEL_VERSION, JSON.stringify(applied), runId);
    const insert = db.prepare(`INSERT INTO predictions (analysis_run_id, match_id, selection_id, model_probability,
        calibrated_probability, fair_odds, confidence_score, confidence_band, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const supersede = db.prepare(`UPDATE predictions SET superseded_by = ?
                                  WHERE match_id = ? AND selection_id = ? AND superseded_by IS NULL AND id <> ?`);
    return priced.map((x) => {
      const sel = selectionId(db, match.id, x.market, x.line, x.selection);
      const id = Number(insert.run(runId, match.id, sel, x.p, x.pCal, round(1 / x.pUse, 3), x.confidenceScore,
        x.confidenceBand, asOf).lastInsertRowid);
      supersede.run(id, match.id, sel, id);
      return id;
    });
  });

  /* The learned challenger's view of the result, logged in the shadow. */
  const learned = latestLearned(db, asOf);
  const inputs = learned ? learnedInputs(built, priced) : null;
  if (learned && inputs) {
    const view = predictLearned(JSON.parse(learned.weights_json), inputs.values);
    const ins = db.prepare(`INSERT INTO challenger_predictions (analysis_run_id, match_id, model_key, model_version,
                              selection, probability, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const sel of ['home', 'draw', 'away']) ins.run(runId, match.id, LEARNED_KEY, learned.version, sel, round(view[sel], 4), asOf);
  }

  /* Ask the explainer. Its failure is recorded, never fatal. */
  const candidateIdx = candidatesFor(priced, decisions);
  let explained = null;
  let aiStatus = 'skipped';
  let aiError = explainer ? null : 'No explanation engine is configured (ANTHROPIC_API_KEY is not set).';
  let usage = null;
  if (explainer) {
    try {
      const candidates = candidateIdx.map((i) => ({
        candidate_id: String(predictionIds[i]), selection: label(priced[i]), market: priced[i].market,
        probability: priced[i].pUse, fair_odds: round(1 / priced[i].pUse, 2), confidence: priced[i].confidenceBand,
        sokkerliga_decision: decisions[i].decision,
      }));
      const result = await explainer.explain({ packet: built.features, candidates });
      explained = result.explanation;
      usage = result.usage;
      aiStatus = 'explained';
      db.prepare('UPDATE analysis_runs SET ai_model = ? WHERE id = ?').run(result.servedBy ?? explainer.model, runId);
    } catch (error) {
      aiStatus = error.status === 'refused' ? 'refused' : 'failed';
      aiError = error.message;
      usage = error.usage ?? null;
    }
  }

  const views = new Map((explained?.marketViews ?? []).map((v) => [v.candidateId, v]));
  transaction(db, () => {
    const at = now().toISOString();
    const rec = db.prepare(`INSERT INTO recommendations (analysis_run_id, prediction_id, decision, pass_reasons_json,
        thresholds_json, ai_stance, reasoning_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const factor = db.prepare('INSERT INTO prediction_factors (prediction_id, direction, label, evidence, source) VALUES (?, ?, ?, ?, ?)');
    const thresholdsJson = JSON.stringify({ minConfidence: thresholds.minConfidence, minProbability: thresholds.minProbability,
      minFairOdds: thresholds.minFairOdds, maxFairOdds: thresholds.maxFairOdds, markets: thresholds.markets });
    priced.forEach((x, i) => {
      const view = views.get(String(predictionIds[i]));
      rec.run(runId, predictionIds[i], decisions[i].decision, JSON.stringify(decisions[i].reasons), thresholdsJson,
        view?.stance ?? null, null, at);
      for (const f of view?.factorsFor ?? []) factor.run(predictionIds[i], 'for', f.label, f.evidence, 'ai');
      for (const f of view?.factorsAgainst ?? []) factor.run(predictionIds[i], 'against', f.label, f.evidence, 'ai');
    });
    if (explained) {
      db.prepare(`INSERT INTO ai_explanations (analysis_run_id, summary, narrative, key_factors_json, data_gaps_json, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)`)
        .run(runId, explained.summary, explained.narrative, JSON.stringify(explained.keyFactors),
          JSON.stringify(explained.dataGaps), at);
    }
    db.prepare(`UPDATE analysis_runs SET status = 'completed', completed_at = ?, ai_status = ?, ai_error = ?,
                  prompt_key = ?, prompt_version = ?, input_tokens = ?, output_tokens = ?, cost_cents = ?,
                  ai_model = COALESCE(ai_model, ?) WHERE id = ?`)
      .run(at, aiStatus, aiError, explainer?.promptKey ?? null, explainer?.promptVersion ?? null,
        usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage ? round(usage.costCents, 3) : null,
        explainer?.model ?? null, runId);
  });
  return db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId);
}

/* --------------------------------------------------------------- reads */

const PREDICTION_SELECT = `
  SELECT p.id, p.analysis_run_id AS runId, p.match_id AS matchId,
         COALESCE(p.calibrated_probability, p.model_probability) AS probability,
         p.model_probability AS rawProbability, p.calibrated_probability AS calibratedProbability,
         p.fair_odds AS fairOdds,
         (SELECT name FROM players pl WHERE s.key LIKE 'p:%' AND pl.id = CAST(substr(s.key, 3) AS INTEGER)) AS playerName, p.confidence_score AS confidenceScore, p.confidence_band AS confidence,
         p.created_at AS createdAt, p.superseded_by AS supersededBy,
         mk.market_type_key AS market, mk.line, s.key AS selection, mt.name AS marketName, mt.family, mt.ordinal,
         r.decision, r.pass_reasons_json, r.ai_stance AS aiStance,
         (SELECT g.outcome FROM prediction_grades g WHERE g.prediction_id = p.id ORDER BY g.id DESC LIMIT 1) AS grade
  FROM predictions p
  JOIN selections s ON s.id = p.selection_id JOIN markets mk ON mk.id = s.market_id
  JOIN market_types mt ON mt.key = mk.market_type_key
  LEFT JOIN recommendations r ON r.prediction_id = p.id`;

export function analysisForMatch(db, matchId) {
  const runs = db.prepare(`SELECT * FROM analysis_runs WHERE match_id = ? ORDER BY requested_at DESC LIMIT 20`).all(Number(matchId));
  const latest = runs.find((r) => r.status === 'completed') ?? null;
  const pending = runs.find((r) => r.status === 'queued' || r.status === 'running') ?? null;
  if (!latest) return { runs, pending, latest: null };

  const match = db.prepare(`SELECT ht.name AS home, at.name AS away FROM matches m JOIN teams ht ON ht.id = m.home_team_id
                            JOIN teams at ON at.id = m.away_team_id WHERE m.id = ?`).get(Number(matchId));
  const factors = db.prepare('SELECT direction, label, evidence FROM prediction_factors WHERE prediction_id = ? ORDER BY id');
  const predictions = db.prepare(`${PREDICTION_SELECT} WHERE p.analysis_run_id = ? ORDER BY mt.ordinal, mk.line, s.key`)
    .all(latest.id).map((p) => ({
      ...p, label: selectionLabel(p.market, p.line, p.selection, match.home, match.away, p.playerName),
      passReasons: JSON.parse(p.pass_reasons_json ?? '[]'),
      factors: factors.all(p.id),
    }));
  const explanation = db.prepare('SELECT * FROM ai_explanations WHERE analysis_run_id = ?').get(latest.id);
  const snapshot = db.prepare('SELECT features_json, data_freshness_json, as_of, sha256 FROM feature_snapshots WHERE id = ?')
    .get(latest.feature_snapshot_id);
  const features = snapshot ? JSON.parse(snapshot.features_json) : null;
  const thresholds = db.prepare('SELECT thresholds_json FROM recommendations WHERE analysis_run_id = ? LIMIT 1').get(latest.id);
  const challenger = db.prepare(`SELECT model_version AS version, selection, probability FROM challenger_predictions
                                 WHERE analysis_run_id = ?`).all(latest.id);
  return {
    runs, pending,
    latest: {
      run: latest,
      predictions,
      thresholds: thresholds ? JSON.parse(thresholds.thresholds_json) : null,
      explanation: explanation ? {
        summary: explanation.summary, narrative: explanation.narrative,
        keyFactors: JSON.parse(explanation.key_factors_json), dataGaps: JSON.parse(explanation.data_gaps_json),
      } : null,
      goalsModel: features?.goalsModel ?? null,
      calibrated: Object.keys(JSON.parse(latest.calibration_json ?? '{}')),
      challenger: challenger.length ? {
        version: challenger[0].version, ...Object.fromEntries(challenger.map((c) => [c.selection, c.probability])),
      } : null,
      freshness: snapshot ? JSON.parse(snapshot.data_freshness_json) : null,
      snapshot: snapshot ? { asOf: snapshot.as_of, sha256: snapshot.sha256 } : null,
    },
  };
}

export function featureSnapshot(db, runId) {
  const row = db.prepare(`SELECT f.* FROM analysis_runs r JOIN feature_snapshots f ON f.id = r.feature_snapshot_id
                          WHERE r.id = ?`).get(Number(runId));
  return row ? { ...row, features: JSON.parse(row.features_json), freshness: JSON.parse(row.data_freshness_json) } : null;
}

/** Predictions across matches, newest first — current (not superseded) by default. */
export function listPredictions(db, { decision, market, competition, from, to, includeSuperseded, limit = 200 } = {}) {
  const where = ['1=1'];
  const args = [];
  if (!includeSuperseded) where.push('p.superseded_by IS NULL');
  if (decision) { where.push('r.decision = ?'); args.push(decision); }
  if (market) { where.push('mk.market_type_key = ?'); args.push(market); }
  if (competition) { where.push('se.competition_id = ?'); args.push(Number(competition)); }
  if (from) { where.push('m.kickoff_utc >= ?'); args.push(from); }
  if (to) { where.push('m.kickoff_utc < ?'); args.push(to); }
  const rows = db.prepare(`
    SELECT x.*, m.kickoff_utc AS kickoffUtc, m.status_key AS status, m.home_goals AS homeGoals, m.away_goals AS awayGoals,
           ht.name AS home, at.name AS away, ht.logo_url AS homeLogo, at.logo_url AS awayLogo, c.name AS competition
    FROM (${PREDICTION_SELECT}) x
    JOIN predictions p ON p.id = x.id
    JOIN selections s2 ON s2.id = p.selection_id JOIN markets mk ON mk.id = s2.market_id
    LEFT JOIN recommendations r ON r.prediction_id = p.id
    JOIN matches m ON m.id = x.matchId JOIN seasons se ON se.id = m.season_id JOIN competitions c ON c.id = se.competition_id
    JOIN teams ht ON ht.id = m.home_team_id JOIN teams at ON at.id = m.away_team_id
    WHERE ${where.join(' AND ')}
    ORDER BY m.kickoff_utc DESC, x.ordinal, x.line, x.selection LIMIT ?`).all(...args, Number(limit));
  return rows.map((p) => ({ ...p, label: selectionLabel(p.market, p.line, p.selection, p.home, p.away, p.playerName),
    passReasons: JSON.parse(p.pass_reasons_json ?? '[]') }));
}

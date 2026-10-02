import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../server/db.mjs';
import { buildFeatures, knownResults } from '../server/features.mjs';
import {
  requestAnalysis, runAnalysis, analysisForMatch, listPredictions, decide, setThresholds, thresholdsFor, priceMatch,
} from '../server/analysis.mjs';
import { createClaudeExplainer, EXPLANATION_SCHEMA, AI_MODEL } from '../server/ai/claude.mjs';
import { seedLeague, fakeExplainer } from './fixtures/league.mjs';

let db;
let league;
beforeEach(() => {
  db = openDatabase(':memory:');
  league = seedLeague(db);
});

const count = (table, where = '1=1', ...args) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;

describe('No look-ahead', () => {
  test('a match’s own result never reaches its features', () => {
    /* Analyse a past match as of two hours before its kickoff. */
    const target = db.prepare('SELECT * FROM matches WHERE id = ?').get(league.matchIds[40]);
    const asOf = new Date(Date.parse(target.kickoff_utc) - 2 * 3600_000).toISOString();
    const known = knownResults(db, asOf);
    assert.ok(known.length > 0);
    assert.ok(!known.some((r) => r.id === target.id), 'its own result is not known');
    assert.ok(known.every((r) => r.kickoffUtc < asOf), 'nothing from after asOf');
    const built = buildFeatures(db, target.id, asOf);
    assert.equal(built.features.headToHead.every((h) => h.date < asOf.slice(0, 10) || h.date === asOf.slice(0, 10)), true);
    assert.ok(built.model.fit.matches <= 40);
  });

  test('a match that kicked off less than three hours before asOf does not count yet', () => {
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(league.matchIds[10]);
    const asOf = new Date(Date.parse(m.kickoff_utc) + 2 * 3600_000).toISOString();
    assert.ok(!knownResults(db, asOf).some((r) => r.id === m.id));
    const later = new Date(Date.parse(m.kickoff_utc) + 4 * 3600_000).toISOString();
    assert.ok(knownResults(db, later).some((r) => r.id === m.id));
  });

  test('a score corrected after asOf is seen as it stood at asOf', () => {
    const id = league.matchIds[5];
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    const correctedAt = new Date(Date.parse(m.kickoff_utc) + 2 * 86400_000).toISOString();
    db.prepare('INSERT INTO match_revisions (match_id, changed_at, fields, old_json) VALUES (?, ?, ?, ?)')
      .run(id, correctedAt, 'home_goals', JSON.stringify({ home_goals: 9 }));
    const before = knownResults(db, new Date(Date.parse(correctedAt) - 3600_000).toISOString()).find((r) => r.id === id);
    const after = knownResults(db, new Date(Date.parse(correctedAt) + 3600_000).toISOString()).find((r) => r.id === id);
    assert.equal(before.homeGoals, 9, 'the original (uncorrected) score');
    assert.equal(after.homeGoals, m.home_goals, 'the corrected score');
  });

  test('injury reports and lineups count only once SokkerLiga had them', () => {
    const p = Number(db.prepare("INSERT INTO players (name, source_key, source_ref, fetched_at) VALUES ('Star', 'api-football', 'p1', ?)")
      .run(new Date().toISOString()).lastInsertRowid);
    const reported = new Date(Date.now() + 3600_000).toISOString();
    db.prepare(`INSERT INTO availability (player_id, team_id, match_id, status, reason, first_reported_at, last_reported_at, source_key)
                VALUES (?, ?, ?, 'missing', 'Knee', ?, ?, 'api-football')`).run(p, league.teamIds[0], league.upcomingId, reported, reported);
    assert.equal(buildFeatures(db, league.upcomingId, new Date().toISOString()).features.home.absences.length, 0);
    assert.equal(buildFeatures(db, league.upcomingId, new Date(Date.now() + 2 * 3600_000).toISOString()).features.home.absences.length, 1);
  });
});

describe('Pricing a match', () => {
  test('the favourite is priced as the favourite, with every market family present', () => {
    const priced = priceMatch(buildFeatures(db, league.upcomingId, new Date().toISOString()));
    const p = (market, selection, line = null) => priced.find((x) => x.market === market && x.selection === selection && (x.line ?? null) === line);
    assert.ok(p('match_result', 'home').p > p('match_result', 'away').p, 'strongest at home to the weakest');
    assert.ok(priced.some((x) => x.market === 'corners_ou'));
    assert.ok(priced.some((x) => x.market === 'cards_ou'));
    assert.ok(priced.every((x) => ['low', 'medium', 'high'].includes(x.confidenceBand)));
  });
});

describe('Thresholds', () => {
  const pred = { p: 0.62, confidenceBand: 'medium', market: 'over_under' };
  test('recommend only when every threshold passes, with reasons otherwise', () => {
    const t = { minConfidence: 'medium', minProbability: 0.55, maxFairOdds: 2.5, markets: [] };
    assert.equal(decide(pred, t).decision, 'recommend');
    const strict = decide(pred, { ...t, minConfidence: 'high', minProbability: 0.7 });
    assert.equal(strict.decision, 'pass');
    assert.equal(strict.reasons.length, 2);
    assert.equal(decide(pred, { ...t, markets: ['btts'] }).decision, 'pass');
  });

  test('a near-certainty is a Pass: its fair odds are below the minimum', () => {
    const t = { minConfidence: 'low', minProbability: 0.55, minFairOdds: 1.3, maxFairOdds: 2.5, markets: [] };
    const d = decide({ p: 0.95, confidenceBand: 'high', market: 'over_under' }, t);
    assert.equal(d.decision, 'pass');
    assert.match(d.reasons[0], /too short/);
    assert.equal(decide({ p: 0.7, confidenceBand: 'high', market: 'over_under' }, t).decision, 'recommend');
  });

  test('a change adds a dated row; the old thresholds stay readable', () => {
    assert.equal(thresholdsFor(db, 'u1').isDefault, true);
    setThresholds(db, 'u1', { minConfidence: 'high', minProbability: 0.6, maxFairOdds: 2, markets: [] });
    assert.equal(thresholdsFor(db, 'u1').minConfidence, 'high');
    assert.equal(thresholdsFor(db, 'u1', '2000-01-01T00:00:00Z').isDefault, true);
    assert.throws(() => setThresholds(db, 'u1', { minConfidence: 'huge', minProbability: 0.6, maxFairOdds: 2 }), /low, medium or high/);
  });
});

describe('Running an analysis', () => {
  test('stores the snapshot, the predictions, Claude’s view and the recommendations', async () => {
    const explainer = fakeExplainer();
    const run = requestAnalysis(db, league.upcomingId, 'u1');
    const done = await runAnalysis(db, run.id, { explainer });
    assert.equal(done.status, 'completed');
    assert.equal(done.ai_status, 'explained');
    assert.equal(done.prob_model_key, 'dixon-coles');
    assert.equal(done.prompt_version, '1');
    assert.equal(done.input_tokens, 5000);
    assert.equal(count('feature_snapshots'), 1);
    const n = count('predictions', 'analysis_run_id = ?', run.id);
    assert.ok(n > 60);
    assert.equal(count('recommendations', 'analysis_run_id = ?', run.id), n);
    assert.ok(count('prediction_factors') >= 3);
    assert.equal(explainer.calls.length, 1);
    assert.ok(explainer.calls[0].candidates.some((c) => c.market === 'match_result'));
    const view = analysisForMatch(db, league.upcomingId);
    assert.equal(view.latest.explanation.dataGaps[0], 'No xG for this competition');
    assert.ok(view.latest.predictions.some((p) => p.aiStance === 'support'));
    assert.ok(view.latest.predictions.find((p) => p.market === 'match_result' && p.selection === 'home').label.endsWith('to win'));
  });

  test('without an explainer the statistical predictions still stand', async () => {
    const run = requestAnalysis(db, league.upcomingId, 'u1');
    const done = await runAnalysis(db, run.id, { explainer: null });
    assert.equal(done.status, 'completed');
    assert.equal(done.ai_status, 'skipped');
    assert.match(done.ai_error, /ANTHROPIC_API_KEY/);
    assert.ok(count('predictions') > 0);
    assert.equal(count('ai_explanations'), 0);
  });

  test('a refused or failed explanation is recorded, not fatal', async () => {
    const run = requestAnalysis(db, league.upcomingId, 'u1');
    const done = await runAnalysis(db, run.id, { explainer: fakeExplainer({ fail: { message: 'declined', status: 'refused' } }) });
    assert.equal(done.status, 'completed');
    assert.equal(done.ai_status, 'refused');
    assert.ok(count('predictions') > 0);
  });

  test('re-analysing supersedes the earlier predictions without changing them', async () => {
    const first = requestAnalysis(db, league.upcomingId, 'u1');
    await runAnalysis(db, first.id, { explainer: null });
    const before = db.prepare('SELECT model_probability FROM predictions WHERE analysis_run_id = ? ORDER BY id LIMIT 1').get(first.id);
    const second = requestAnalysis(db, league.upcomingId, 'u1');
    await runAnalysis(db, second.id, { explainer: null });
    assert.equal(count('predictions', 'analysis_run_id = ? AND superseded_by IS NULL', first.id), 0);
    assert.equal(count('predictions', 'analysis_run_id = ? AND superseded_by IS NULL', second.id),
      count('predictions', 'analysis_run_id = ?', second.id));
    const after = db.prepare('SELECT model_probability FROM predictions WHERE analysis_run_id = ? ORDER BY id LIMIT 1').get(first.id);
    assert.equal(after.model_probability, before.model_probability);
    assert.equal(listPredictions(db).length, count('predictions', 'analysis_run_id = ?', second.id));
  });

  test('a second request while one is queued returns the queued one', () => {
    const a = requestAnalysis(db, league.upcomingId, 'u1');
    const b = requestAnalysis(db, league.upcomingId, 'u1');
    assert.equal(a.id, b.id);
  });

  test('no analysis for a match that has kicked off', () => {
    assert.throws(() => requestAnalysis(db, league.matchIds[0], 'u1'), /kicked off/);
  });
});

describe('Predictions are evidence', () => {
  test('cannot be changed, deleted, or made after kickoff', async () => {
    const run = requestAnalysis(db, league.upcomingId, 'u1');
    await runAnalysis(db, run.id, { explainer: null });
    const id = db.prepare('SELECT id FROM predictions LIMIT 1').get().id;
    assert.throws(() => db.prepare('UPDATE predictions SET model_probability = 0.99 WHERE id = ?').run(id), /cannot be changed/);
    assert.throws(() => db.prepare('DELETE FROM predictions WHERE id = ?').run(id), /cannot be deleted/);
    assert.throws(() => db.prepare('UPDATE recommendations SET decision = ? WHERE prediction_id = ?').run('recommend', id), /cannot be changed/);
    assert.throws(() => db.prepare("UPDATE feature_snapshots SET features_json = '{}'").run(), /cannot be changed/);
    assert.throws(() => db.prepare("UPDATE analysis_runs SET status = 'queued' WHERE id = ?").run(run.id), /cannot be changed/);
    const sel = db.prepare('SELECT selection_id FROM predictions WHERE id = ?').get(id).selection_id;
    assert.throws(() => db.prepare(`INSERT INTO predictions (analysis_run_id, match_id, selection_id, model_probability, fair_odds,
        confidence_score, confidence_band, created_at) VALUES (?, ?, ?, 0.5, 2, 0.5, 'medium', ?)`)
      .run(run.id, league.matchIds[0], sel, new Date().toISOString()), /after kickoff/);
  });
});

describe('The Claude adapter', () => {
  const fakeClient = (response) => {
    const sent = [];
    return { sent, beta: { messages: { create: async (req) => { sent.push(req); return response; } } } };
  };
  const ok = (body) => ({ model: AI_MODEL, stop_reason: 'end_turn', usage: { input_tokens: 4000, output_tokens: 900 },
    content: [{ type: 'text', text: JSON.stringify(body) }] });

  test('asks Claude Opus 5.5 for structured JSON, with fallbacks on and effort set', async () => {
    const client = fakeClient(ok({ summary: 's', narrative: 'n', key_factors: [], market_views: [], data_gaps: [] }));
    const result = await createClaudeExplainer({ client }).explain({ packet: { a: 1 }, candidates: [] });
    const req = client.sent[0];
    assert.equal(req.model, 'claude-opus-5-5');
    assert.equal(req.fallbacks, 'default');
    assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(req.output_config.effort, 'medium');
    assert.equal(req.output_config.format.type, 'json_schema');
    assert.deepEqual(req.output_config.format.schema, EXPLANATION_SCHEMA);
    assert.equal(req.thinking, undefined, 'thinking left to the model default');
    assert.equal(result.explanation.summary, 's');
    assert.ok(result.usage.costCents > 0);
  });

  test('a refusal is reported with its category, not parsed', async () => {
    const client = fakeClient({ stop_reason: 'refusal', stop_details: { category: 'bio' }, content: [], usage: {} });
    await assert.rejects(() => createClaudeExplainer({ client }).explain({ packet: {}, candidates: [] }),
      (e) => e.status === 'refused' && /bio/.test(e.message));
  });
});

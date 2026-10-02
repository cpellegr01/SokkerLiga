/* The backtest: the model re-run for past matches, as it would have seen them.
 *
 * For each past match day, asOf is an hour before that day's first kickoff;
 * every match that day is priced through the same buildFeatures() and
 * priceMatch() the live Analyze button uses, so the backtest sees exactly
 * what was knowable then — no results from that day or later, no
 * corrections made afterwards, no injury reports or lineups SokkerLiga did
 * not have yet. Each selection is graded at once from the confirmed result.
 *
 * Raw model probabilities only: calibration is judged separately, on the
 * newest fifth held out of each fit (performance.mjs). A match waits until
 * its details (corners, cards, scorers) have been fetched, so every market
 * can be graded.
 *
 * Paced: a run works for a set number of seconds and yields between match
 * days, so it shares the one-CPU server politely; the job comes back every
 * ten minutes until the history is done.
 */

import { transaction, getSetting } from './db.mjs';
import { backtestStart, backtestRemaining } from './performance.mjs';
import { buildFeatures } from './features.mjs';
import { priceMatch } from './analysis.mjs';
import { grade, matchFacts } from './grading.mjs';
import { learnedInputs } from './model/learned.mjs';
import { MODEL_KEY, MODEL_VERSION } from './model/goals.mjs';

const DAY = 86400_000;

function pendingMatches(db, from, before, limit) {
  return db.prepare(`
    SELECT m.id, m.kickoff_utc FROM matches m
    JOIN seasons s ON s.id = m.season_id JOIN competitions c ON c.id = s.competition_id AND c.is_enabled = 1
    WHERE m.status_key = 'finished' AND m.result_confirmed_at IS NOT NULL AND m.details_fetched_at IS NOT NULL
      AND m.kickoff_utc >= ? AND m.kickoff_utc < ?
      AND NOT EXISTS (SELECT 1 FROM backtest_matches b WHERE b.match_id = m.id AND b.model_key = ? AND b.model_version = ?)
    ORDER BY m.kickoff_utc LIMIT ?`).all(from, before, MODEL_KEY, MODEL_VERSION, limit);
}

/**
 * Price past match days until the time budget is spent.
 * @returns {{ days, matches, selections, remaining }}
 */
export async function runBacktest(db, { seconds = Number(getSetting(db, 'backtest_seconds_per_run')) || 45, now = new Date() } = {}) {
  const from = backtestStart(db);
  if (!from) return { days: 0, matches: 0, selections: 0, remaining: 0 };
  const before = new Date(now.getTime() - DAY).toISOString();
  const deadline = Date.now() + seconds * 1000;
  const insMatch = db.prepare(`INSERT OR IGNORE INTO backtest_matches (match_id, model_key, model_version, as_of, status, reason,
                                 inputs_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const insPred = db.prepare(`INSERT INTO backtest_predictions (match_id, model_key, model_version, market, line, selection,
                                probability, confidence_band, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let days = 0; let matches = 0; let selections = 0;

  while (Date.now() < deadline) {
    const batch = pendingMatches(db, from, before, 300);
    if (!batch.length) break;
    const day = batch[0].kickoff_utc.slice(0, 10);
    const todays = batch.filter((m) => m.kickoff_utc.slice(0, 10) === day);
    const asOf = new Date(Date.parse(todays[0].kickoff_utc) - 3600_000).toISOString();
    const cache = new Map();
    const at = new Date().toISOString();
    const results = todays.map((m) => {
      try {
        const built = buildFeatures(db, m.id, asOf, { cache });
        const priced = priceMatch(built);
        if (!priced.length) return { m, reason: built.model.fit.ok ? 'Not enough statistics' : built.model.fit.reason };
        const facts = matchFacts(db, m.id);
        return {
          m, priced: priced.map((x) => ({ ...x, outcome: grade(x.market, x.line, x.selection, facts) })),
          inputs: learnedInputs(built, priced),
        };
      } catch (error) {
        return { m, reason: error.message };
      }
    });
    transaction(db, () => {
      for (const r of results) {
        const ok = !!r.priced;
        const fresh = insMatch.run(r.m.id, MODEL_KEY, MODEL_VERSION, asOf, ok ? 'priced' : 'skipped', r.reason ?? null,
          r.inputs ? JSON.stringify(r.inputs) : null, at).changes;
        if (!fresh || !ok) continue;
        for (const x of r.priced) {
          const o = x.outcome && x.outcome !== 'pending' ? x.outcome : null;
          insPred.run(r.m.id, MODEL_KEY, MODEL_VERSION, x.market, x.line, x.selection, x.p, x.confidenceBand, o);
          selections += 1;
        }
        matches += 1;
      }
    });
    days += 1;
    /* Let the analysis loop (and anything else) run between days. */
    await new Promise((resolve) => setImmediate(resolve));
  }
  const remaining = backtestRemaining(db, before);
  return { days, matches, selections, remaining };
}

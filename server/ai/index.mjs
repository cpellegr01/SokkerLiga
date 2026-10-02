/* The explanation service.
 *
 * One interface, swappable engines: an adapter takes the match packet and
 * the model's predictions and returns factors, a narrative and data gaps.
 * It never returns probabilities. `none` is used when no engine is
 * configured — the statistical predictions stand on their own.
 */

import { createClaudeExplainer } from './claude.mjs';

/** @typedef {{ summary: string, narrative: string, keyFactors: Array, marketViews: Array, dataGaps: string[] }} Explanation */

export function defaultExplainer(db) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return createClaudeExplainer({ db });
}

/* Claude adapter for the explanation service.
 *
 * One Messages API call per analysis with a structured-output schema, so
 * the reply is JSON in a fixed shape. Claude Opus 5.5 at explicit `medium`
 * effort (its default, set explicitly so a future default change does not
 * silently alter cost). Server-side fallbacks are on: if a safety
 * classifier declines, the API retries on Anthropic's recommended model
 * inside the same call. A refusal that survives the fallback is reported,
 * not parsed.
 *
 * The prompt is versioned data in the prompts table; the run records which
 * version produced it.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const AI_MODEL = 'claude-opus-5-5';
export const PROMPT_KEY = 'match-analysis';
export const PROMPT_VERSION = '1';
const EFFORT = 'medium';
/* $ per million tokens for Claude Opus 5.5, for the run's cost record. */
const PRICE_IN = 4;
const PRICE_OUT = 20;

const factor = {
  type: 'object',
  properties: { label: { type: 'string' }, evidence: { type: 'string' } },
  required: ['label', 'evidence'],
  additionalProperties: false,
};

export const EXPLANATION_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    narrative: { type: 'string' },
    key_factors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          favours: { type: 'string', enum: ['home', 'away', 'more_goals', 'fewer_goals', 'neutral'] },
          evidence: { type: 'string' },
        },
        required: ['label', 'favours', 'evidence'],
        additionalProperties: false,
      },
    },
    market_views: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidate_id: { type: 'string' },
          stance: { type: 'string', enum: ['support', 'caution', 'oppose'] },
          factors_for: { type: 'array', items: factor },
          factors_against: { type: 'array', items: factor },
        },
        required: ['candidate_id', 'stance', 'factors_for', 'factors_against'],
        additionalProperties: false,
      },
    },
    data_gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'narrative', 'key_factors', 'market_views', 'data_gaps'],
  additionalProperties: false,
};

export function promptText() {
  return readFileSync(join(HERE, '..', 'prompts', `${PROMPT_KEY}.v${PROMPT_VERSION}.md`), 'utf8');
}

export function promptRecord() {
  const body = promptText();
  return { key: PROMPT_KEY, version: PROMPT_VERSION, body, sha256: createHash('sha256').update(body).digest('hex') };
}

export function createClaudeExplainer({ client = new Anthropic() } = {}) {
  return {
    model: AI_MODEL,
    promptKey: PROMPT_KEY,
    promptVersion: PROMPT_VERSION,

    async explain({ packet, candidates }) {
      const request = {
        model: AI_MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: promptText(),
        output_config: { effort: EFFORT, format: { type: 'json_schema', schema: EXPLANATION_SCHEMA } },
        messages: [{
          role: 'user',
          content: `Match packet:\n${JSON.stringify(packet)}\n\nCandidate selections to review (the model's probabilities and fair odds):\n${JSON.stringify(candidates)}`,
        }],
      };

      let response;
      try {
        response = await client.beta.messages.create(request);
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) throw new ExplainError('The Anthropic API key was refused.', 'failed');
        if (error instanceof Anthropic.RateLimitError) throw new ExplainError('Claude is rate-limited right now; try again shortly.', 'failed');
        if (error instanceof Anthropic.APIError) throw new ExplainError(`Claude API error ${error.status}: ${error.message}`, 'failed');
        throw new ExplainError(`Could not reach Claude: ${error.message}`, 'failed');
      }

      const usage = {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
      usage.costCents = ((usage.inputTokens * PRICE_IN + usage.outputTokens * PRICE_OUT) / 1e6) * 100;
      const servedBy = response.model ?? AI_MODEL;

      if (response.stop_reason === 'refusal') {
        const category = response.stop_details?.category ?? 'unspecified';
        throw new ExplainError(`Claude declined to analyse this match (category: ${category}).`, 'refused', usage);
      }
      if (response.stop_reason === 'max_tokens') {
        throw new ExplainError('Claude ran out of room before finishing the analysis.', 'failed', usage);
      }
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ExplainError('Claude returned an answer that is not valid JSON.', 'failed', usage);
      }
      return { explanation: normalise(parsed), usage, servedBy };
    },
  };
}

export class ExplainError extends Error {
  constructor(message, status, usage = null) {
    super(message);
    this.status = status;
    this.usage = usage;
  }
}

function normalise(p) {
  return {
    summary: p.summary,
    narrative: p.narrative,
    keyFactors: p.key_factors ?? [],
    marketViews: (p.market_views ?? []).map((v) => ({
      candidateId: v.candidate_id, stance: v.stance, factorsFor: v.factors_for ?? [], factorsAgainst: v.factors_against ?? [],
    })),
    dataGaps: p.data_gaps ?? [],
  };
}

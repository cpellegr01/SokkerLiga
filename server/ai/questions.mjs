/* Questions over SokkerLiga's own history — the Claude half.
 *
 * Claude reads the question and returns a filter in a fixed JSON shape
 * (structured output). It never sees the data and never produces numbers:
 * server/ask.mjs runs the filter against the database and computes the
 * answer. So an answer is always SokkerLiga's own arithmetic, and the
 * filter is shown back to the person so they can see what was measured.
 *
 * Effort is low: this is a small mapping task, not analysis.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_MODEL, ExplainError } from './claude.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const QUESTION_PROMPT_KEY = 'question-filter';
export const QUESTION_PROMPT_VERSION = '1';

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

export const FILTER_SCHEMA = {
  type: 'object',
  properties: {
    understood: { type: 'boolean' },
    clarification: { type: 'string' },
    restatement: { type: 'string' },
    subject: { type: 'string', enum: ['predictions', 'recommendations', 'bets'] },
    source: { type: 'string', enum: ['all', 'live', 'backtest'] },
    competitions: { type: 'array', items: { type: 'string' } },
    markets: { type: 'array', items: { type: 'string' } },
    line: nullable('number'),
    selection: nullable('string'),
    confidence: { type: 'array', items: { type: 'string', enum: ['low', 'medium', 'high'] } },
    team: nullable('string'),
    favourite: { type: 'string', enum: ['home', 'away', 'none'] },
    from: nullable('string'),
    to: nullable('string'),
    group_by: { type: 'string', enum: ['none', 'market', 'competition', 'confidence', 'team', 'month', 'source'] },
  },
  required: ['understood', 'clarification', 'restatement', 'subject', 'source', 'competitions', 'markets', 'line',
    'selection', 'confidence', 'team', 'favourite', 'from', 'to', 'group_by'],
  additionalProperties: false,
};

export function questionPromptText() {
  return readFileSync(join(HERE, '..', 'prompts', `${QUESTION_PROMPT_KEY}.v${QUESTION_PROMPT_VERSION}.md`), 'utf8');
}

export function questionPromptRecord() {
  const body = questionPromptText();
  return { key: QUESTION_PROMPT_KEY, version: QUESTION_PROMPT_VERSION, body, sha256: createHash('sha256').update(body).digest('hex') };
}

export function createQuestionParser({ client = new Anthropic() } = {}) {
  return {
    model: AI_MODEL,
    async parse(question, context) {
      let response;
      try {
        response = await client.beta.messages.create({
          model: AI_MODEL,
          max_tokens: 2000,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: questionPromptText(),
          output_config: { effort: 'low', format: { type: 'json_schema', schema: FILTER_SCHEMA } },
          messages: [{ role: 'user', content: `Context:\n${JSON.stringify(context)}\n\nQuestion: ${question}` }],
        });
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) throw new ExplainError('The Anthropic API key was refused.', 'failed');
        if (error instanceof Anthropic.RateLimitError) throw new ExplainError('Claude is rate-limited right now; try again shortly.', 'failed');
        if (error instanceof Anthropic.APIError) throw new ExplainError(`Claude API error ${error.status}: ${error.message}`, 'failed');
        throw new ExplainError(`Could not reach Claude: ${error.message}`, 'failed');
      }
      if (response.stop_reason === 'refusal') throw new ExplainError('Claude declined to read this question.', 'refused');
      if (response.stop_reason === 'max_tokens') throw new ExplainError('Claude ran out of room reading the question.', 'failed');
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      try {
        return JSON.parse(text);
      } catch {
        throw new ExplainError('Claude returned a filter that is not valid JSON.', 'failed');
      }
    },
  };
}

export function defaultQuestionParser() {
  return process.env.ANTHROPIC_API_KEY ? createQuestionParser() : null;
}

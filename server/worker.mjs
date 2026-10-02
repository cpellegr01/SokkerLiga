/* SokkerLiga worker — the second process.
 *
 * Runs the data-refresh jobs on their schedules, plus any job someone asked
 * for with "Run now" in Settings. The API server never calls a provider
 * itself; it only flags requests here through the jobs table, so a slow
 * provider can never hold up a page.
 *
 * One job at a time, in the order of the jobs table. Jobs that fail are
 * logged in job_runs and retried within 15 minutes; on start, any job whose
 * last run failed runs again at once.
 */

import { openDatabase } from './db.mjs';
import { runJob, dueJobs, retryFailedNow } from './jobs.mjs';
import { nextQueuedRun, runAnalysis } from './analysis.mjs';
import { defaultExplainer } from './ai/index.mjs';

const TICK_MS = 15_000;
const ANALYSIS_TICK_MS = 2_000;

const db = openDatabase(process.env.SOKKERLIGA_DB ?? undefined);

/* A lock left behind by a worker that was killed mid-job would block that
 * job for up to an hour; on start nothing is running, so clear them. */
db.prepare('UPDATE jobs SET locked_until = NULL').run();
retryFailedNow(db);

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true;
    console.log(`Worker: ${signal} received, stopping after the current job.`);
  });
}

console.log(`SokkerLiga worker started. API-Football key ${process.env.API_FOOTBALL_KEY ? 'present' : 'MISSING'}; `
  + `Anthropic key ${process.env.ANTHROPIC_API_KEY ? 'present' : 'missing (analyses run without explanations)'}.`);

/* A run left 'running' by a worker that was stopped mid-analysis never
 * finishes; mark it failed so the button works again. */
db.prepare(`UPDATE analysis_runs SET status = 'failed', completed_at = ?, error = 'The worker restarted during this analysis.'
            WHERE status = 'running'`).run(new Date().toISOString());

/* Analyses run in their own loop, so one requested during a long data sync
 * does not wait for it. Node runs one piece at a time; each database write
 * here and in the jobs is a synchronous transaction, so they never
 * interleave mid-write. */
const explainer = defaultExplainer(db);
(async function analysisLoop() {
  while (!stopping) {
    const run = nextQueuedRun(db);
    if (run) {
      try {
        const done = await runAnalysis(db, run.id, { explainer });
        console.log(`Worker: analysis ${run.id} (match ${run.match_id}) ${done?.status}`
          + `${done?.ai_status ? `, explanation ${done.ai_status}` : ''}${done?.error ? ` — ${done.error}` : ''}`);
      } catch (error) {
        console.error(`Worker: analysis ${run.id} crashed:`, error);
      }
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, ANALYSIS_TICK_MS));
  }
})();

while (!stopping) {
  for (const key of dueJobs(db)) {
    if (stopping) break;
    const run = await runJob(db, key);
    if (run) {
      console.log(`Worker: ${key} ${run.status} — ${run.records_in} in, ${run.records_written} written, `
        + `${run.requests_used} requests${run.message ? ` — ${run.message}` : ''}`);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, TICK_MS));
}

db.close();
process.exit(0);

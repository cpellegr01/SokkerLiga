/* SokkerLiga worker — the second process.
 *
 * Runs the data-refresh jobs on their schedules, plus any job someone asked
 * for with "Run now" in Settings. The API server never calls a provider
 * itself; it only flags requests here through the jobs table, so a slow
 * provider can never hold up a page.
 *
 * One job at a time, in the order of the jobs table. Jobs that fail are
 * logged in job_runs and retried at their next interval.
 */

import { openDatabase } from './db.mjs';
import { runJob, dueJobs } from './jobs.mjs';

const TICK_MS = 15_000;

const db = openDatabase(process.env.SOKKERLIGA_DB ?? undefined);

/* A lock left behind by a worker that was killed mid-job would block that
 * job for up to an hour; on start nothing is running, so clear them. */
db.prepare('UPDATE jobs SET locked_until = NULL').run();

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopping = true;
    console.log(`Worker: ${signal} received, stopping after the current job.`);
  });
}

console.log(`SokkerLiga worker started. API-Football key ${process.env.API_FOOTBALL_KEY ? 'present' : 'MISSING'}.`);

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

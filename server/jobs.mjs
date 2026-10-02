/* Data-refresh jobs and the runner that schedules them.
 *
 * Each job is an async function (ctx) → void that reports through ctx.
 * Jobs are idempotent: they ask the provider for current facts and the
 * import layer (ingest.mjs) writes only what changed. One failing item is
 * logged and skipped; it never stops the rest of the job.
 *
 * Scheduling is data: the jobs table holds each job's interval, next run and
 * lock, so Settings can show it and "Run now" is a column update.
 */

import { transaction, getSetting } from './db.mjs';
import {
  createClient, normaliseLeague, normaliseTeam, normaliseFixture, normaliseStandings,
  normaliseSquad, normalisePlayerProfile, normaliseInjury, SOURCE_KEY,
} from './providers/api-football.mjs';
import {
  importLeague, importTeams, importFixture, importFixtureDetails, importStandings,
  importSquad, importPlayerProfile, importInjuries, idFor,
} from './ingest.mjs';

const LOCK_MINUTES = 60;
const RETRY_FAILED_MINUTES = 15;
/* Refused by the plan, the key or the quota: those don't change by
 * themselves within minutes. A worker restart retries at once. */
const RETRY_BLOCKED_MINUTES = 360;

/* ------------------------------------------------------------- helpers */

const enabledCompetitions = (db) =>
  db.prepare('SELECT * FROM competitions WHERE is_enabled = 1 AND api_football_id IS NOT NULL ORDER BY ordinal').all();

const currentSeason = (db, competitionId) =>
  db.prepare('SELECT * FROM seasons WHERE competition_id = ? AND is_current = 1').get(competitionId);

/* Run one unit of work; record its error and carry on. */
async function step(ctx, label, fn) {
  try {
    return await fn();
  } catch (error) {
    ctx.errors.push(`${label}: ${error.message}`);
    /* The key, the plan or the quota rules out every other item too: stop
     * now instead of spending a request per competition to hear it again. */
    if (error.fatal || /No API-Football key/.test(error.message)) {
      ctx.fatal = true;
      throw error;
    }
    return null;
  }
}

/* Fetch details for matches in batches of up to 20 per request. */
async function fetchDetails(ctx, matchRows) {
  const { db, provider } = ctx;
  const size = Math.min(20, Number(getSetting(db, 'details_batch_size')) || 20);
  for (let i = 0; i < matchRows.length; i += size) {
    const batch = matchRows.slice(i, i + size);
    await step(ctx, `details for ${batch.length} matches`, async () => {
      const { items, fetchedAt } = await provider.fixturesByIds(batch.map((m) => m.source_ref));
      ctx.recordsIn += items.length;
      transaction(db, () => {
        for (const item of items) {
          const f = normaliseFixture(item);
          const seasonId = db.prepare('SELECT season_id FROM matches WHERE source_key = ? AND source_ref = ?')
            .get(SOURCE_KEY, f.sourceRef)?.season_id;
          if (!seasonId) continue;
          const result = importFixture(db, SOURCE_KEY, seasonId, f, fetchedAt);
          if (result?.changed) ctx.recordsWritten += 1;
          if (result && f.details) ctx.recordsWritten += importFixtureDetails(db, SOURCE_KEY, result.id, f.details, fetchedAt);
        }
      });
    });
  }
}

/* ---------------------------------------------------------------- jobs */

export const JOBS = {
  async sync_competitions(ctx) {
    const { db, provider } = ctx;
    for (const c of enabledCompetitions(db)) {
      await step(ctx, c.name, async () => {
        const { items, fetchedAt } = await provider.leagues(c.api_football_id);
        ctx.recordsIn += items.length;
        if (!items.length) throw new Error('the provider returned no competition');
        transaction(db, () => { ctx.recordsWritten += importLeague(db, c.id, normaliseLeague(items[0]), fetchedAt); });
      });
    }
  },

  async sync_teams(ctx) {
    const { db, provider } = ctx;
    for (const c of enabledCompetitions(db)) {
      const season = currentSeason(db, c.id);
      if (!season) { ctx.errors.push(`${c.name}: no current season yet — run "Competitions and seasons" first`); continue; }
      await step(ctx, c.name, async () => {
        const { items, fetchedAt } = await provider.teams(c.api_football_id, season.year);
        ctx.recordsIn += items.length;
        transaction(db, () => {
          ctx.recordsWritten += importTeams(db, SOURCE_KEY, season.id, items.map(normaliseTeam), fetchedAt);
        });
      });
    }
  },

  async sync_fixtures(ctx) {
    const { db, provider } = ctx;
    for (const c of enabledCompetitions(db)) {
      const season = currentSeason(db, c.id);
      if (!season) { ctx.errors.push(`${c.name}: no current season yet`); continue; }
      await step(ctx, c.name, () => importSeasonFixtures(ctx, c, season, provider));
    }
  },

  /* Matches that are live, finished but not yet confirmed, or about to
   * start (for lineups), then a slice of the backlog of finished matches
   * whose details have never been fetched (history included). */
  async sync_results(ctx) {
    const { db } = ctx;
    const now = Date.now();
    const iso = (offsetMinutes) => new Date(now + offsetMinutes * 60_000).toISOString();
    const enabled = `season_id IN (SELECT s.id FROM seasons s JOIN competitions c ON c.id = s.competition_id
                                   WHERE c.is_enabled = 1)`;
    const urgent = db.prepare(`
      SELECT id, source_ref FROM matches
      WHERE source_key = ? AND ${enabled} AND (
        status_key = 'live'
        OR (kickoff_utc BETWEEN ? AND ? AND result_confirmed_at IS NULL AND status_key NOT IN ('postponed', 'cancelled'))
        OR (kickoff_utc BETWEEN ? AND ? AND status_key = 'scheduled')
      )
      ORDER BY kickoff_utc`).all(SOURCE_KEY, iso(-8 * 60), iso(0), iso(0), iso(75));
    /* 20 batches of 20 a run: a few hundred requests an hour while history
     * fills in, then nothing once the backlog is empty. */
    const backlogBatches = 20;
    const backlog = db.prepare(`
      SELECT id, source_ref FROM matches
      WHERE source_key = ? AND ${enabled} AND details_fetched_at IS NULL
        AND status_key IN ('finished', 'awarded') AND kickoff_utc < ?
      ORDER BY kickoff_utc DESC LIMIT ?`).all(SOURCE_KEY, iso(-8 * 60), backlogBatches * 20);
    const seen = new Set(urgent.map((m) => m.id));
    const rows = [...urgent, ...backlog.filter((m) => !seen.has(m.id))];
    if (!rows.length) { ctx.message = 'Nothing live, finishing or starting soon.'; return; }
    await fetchDetails(ctx, rows);
    ctx.message = `${urgent.length} current and ${rows.length - urgent.length} past matches checked.`;
  },

  async sync_standings(ctx) {
    const { db, provider } = ctx;
    for (const c of enabledCompetitions(db)) {
      const season = currentSeason(db, c.id);
      if (!season) continue;
      await step(ctx, c.name, () => importSeasonStandings(ctx, c, season, provider));
    }
  },

  async sync_squads(ctx) {
    const { db, provider } = ctx;
    const teams = db.prepare(`
      SELECT DISTINCT t.id, t.source_ref, t.name FROM teams t
      JOIN season_teams st ON st.team_id = t.id
      JOIN seasons s ON s.id = st.season_id AND s.is_current = 1
      JOIN competitions c ON c.id = s.competition_id AND c.is_enabled = 1
      WHERE t.source_key = ? ORDER BY t.name`).all(SOURCE_KEY);
    for (const t of teams) {
      await step(ctx, t.name, async () => {
        const { items, fetchedAt } = await provider.squad(t.source_ref);
        const squad = items[0] ? normaliseSquad(items[0]) : { players: [] };
        ctx.recordsIn += squad.players.length;
        transaction(db, () => { ctx.recordsWritten += importSquad(db, SOURCE_KEY, t.id, squad.players, fetchedAt); });
      });
    }
  },

  /* Squads give name, number, position and photo; birth date, nationality
   * and height need one request per player, so they come in batches —
   * current squad members first. */
  async sync_players(ctx) {
    const { db, provider } = ctx;
    const limit = Number(getSetting(db, 'player_profiles_per_run')) || 150;
    const players = db.prepare(`
      SELECT p.id, p.source_ref, p.name FROM players p
      WHERE p.source_key = ? AND p.profiled_at IS NULL
      ORDER BY EXISTS (SELECT 1 FROM team_rosters r WHERE r.player_id = p.id AND r.valid_to IS NULL) DESC, p.id
      LIMIT ?`).all(SOURCE_KEY, limit);
    for (const p of players) {
      await step(ctx, p.name, async () => {
        const { items, fetchedAt } = await provider.playerProfile(p.source_ref);
        ctx.recordsIn += items.length;
        if (!items[0]) {
          /* Nothing known: mark it so the same player is not asked for daily. */
          db.prepare('UPDATE players SET profiled_at = ? WHERE id = ?').run(fetchedAt, p.id);
          return;
        }
        transaction(db, () => { importPlayerProfile(db, SOURCE_KEY, normalisePlayerProfile(items[0]), fetchedAt); });
        ctx.recordsWritten += 1;
      });
    }
    ctx.message = players.length ? `${players.length} players profiled.` : 'Every known player has a profile.';
  },

  async sync_injuries(ctx) {
    const { db, provider } = ctx;
    for (const c of enabledCompetitions(db)) {
      const season = currentSeason(db, c.id);
      const coverage = JSON.parse(season?.coverage_json ?? '{}');
      if (!season || coverage.injuries === false) continue;
      await step(ctx, c.name, async () => {
        const { items, fetchedAt } = await provider.injuries(c.api_football_id, season.year);
        ctx.recordsIn += items.length;
        transaction(db, () => {
          ctx.recordsWritten += importInjuries(db, SOURCE_KEY, items.map(normaliseInjury), fetchedAt);
        });
      });
    }
  },

  /* Earlier seasons: fixture lists and final tables. Their match details
   * then arrive through sync_results' backlog, a few batches per run, so a
   * backfill never eats the daily quota in one go. */
  async backfill_history(ctx) {
    const { db, provider } = ctx;
    const depth = Number(getSetting(db, 'backfill_seasons')) || 3;
    for (const c of enabledCompetitions(db)) {
      const current = currentSeason(db, c.id);
      if (!current) { ctx.errors.push(`${c.name}: no current season yet`); continue; }
      const past = db.prepare(`SELECT * FROM seasons WHERE competition_id = ? AND year < ? AND year >= ?
                               ORDER BY year DESC`).all(c.id, current.year, current.year - depth);
      for (const season of past) {
        await step(ctx, `${c.name} ${season.label}`, async () => {
          await importSeasonFixtures(ctx, c, season, provider);
          await importSeasonStandings(ctx, c, season, provider);
        });
      }
    }
  },
};

async function importSeasonFixtures(ctx, competition, season, provider) {
  const { db } = ctx;
  const { items, fetchedAt } = await provider.fixtures(competition.api_football_id, season.year);
  ctx.recordsIn += items.length;
  transaction(db, () => {
    for (const item of items) {
      const result = importFixture(db, SOURCE_KEY, season.id, normaliseFixture(item), fetchedAt);
      if (result?.changed) ctx.recordsWritten += 1;
    }
  });
}

async function importSeasonStandings(ctx, competition, season, provider) {
  const { db } = ctx;
  const { items, fetchedAt } = await provider.standings(competition.api_football_id, season.year);
  ctx.recordsIn += items.length;
  if (!items[0]) return;
  const { rows } = normaliseStandings(items[0]);
  transaction(db, () => { ctx.recordsWritten += importStandings(db, SOURCE_KEY, season.id, rows, fetchedAt); });
}

/* -------------------------------------------------------------- runner */

/**
 * Run one job now and log it in job_runs. `providerFactory` is replaced in
 * tests; in production it builds the API-Football client from the key.
 */
export async function runJob(db, key, { providerFactory } = {}) {
  const job = db.prepare('SELECT * FROM jobs WHERE key = ?').get(key);
  if (!JOBS[key] || !job) throw new Error(`Unknown job: ${key}`);

  const startedAt = new Date().toISOString();
  const lockUntil = new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString();
  /* Take the lock atomically: a second worker, or a click on "Run now"
   * while the job is running, finds it held and leaves. */
  const taken = db.prepare(`UPDATE jobs SET locked_until = ? WHERE key = ? AND (locked_until IS NULL OR locked_until < ?)`)
    .run(lockUntil, key, startedAt);
  if (!taken.changes) return null;

  const runId = Number(db.prepare('INSERT INTO job_runs (job_key, source_key, started_at) VALUES (?, ?, ?)')
    .run(key, SOURCE_KEY, startedAt).lastInsertRowid);
  const ctx = { db, recordsIn: 0, recordsWritten: 0, errors: [], message: null, provider: null };
  let status = 'ok';
  try {
    ctx.provider = (providerFactory ?? defaultProvider)(db);
    await JOBS[key](ctx);
    if (ctx.errors.length) status = ctx.recordsWritten || ctx.recordsIn ? 'partial' : 'failed';
  } catch (error) {
    status = 'failed';
    if (!ctx.errors.length || !ctx.errors[ctx.errors.length - 1].endsWith(error.message)) ctx.errors.push(error.message);
  } finally {
    const finishedAt = new Date().toISOString();
    /* A failed job tries again soon rather than waiting out its interval —
     * for the weekly competitions job that would be a week. */
    const retry = ctx.fatal ? RETRY_BLOCKED_MINUTES : RETRY_FAILED_MINUTES;
    const minutes = status === 'failed' ? Math.min(job.interval_minutes, retry) : job.interval_minutes;
    const nextRun = minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
    db.prepare(`UPDATE job_runs SET finished_at = ?, status = ?, records_in = ?, records_written = ?,
                  requests_used = ?, message = ?, errors_json = ? WHERE id = ?`)
      .run(finishedAt, status, ctx.recordsIn, ctx.recordsWritten, ctx.provider?.requestsUsed ?? 0,
        ctx.message ?? ctx.errors[0] ?? null, JSON.stringify(ctx.errors.slice(0, 50)), runId);
    db.prepare('UPDATE jobs SET locked_until = NULL, next_run_at = ?, run_requested_at = NULL WHERE key = ?')
      .run(nextRun, key);
  }
  return db.prepare('SELECT * FROM job_runs WHERE id = ?').get(runId);
}

function defaultProvider(db) {
  return createClient({ db, apiKey: process.env.API_FOOTBALL_KEY });
}

/** Jobs due now, in their configured order. */
export function dueJobs(db, at = new Date().toISOString()) {
  return db.prepare(`
    SELECT key FROM jobs
    WHERE (locked_until IS NULL OR locked_until < ?)
      AND (run_requested_at IS NOT NULL
           OR (is_enabled = 1 AND interval_minutes > 0 AND (next_run_at IS NULL OR next_run_at <= ?)))
    ORDER BY ordinal`).all(at, at).map((r) => r.key);
}

/** On worker start: jobs whose last run failed run again straight away —
 *  typically the key was missing and has just been added. */
export function retryFailedNow(db) {
  return db.prepare(`
    UPDATE jobs SET next_run_at = NULL
    WHERE interval_minutes > 0 AND (SELECT status FROM job_runs r WHERE r.job_key = jobs.key ORDER BY id DESC LIMIT 1) = 'failed'`)
    .run().changes;
}

export function requestRun(db, key) {
  const info = db.prepare('UPDATE jobs SET run_requested_at = ? WHERE key = ?').run(new Date().toISOString(), key);
  return info.changes > 0;
}

export function syncStatus(db) {
  const jobs = db.prepare('SELECT * FROM jobs ORDER BY ordinal').all();
  const last = db.prepare('SELECT * FROM job_runs WHERE job_key = ? ORDER BY id DESC LIMIT 1');
  const lastOk = db.prepare(`SELECT finished_at FROM job_runs WHERE job_key = ? AND status IN ('ok', 'partial')
                             ORDER BY id DESC LIMIT 1`);
  const quota = db.prepare('SELECT * FROM provider_quota WHERE source_key = ? ORDER BY day DESC LIMIT 1').get(SOURCE_KEY);
  return {
    providerConfigured: !!process.env.API_FOOTBALL_KEY,
    explainerConfigured: !!process.env.ANTHROPIC_API_KEY,
    quota: quota ?? null,
    jobs: jobs.map((j) => {
      const run = last.get(j.key);
      return {
        key: j.key, name: j.name, description: j.description, intervalMinutes: j.interval_minutes,
        isEnabled: !!j.is_enabled, nextRunAt: j.next_run_at, running: !!(j.locked_until && j.locked_until > new Date().toISOString()),
        runRequested: !!j.run_requested_at,
        lastSuccessAt: lastOk.get(j.key)?.finished_at ?? null,
        lastRun: run ? { ...run, errors: JSON.parse(run.errors_json) } : null,
      };
    }),
  };
}

export { idFor };

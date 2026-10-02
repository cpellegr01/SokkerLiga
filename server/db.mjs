/* Database access for SokkerLiga.
 *
 * No dependencies: node:sqlite and node:fs only, matching SAM. Master data is
 * loaded from server/seed/*.json on every open, so it is versioned in files
 * but queried from the database like everything else.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promptRecord } from './ai/claude.mjs';
import { questionPromptRecord } from './ai/questions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED_DIR = join(HERE, 'seed');

export const DEFAULT_DB_PATH = join(HERE, '..', 'data', 'sokkerliga.db');

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* [file, table, key column, columns refreshed from the seed on every start,
 * columns inserted from the seed once and then left to Settings]. */
const SEEDS = [
  ['data-sources.json', 'data_sources', 'key', ['name', 'terms_url', 'licence_notes', 'ordinal'], []],
  ['match-statuses.json', 'match_statuses', 'key', ['name', 'is_final', 'is_live', 'ordinal'], []],
  ['stat-types.json', 'stat_types', 'key', ['name', 'unit', 'provider_label', 'ordinal'], []],
  ['competitions.json', 'competitions', 'key',
    ['name', 'country_code', 'country_name', 'kind', 'ordinal', 'api_football_id'], ['is_enabled']],
  ['jobs.json', 'jobs', 'key', ['name', 'description', 'interval_minutes', 'ordinal', 'quota_priority'], []],
  ['market-types.json', 'market_types', 'key', ['name', 'family', 'has_line', 'description', 'ordinal'], []],
];

const DEFAULT_SETTINGS = {
  /* How many seasons before the current one the history backfill fetches. */
  backfill_seasons: '3',
  /* Matches whose details are fetched per provider request (the provider's
   * maximum for /fixtures?ids= is 20). */
  details_batch_size: '20',
  /* Player profiles fetched per run of sync_players. */
  player_profiles_per_run: '150',
  /* Requests kept back each day for results and lineups: below this many
   * left, deferrable jobs wait for tomorrow (see jobs.quota_priority). */
  quota_reserve: '750',
  /* Seconds of work per run of the backtest, so it never hogs the server. */
  backtest_seconds_per_run: '45',
};

export function openDatabase(path = DEFAULT_DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  /* WAL lets the API read while the worker writes; busy_timeout makes a
   * writer wait for the other process rather than fail at once. */
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  addMissingColumns(db);
  loadMasterData(db);
  return db;
}

/* Columns added after a table was first created. schema.sql has them for a
 * new database; an existing one gets them here. Adding is the only kind of
 * change made this way — nothing is renamed or dropped. */
const ADDED_COLUMNS = [
  ['jobs', 'quota_priority', "TEXT NOT NULL DEFAULT 'normal'"],
  ['analysis_runs', 'calibration_json', 'TEXT'],
  ['bets', 'fee_minor', 'INTEGER NOT NULL DEFAULT 0'],
  ['bets', 'contracts', 'REAL'],
  ['bets', 'limit_price', 'REAL'],
];

function addMissingColumns(db) {
  for (const [table, column, ddl] of ADDED_COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (has) continue;
    /* The API and the worker start together; whichever is second finds
     * the column already added. */
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    } catch (error) {
      if (!/duplicate column/i.test(error.message)) throw error;
    }
  }
}

function loadMasterData(db) {
  const now = new Date().toISOString();
  transaction(db, () => {
    for (const [file, table, key, refreshed, insertOnly] of SEEDS) {
      const rows = JSON.parse(readFileSync(join(SEED_DIR, file), 'utf8'));
      const columns = [key, ...refreshed, ...insertOnly];
      const update = refreshed.map((c) => `${c} = excluded.${c}`).join(', ');
      const insert = db.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
         ON CONFLICT(${key}) DO UPDATE SET ${update}`,
      );
      for (const row of rows) insert.run(...columns.map((c) => row[c] ?? null));
    }
    /* Models are keyed by (key, version): a new version is a new row and an
     * old one is never rewritten, so past runs keep pointing at what ran. */
    const model = db.prepare(`INSERT INTO models (key, version, name, kind, description, params_json)
                              VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key, version) DO NOTHING`);
    for (const m of JSON.parse(readFileSync(join(SEED_DIR, 'models.json'), 'utf8'))) {
      model.run(m.key, m.version, m.name, m.kind, m.description, m.params_json);
    }
    for (const record of [promptRecord(), questionPromptRecord()]) registerPrompt(db, now, record);

    const setting = db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING',
    );
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setting.run(k, v, now);
  });
}

/* Each prompt file is stored by version with its checksum. Editing the text
 * without bumping its version would make past analyses claim a prompt they
 * were not given, so that stops the start-up with an explanation. */
function registerPrompt(db, now, p) {
  const existing = db.prepare('SELECT sha256 FROM prompts WHERE key = ? AND version = ?').get(p.key, p.version);
  if (!existing) {
    db.prepare('INSERT INTO prompts (key, version, body, sha256, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.key, p.version, p.body, p.sha256, now);
  } else if (existing.sha256 !== p.sha256) {
    throw new Error(`The prompt ${p.key} v${p.version} was edited after use. Save the change as a new version `
      + '(a new file and its version constant in server/ai/) instead.');
  }
}

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

/** Run fn inside a transaction; roll back if it throws. */
export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

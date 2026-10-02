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
  ['jobs.json', 'jobs', 'key', ['name', 'description', 'interval_minutes', 'ordinal'], []],
];

const DEFAULT_SETTINGS = {
  /* How many seasons before the current one the history backfill fetches. */
  backfill_seasons: '3',
  /* Matches whose details are fetched per provider request (the provider's
   * maximum for /fixtures?ids= is 20). */
  details_batch_size: '20',
  /* Player profiles fetched per run of sync_players. */
  player_profiles_per_run: '150',
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
  loadMasterData(db);
  return db;
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
    const setting = db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING',
    );
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setting.run(k, v, now);
  });
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

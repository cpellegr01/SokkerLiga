-- SokkerLiga schema — Phase 1: the football knowledge base.
-- Every statement is idempotent; the file runs on every start.
-- Design and conventions: docs/architecture.md §2.
--
-- Provenance: every imported fact carries source_key, source_ref (the
-- provider's id) and fetched_at. History is never overwritten: corrections to
-- a match or its statistics copy the old values into a *_revisions table
-- first; squads use valid_from / valid_to; standings are a dated series.

-- ----------------------------------------------------------------- people

-- Accounts live in the Conforza front door. A person is known here by the
-- front door's user id, recorded when first seen.
CREATE TABLE IF NOT EXISTS people (
  user_id       TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_favourites (
  user_id     TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('competition', 'team')),
  entity_id   INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, entity_type, entity_id)
);

-- ------------------------------------------------------- master data

CREATE TABLE IF NOT EXISTS data_sources (
  key           TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  terms_url     TEXT NOT NULL DEFAULT '',
  licence_notes TEXT NOT NULL DEFAULT '',
  ordinal       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS match_statuses (
  key      TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  is_final INTEGER NOT NULL DEFAULT 0,
  is_live  INTEGER NOT NULL DEFAULT 0,
  ordinal  INTEGER NOT NULL
);

-- provider_label is the name API-Football gives the statistic. A statistic
-- the provider adds later is created on import under its own label, so a new
-- statistic never stops an import.
CREATE TABLE IF NOT EXISTS stat_types (
  key            TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  unit           TEXT NOT NULL DEFAULT 'count',
  provider_label TEXT UNIQUE,
  ordinal        INTEGER NOT NULL
);

-- ------------------------------------------------- sourcing and identity

-- Provider id → our id, per entity type. Two providers describing the same
-- team resolve to one row through here.
CREATE TABLE IF NOT EXISTS external_ids (
  entity_type TEXT NOT NULL,
  entity_id   INTEGER NOT NULL,
  source_key  TEXT NOT NULL REFERENCES data_sources(key),
  source_ref  TEXT NOT NULL,
  PRIMARY KEY (entity_type, source_key, source_ref)
);
CREATE INDEX IF NOT EXISTS external_ids_entity_idx ON external_ids(entity_type, entity_id);

-- Every provider response, compressed, so an import bug is fixed by
-- re-processing rather than spending quota on re-fetching.
CREATE TABLE IF NOT EXISTS raw_payloads (
  id          INTEGER PRIMARY KEY,
  source_key  TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  params_json TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  body_gz     BLOB,
  sha256      TEXT
);
CREATE INDEX IF NOT EXISTS raw_payloads_endpoint_idx ON raw_payloads(source_key, endpoint, fetched_at);

-- -------------------------------------------------------- competitions

CREATE TABLE IF NOT EXISTS competitions (
  id              INTEGER PRIMARY KEY,
  key             TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  country_code    TEXT NOT NULL DEFAULT '',
  country_name    TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT 'league',
  logo_url        TEXT,
  flag_url        TEXT,
  is_enabled      INTEGER NOT NULL DEFAULT 1,
  ordinal         INTEGER NOT NULL DEFAULT 100,
  api_football_id INTEGER UNIQUE
);

CREATE TABLE IF NOT EXISTS seasons (
  id             INTEGER PRIMARY KEY,
  competition_id INTEGER NOT NULL REFERENCES competitions(id),
  year           INTEGER NOT NULL,           -- the provider's season key: start year
  label          TEXT NOT NULL,              -- '2026/27', or '2026' for calendar-year leagues
  start_date     TEXT,
  end_date       TEXT,
  is_current     INTEGER NOT NULL DEFAULT 0,
  coverage_json  TEXT NOT NULL DEFAULT '{}', -- what the provider has for this season
  fetched_at     TEXT,
  UNIQUE (competition_id, year)
);

-- ----------------------------------------------------- teams and players

CREATE TABLE IF NOT EXISTS venues (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  address    TEXT,
  city       TEXT,
  capacity   INTEGER,
  surface    TEXT,
  image_url  TEXT,
  source_key TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE (source_key, source_ref)
);

CREATE TABLE IF NOT EXISTS teams (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  code         TEXT,
  country_name TEXT,
  founded      INTEGER,
  is_national  INTEGER NOT NULL DEFAULT 0,
  logo_url     TEXT,
  venue_id     INTEGER REFERENCES venues(id),
  source_key   TEXT NOT NULL,
  source_ref   TEXT NOT NULL,
  fetched_at   TEXT NOT NULL,
  UNIQUE (source_key, source_ref)
);
CREATE INDEX IF NOT EXISTS teams_name_idx ON teams(name COLLATE NOCASE);

-- Which teams take part in which season of which competition.
CREATE TABLE IF NOT EXISTS season_teams (
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  team_id   INTEGER NOT NULL REFERENCES teams(id),
  PRIMARY KEY (season_id, team_id)
);

CREATE TABLE IF NOT EXISTS managers (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  photo_url  TEXT,
  source_key TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE (source_key, source_ref)
);

-- A manager's spell at a team, as seen in lineups: opened the first time
-- they appear, closed when another manager appears for that team.
CREATE TABLE IF NOT EXISTS team_managers (
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  manager_id INTEGER NOT NULL REFERENCES managers(id),
  valid_from TEXT NOT NULL,
  valid_to   TEXT,
  PRIMARY KEY (team_id, manager_id, valid_from)
);

CREATE TABLE IF NOT EXISTS players (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  first_name  TEXT,
  last_name   TEXT,
  birth_date  TEXT,
  nationality TEXT,
  height_cm   INTEGER,
  position    TEXT,          -- Goalkeeper / Defender / Midfielder / Attacker
  photo_url   TEXT,
  profiled_at TEXT,          -- when the full profile was last fetched
  source_key  TEXT NOT NULL,
  source_ref  TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  UNIQUE (source_key, source_ref)
);
CREATE INDEX IF NOT EXISTS players_name_idx ON players(name COLLATE NOCASE);

-- Squad membership over time. A player who leaves keeps the row, closed.
CREATE TABLE IF NOT EXISTS team_rosters (
  id           INTEGER PRIMARY KEY,
  team_id      INTEGER NOT NULL REFERENCES teams(id),
  player_id    INTEGER NOT NULL REFERENCES players(id),
  shirt_number INTEGER,
  position     TEXT,
  valid_from   TEXT NOT NULL,
  valid_to     TEXT
);
CREATE INDEX IF NOT EXISTS team_rosters_team_idx ON team_rosters(team_id, valid_to);
CREATE INDEX IF NOT EXISTS team_rosters_player_idx ON team_rosters(player_id);

-- ------------------------------------------------------------- matches

CREATE TABLE IF NOT EXISTS matches (
  id                  INTEGER PRIMARY KEY,
  season_id           INTEGER NOT NULL REFERENCES seasons(id),
  round               TEXT,
  kickoff_utc         TEXT NOT NULL,
  venue_id            INTEGER REFERENCES venues(id),
  venue_name          TEXT,
  venue_city          TEXT,
  home_team_id        INTEGER NOT NULL REFERENCES teams(id),
  away_team_id        INTEGER NOT NULL REFERENCES teams(id),
  status_key          TEXT NOT NULL REFERENCES match_statuses(key),
  status_detail       TEXT,            -- the provider's own status, e.g. 'HT', 'AET'
  elapsed             INTEGER,
  home_goals          INTEGER,
  away_goals          INTEGER,
  home_ht             INTEGER,
  away_ht             INTEGER,
  home_et             INTEGER,
  away_et             INTEGER,
  home_pens           INTEGER,
  away_pens           INTEGER,
  referee             TEXT,
  result_confirmed_at TEXT,            -- a final result seen at least 3 hours after kickoff
  details_fetched_at  TEXT,            -- events, lineups and statistics last imported
  source_key          TEXT NOT NULL,
  source_ref          TEXT NOT NULL,
  fetched_at          TEXT NOT NULL,
  UNIQUE (source_key, source_ref)
);
CREATE INDEX IF NOT EXISTS matches_kickoff_idx ON matches(kickoff_utc);
CREATE INDEX IF NOT EXISTS matches_season_idx ON matches(season_id, kickoff_utc);
CREATE INDEX IF NOT EXISTS matches_home_idx ON matches(home_team_id, kickoff_utc);
CREATE INDEX IF NOT EXISTS matches_away_idx ON matches(away_team_id, kickoff_utc);
CREATE INDEX IF NOT EXISTS matches_status_idx ON matches(status_key, kickoff_utc);

-- Before a match row changes, its previous values land here.
CREATE TABLE IF NOT EXISTS match_revisions (
  id         INTEGER PRIMARY KEY,
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  changed_at TEXT NOT NULL,
  fields     TEXT NOT NULL,       -- comma-separated names of the changed fields
  old_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS match_revisions_match_idx ON match_revisions(match_id, changed_at);

CREATE TABLE IF NOT EXISTS match_events (
  id               INTEGER PRIMARY KEY,
  match_id         INTEGER NOT NULL REFERENCES matches(id),
  seq              INTEGER NOT NULL,       -- order within the match
  minute           INTEGER,
  extra_minute     INTEGER,
  team_id          INTEGER REFERENCES teams(id),
  player_id        INTEGER REFERENCES players(id),
  player_name      TEXT,
  assist_player_id INTEGER REFERENCES players(id),
  assist_name      TEXT,
  type_key         TEXT NOT NULL,          -- goal / own_goal / penalty_goal / missed_penalty / yellow / second_yellow / red / sub / var / other
  detail           TEXT,
  comments         TEXT,
  source_key       TEXT NOT NULL,
  fetched_at       TEXT NOT NULL,
  UNIQUE (match_id, seq)
);
CREATE INDEX IF NOT EXISTS match_events_player_idx ON match_events(player_id);

CREATE TABLE IF NOT EXISTS lineups (
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  formation  TEXT,
  status     TEXT NOT NULL DEFAULT 'confirmed',
  manager_id INTEGER REFERENCES managers(id),
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (match_id, team_id)
);

CREATE TABLE IF NOT EXISTS lineup_players (
  match_id     INTEGER NOT NULL REFERENCES matches(id),
  team_id      INTEGER NOT NULL REFERENCES teams(id),
  player_id    INTEGER NOT NULL REFERENCES players(id),
  role         TEXT NOT NULL CHECK (role IN ('starter', 'sub')),
  position     TEXT,
  grid         TEXT,
  shirt_number INTEGER,
  PRIMARY KEY (match_id, player_id)
);

-- Reported injuries and suspensions: one row per player per match the
-- provider lists them as missing or doubtful for.
CREATE TABLE IF NOT EXISTS availability (
  id                INTEGER PRIMARY KEY,
  player_id         INTEGER NOT NULL REFERENCES players(id),
  team_id           INTEGER NOT NULL REFERENCES teams(id),
  match_id          INTEGER NOT NULL REFERENCES matches(id),
  status            TEXT NOT NULL,     -- missing / doubtful
  reason            TEXT,
  first_reported_at TEXT NOT NULL,
  last_reported_at  TEXT NOT NULL,
  source_key        TEXT NOT NULL,
  UNIQUE (player_id, match_id, source_key)
);
CREATE INDEX IF NOT EXISTS availability_match_idx ON availability(match_id);

-- ---------------------------------------------------------- statistics

CREATE TABLE IF NOT EXISTS team_match_stats (
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  stat_key   TEXT NOT NULL REFERENCES stat_types(key),
  value      REAL,
  source_key TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (match_id, team_id, stat_key)
);

CREATE TABLE IF NOT EXISTS team_match_stats_revisions (
  id         INTEGER PRIMARY KEY,
  match_id   INTEGER NOT NULL,
  team_id    INTEGER NOT NULL,
  stat_key   TEXT NOT NULL,
  old_value  REAL,
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS player_match_stats (
  match_id         INTEGER NOT NULL REFERENCES matches(id),
  player_id        INTEGER NOT NULL REFERENCES players(id),
  team_id          INTEGER NOT NULL REFERENCES teams(id),
  minutes          INTEGER,
  position         TEXT,
  rating           REAL,
  is_captain       INTEGER,
  is_substitute    INTEGER,
  goals            INTEGER,
  assists          INTEGER,
  goals_conceded   INTEGER,
  saves            INTEGER,
  shots            INTEGER,
  shots_on_target  INTEGER,
  passes           INTEGER,
  key_passes       INTEGER,
  pass_accuracy    REAL,
  tackles          INTEGER,
  interceptions    INTEGER,
  duels            INTEGER,
  duels_won        INTEGER,
  dribbles         INTEGER,
  dribbles_won     INTEGER,
  fouls_drawn      INTEGER,
  fouls_committed  INTEGER,
  yellow           INTEGER,
  red              INTEGER,
  offsides         INTEGER,
  penalties_scored INTEGER,
  penalties_missed INTEGER,
  penalties_saved  INTEGER,
  source_key       TEXT NOT NULL,
  fetched_at       TEXT NOT NULL,
  PRIMARY KEY (match_id, player_id)
);
CREATE INDEX IF NOT EXISTS player_match_stats_player_idx ON player_match_stats(player_id);

-- ----------------------------------------------------------- standings

-- A dated series: each import whose provider "updated" time is new adds a
-- full set of rows, so the table on any past date can be read back.
CREATE TABLE IF NOT EXISTS standings (
  id             INTEGER PRIMARY KEY,
  season_id      INTEGER NOT NULL REFERENCES seasons(id),
  group_name     TEXT NOT NULL DEFAULT '',
  team_id        INTEGER NOT NULL REFERENCES teams(id),
  as_of          TEXT NOT NULL,
  position       INTEGER NOT NULL,
  played         INTEGER, won INTEGER, drawn INTEGER, lost INTEGER,
  goals_for      INTEGER, goals_against INTEGER, goal_diff INTEGER,
  points         INTEGER,
  form           TEXT,
  description    TEXT,
  home_played    INTEGER, home_won INTEGER, home_drawn INTEGER, home_lost INTEGER,
  home_goals_for INTEGER, home_goals_against INTEGER,
  away_played    INTEGER, away_won INTEGER, away_drawn INTEGER, away_lost INTEGER,
  away_goals_for INTEGER, away_goals_against INTEGER,
  source_key     TEXT NOT NULL,
  fetched_at     TEXT NOT NULL,
  UNIQUE (season_id, group_name, team_id, as_of)
);
CREATE INDEX IF NOT EXISTS standings_latest_idx ON standings(season_id, as_of);

-- ---------------------------------------------------------------- jobs

CREATE TABLE IF NOT EXISTS jobs (
  key              TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  interval_minutes INTEGER NOT NULL,      -- 0 = run by hand only
  is_enabled       INTEGER NOT NULL DEFAULT 1,
  next_run_at      TEXT,
  locked_until     TEXT,
  run_requested_at TEXT,                  -- "Run now" from Settings
  ordinal          INTEGER NOT NULL,
  quota_priority   TEXT NOT NULL DEFAULT 'normal'  -- essential / normal / deferrable: what waits when requests run low
);

CREATE TABLE IF NOT EXISTS job_runs (
  id              INTEGER PRIMARY KEY,
  job_key         TEXT NOT NULL REFERENCES jobs(key),
  source_key      TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL DEFAULT 'running',  -- running / ok / partial / failed / skipped
  records_in      INTEGER NOT NULL DEFAULT 0,
  records_written INTEGER NOT NULL DEFAULT 0,
  requests_used   INTEGER NOT NULL DEFAULT 0,
  message         TEXT,
  errors_json     TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS job_runs_job_idx ON job_runs(job_key, started_at);

CREATE TABLE IF NOT EXISTS provider_quota (
  source_key    TEXT NOT NULL,
  day           TEXT NOT NULL,      -- UTC date
  requests_used INTEGER NOT NULL DEFAULT 0,
  daily_limit   INTEGER,
  remaining     INTEGER,            -- as last reported by the provider
  PRIMARY KEY (source_key, day)
);

-- Settings that are data rather than deployment configuration.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- =================================================================
-- Phase 2: markets, analysis runs, predictions, recommendations.
-- Design: docs/architecture.md §2 "Predictions" and §6.
--
-- Predictions are evidence. Once written they cannot be changed or
-- deleted (triggers below), and none can be written for a match that has
-- kicked off. Re-analysing before kickoff writes new rows and marks the old
-- ones superseded; nothing is overwritten.
-- =================================================================

-- What can be predicted: '1X2', 'Over/Under goals', 'Asian handicap'...
CREATE TABLE IF NOT EXISTS market_types (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  family      TEXT NOT NULL,            -- goals / corners / cards
  has_line    INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  ordinal     INTEGER NOT NULL
);

-- One question about one match ('over/under 2.5 goals in Arsenal v Spurs').
CREATE TABLE IF NOT EXISTS markets (
  id              INTEGER PRIMARY KEY,
  match_id        INTEGER NOT NULL REFERENCES matches(id),
  market_type_key TEXT NOT NULL REFERENCES market_types(key),
  line            REAL,                  -- NULL for markets without a line
  UNIQUE (match_id, market_type_key, line)
);

CREATE TABLE IF NOT EXISTS selections (
  id        INTEGER PRIMARY KEY,
  market_id INTEGER NOT NULL REFERENCES markets(id),
  key       TEXT NOT NULL,               -- home / draw / away / over / under / yes / no / home_draw ...
  UNIQUE (market_id, key)
);

-- The engines and their versions: the statistical model, the explainer.
CREATE TABLE IF NOT EXISTS models (
  key         TEXT NOT NULL,
  version     TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,             -- statistical / llm
  description TEXT NOT NULL DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (key, version)
);

-- Prompt text is versioned data: a changed prompt is a new version.
CREATE TABLE IF NOT EXISTS prompts (
  key        TEXT NOT NULL,
  version    TEXT NOT NULL,
  body       TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (key, version)
);

-- Exactly what the model and Claude were given, so any prediction can be
-- reconstructed and audited later.
CREATE TABLE IF NOT EXISTS feature_snapshots (
  id                  INTEGER PRIMARY KEY,
  match_id            INTEGER NOT NULL REFERENCES matches(id),
  as_of               TEXT NOT NULL,
  builder_version     TEXT NOT NULL,
  features_json       TEXT NOT NULL,
  data_freshness_json TEXT NOT NULL,
  sha256              TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feature_snapshots_match_idx ON feature_snapshots(match_id, as_of);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id                  INTEGER PRIMARY KEY,
  match_id            INTEGER NOT NULL REFERENCES matches(id),
  requested_by        TEXT,
  requested_at        TEXT NOT NULL,
  started_at          TEXT,
  completed_at        TEXT,
  status              TEXT NOT NULL DEFAULT 'queued', -- queued / running / completed / failed
  as_of               TEXT,
  feature_snapshot_id INTEGER REFERENCES feature_snapshots(id),
  prob_model_key      TEXT,
  prob_model_version  TEXT,
  ai_model            TEXT,
  prompt_key          TEXT,
  prompt_version      TEXT,
  ai_status           TEXT,             -- explained / skipped / failed / refused
  ai_error            TEXT,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cost_cents          REAL,
  error               TEXT,
  calibration_json    TEXT              -- Phase 4: the calibration fits applied, by market
);
CREATE INDEX IF NOT EXISTS analysis_runs_match_idx ON analysis_runs(match_id, requested_at);
CREATE INDEX IF NOT EXISTS analysis_runs_status_idx ON analysis_runs(status);

CREATE TABLE IF NOT EXISTS predictions (
  id                     INTEGER PRIMARY KEY,
  analysis_run_id        INTEGER NOT NULL REFERENCES analysis_runs(id),
  match_id               INTEGER NOT NULL REFERENCES matches(id),
  selection_id           INTEGER NOT NULL REFERENCES selections(id),
  model_probability      REAL NOT NULL,
  calibrated_probability REAL,          -- Phase 4
  fair_odds              REAL NOT NULL,  -- 1 / probability
  confidence_score       REAL NOT NULL,  -- 0..1
  confidence_band        TEXT NOT NULL,  -- low / medium / high
  created_at             TEXT NOT NULL,
  superseded_by          INTEGER REFERENCES predictions(id)
);
CREATE INDEX IF NOT EXISTS predictions_match_idx ON predictions(match_id, created_at);
CREATE INDEX IF NOT EXISTS predictions_run_idx ON predictions(analysis_run_id);

CREATE TABLE IF NOT EXISTS prediction_factors (
  id            INTEGER PRIMARY KEY,
  prediction_id INTEGER NOT NULL REFERENCES predictions(id),
  direction     TEXT NOT NULL CHECK (direction IN ('for', 'against')),
  label         TEXT NOT NULL,
  evidence      TEXT,
  source        TEXT NOT NULL DEFAULT 'ai'   -- ai / model
);
CREATE INDEX IF NOT EXISTS prediction_factors_prediction_idx ON prediction_factors(prediction_id);

CREATE TABLE IF NOT EXISTS recommendations (
  id                INTEGER PRIMARY KEY,
  analysis_run_id   INTEGER NOT NULL REFERENCES analysis_runs(id),
  prediction_id     INTEGER NOT NULL REFERENCES predictions(id),
  decision          TEXT NOT NULL CHECK (decision IN ('recommend', 'pass')),
  pass_reasons_json TEXT NOT NULL DEFAULT '[]',
  thresholds_json   TEXT NOT NULL,       -- the thresholds in force when decided
  ai_stance         TEXT,                -- support / caution / oppose, when Claude reviewed it
  reasoning_summary TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recommendations_run_idx ON recommendations(analysis_run_id);

CREATE TABLE IF NOT EXISTS ai_explanations (
  analysis_run_id INTEGER PRIMARY KEY REFERENCES analysis_runs(id),
  summary         TEXT NOT NULL,
  narrative       TEXT NOT NULL,
  key_factors_json TEXT NOT NULL DEFAULT '[]',
  data_gaps_json  TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL
);

-- Dated rows: the thresholds in force at any moment can be read back.
CREATE TABLE IF NOT EXISTS recommendation_thresholds (
  id               INTEGER PRIMARY KEY,
  user_id          TEXT NOT NULL,
  min_confidence   TEXT NOT NULL DEFAULT 'medium',  -- low / medium / high
  min_probability  REAL NOT NULL DEFAULT 0.55,
  min_fair_odds    REAL NOT NULL DEFAULT 1.3,   -- near-certainties are worth nothing at any price on offer
  max_fair_odds    REAL NOT NULL DEFAULT 2.5,
  markets_json     TEXT NOT NULL DEFAULT '[]',      -- enabled market type keys; [] = all
  effective_from   TEXT NOT NULL
);

-- ----------------------------------------------- immutability triggers

CREATE TRIGGER IF NOT EXISTS predictions_no_late_insert
BEFORE INSERT ON predictions
WHEN (SELECT kickoff_utc FROM matches WHERE id = NEW.match_id) <= NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'Predictions cannot be made after kickoff.');
END;

CREATE TRIGGER IF NOT EXISTS predictions_immutable
BEFORE UPDATE ON predictions
WHEN NOT (
  -- the only permitted change: marking a prediction superseded, before kickoff
  OLD.superseded_by IS NULL AND NEW.superseded_by IS NOT NULL
  AND NEW.analysis_run_id IS OLD.analysis_run_id AND NEW.match_id IS OLD.match_id
  AND NEW.selection_id IS OLD.selection_id AND NEW.model_probability IS OLD.model_probability
  AND NEW.calibrated_probability IS OLD.calibrated_probability AND NEW.fair_odds IS OLD.fair_odds
  AND NEW.confidence_score IS OLD.confidence_score AND NEW.confidence_band IS OLD.confidence_band
  AND NEW.created_at IS OLD.created_at
  AND (SELECT kickoff_utc FROM matches WHERE id = OLD.match_id) > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'Predictions cannot be changed once made.');
END;

CREATE TRIGGER IF NOT EXISTS predictions_no_delete BEFORE DELETE ON predictions
BEGIN SELECT RAISE(ABORT, 'Predictions cannot be deleted.'); END;

CREATE TRIGGER IF NOT EXISTS prediction_factors_immutable BEFORE UPDATE ON prediction_factors
BEGIN SELECT RAISE(ABORT, 'Prediction factors cannot be changed once made.'); END;
CREATE TRIGGER IF NOT EXISTS prediction_factors_no_delete BEFORE DELETE ON prediction_factors
BEGIN SELECT RAISE(ABORT, 'Prediction factors cannot be deleted.'); END;

CREATE TRIGGER IF NOT EXISTS recommendations_immutable BEFORE UPDATE ON recommendations
BEGIN SELECT RAISE(ABORT, 'Recommendations cannot be changed once made.'); END;
CREATE TRIGGER IF NOT EXISTS recommendations_no_delete BEFORE DELETE ON recommendations
BEGIN SELECT RAISE(ABORT, 'Recommendations cannot be deleted.'); END;

CREATE TRIGGER IF NOT EXISTS feature_snapshots_immutable BEFORE UPDATE ON feature_snapshots
BEGIN SELECT RAISE(ABORT, 'Feature snapshots cannot be changed once made.'); END;
CREATE TRIGGER IF NOT EXISTS feature_snapshots_no_delete BEFORE DELETE ON feature_snapshots
BEGIN SELECT RAISE(ABORT, 'Feature snapshots cannot be deleted.'); END;

CREATE TRIGGER IF NOT EXISTS ai_explanations_immutable BEFORE UPDATE ON ai_explanations
BEGIN SELECT RAISE(ABORT, 'Explanations cannot be changed once made.'); END;
CREATE TRIGGER IF NOT EXISTS ai_explanations_no_delete BEFORE DELETE ON ai_explanations
BEGIN SELECT RAISE(ABORT, 'Explanations cannot be deleted.'); END;

-- A completed run's record of what produced it is fixed.
CREATE TRIGGER IF NOT EXISTS analysis_runs_completed_immutable
BEFORE UPDATE ON analysis_runs
WHEN OLD.status IN ('completed', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'A finished analysis run cannot be changed.');
END;
CREATE TRIGGER IF NOT EXISTS analysis_runs_no_delete BEFORE DELETE ON analysis_runs
BEGIN SELECT RAISE(ABORT, 'Analysis runs cannot be deleted.'); END;

-- =================================================================
-- Phase 3: grading, bets recorded by hand, settlement.
-- Design: docs/architecture.md §7. Bets are placed in Claudio's betting
-- app and recorded here afterwards; SokkerLiga never places a bet.
-- Grades and settlements are append-only: a correction is a new row and the
-- latest row is the current one.
-- =================================================================

-- How each prediction turned out.
CREATE TABLE IF NOT EXISTS prediction_grades (
  id            INTEGER PRIMARY KEY,
  prediction_id INTEGER NOT NULL REFERENCES predictions(id),
  outcome       TEXT NOT NULL CHECK (outcome IN ('won', 'lost', 'push', 'void', 'half_won', 'half_lost')),
  source        TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  reason        TEXT,
  graded_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prediction_grades_prediction_idx ON prediction_grades(prediction_id, id);

-- The betting apps Claudio uses. Amounts are kept in each app's currency.
CREATE TABLE IF NOT EXISTS sportsbooks (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bets (
  id                     INTEGER PRIMARY KEY,
  user_id                TEXT NOT NULL,
  placed_at              TEXT NOT NULL,          -- when it was placed in the betting app
  sportsbook_key         TEXT NOT NULL REFERENCES sportsbooks(key),
  kind                   TEXT NOT NULL CHECK (kind IN ('single', 'parlay')),
  stake_minor            INTEGER NOT NULL CHECK (stake_minor > 0),   -- cents
  currency               TEXT NOT NULL,
  total_odds             REAL NOT NULL CHECK (total_odds > 1),
  total_odds_text        TEXT,                   -- as typed, when the app quoted its own total
  potential_payout_minor INTEGER NOT NULL,
  fee_minor              INTEGER NOT NULL DEFAULT 0,   -- the app's fees, charged on top of the bet and never returned
  contracts              REAL,                          -- prediction-market apps: contracts bought, each paying 1.00 if it wins
  limit_price            REAL,
  commission_minor       INTEGER NOT NULL DEFAULT 0,
  order_amount_minor     INTEGER,                      -- contract bets: the amount the order was placed for ($10.00); what was spent is the total cost   -- the app's commission, like fees: on top of the bet, never returned                          -- the order's limit price per contract (0.68), kept as typed; the fill is bet ÷ contracts
  notes                  TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  deleted_at             TEXT
);
CREATE INDEX IF NOT EXISTS bets_user_idx ON bets(user_id, placed_at);

CREATE TABLE IF NOT EXISTS bet_legs (
  id                       INTEGER PRIMARY KEY,
  bet_id                   INTEGER NOT NULL REFERENCES bets(id),
  ordinal                  INTEGER NOT NULL,
  match_id                 INTEGER NOT NULL REFERENCES matches(id),
  selection_id             INTEGER NOT NULL REFERENCES selections(id),
  odds_taken               REAL NOT NULL CHECK (odds_taken > 1),   -- decimal
  odds_text                TEXT NOT NULL,                          -- exactly as typed
  odds_format              TEXT NOT NULL,                          -- decimal / american / fractional
  -- Frozen at the moment the bet is recorded, from the model's latest
  -- prediction made before both the bet and kickoff. Never recomputed.
  prediction_id            INTEGER REFERENCES predictions(id),
  recommendation_id        INTEGER REFERENCES recommendations(id),
  model_probability_at_bet REAL,
  fair_odds_at_bet         REAL,
  edge_at_bet              REAL,     -- model probability − 1 / odds taken
  ev_at_bet                REAL,     -- expected profit per unit staked
  followed_recommendation  INTEGER,  -- 1 when the model said Recommend for this selection
  closing_odds             REAL,     -- typed in by hand when known (no odds feed)
  replaced_at              TEXT      -- set when an edit replaced this leg; kept for history
);
CREATE INDEX IF NOT EXISTS bet_legs_match_idx ON bet_legs(match_id);
CREATE INDEX IF NOT EXISTS bet_legs_bet_idx ON bet_legs(bet_id, replaced_at);

-- Edits keep the previous version of the bet and its legs.
CREATE TABLE IF NOT EXISTS bet_revisions (
  id         INTEGER PRIMARY KEY,
  bet_id     INTEGER NOT NULL REFERENCES bets(id),
  changed_at TEXT NOT NULL,
  reason     TEXT NOT NULL,
  old_json   TEXT NOT NULL
);

-- Settlement history. bet_leg_id NULL = the whole bet. The latest row for a
-- bet (or leg) is its current settlement.
CREATE TABLE IF NOT EXISTS settlements (
  id           INTEGER PRIMARY KEY,
  bet_id       INTEGER NOT NULL REFERENCES bets(id),
  bet_leg_id   INTEGER REFERENCES bet_legs(id),
  outcome      TEXT NOT NULL CHECK (outcome IN ('pending', 'won', 'lost', 'push', 'void', 'half_won', 'half_lost')),
  source       TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
  reason       TEXT,
  profit_minor INTEGER,              -- whole bet only; NULL for legs and pending
  settled_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS settlements_bet_idx ON settlements(bet_id, id);

CREATE TRIGGER IF NOT EXISTS prediction_grades_immutable BEFORE UPDATE ON prediction_grades
BEGIN SELECT RAISE(ABORT, 'Grades cannot be changed; add a correction instead.'); END;
CREATE TRIGGER IF NOT EXISTS prediction_grades_no_delete BEFORE DELETE ON prediction_grades
BEGIN SELECT RAISE(ABORT, 'Grades cannot be deleted.'); END;
CREATE TRIGGER IF NOT EXISTS settlements_immutable BEFORE UPDATE ON settlements
BEGIN SELECT RAISE(ABORT, 'Settlements cannot be changed; add a correction instead.'); END;
CREATE TRIGGER IF NOT EXISTS settlements_no_delete BEFORE DELETE ON settlements
BEGIN SELECT RAISE(ABORT, 'Settlements cannot be deleted.'); END;
CREATE TRIGGER IF NOT EXISTS bet_revisions_immutable BEFORE UPDATE ON bet_revisions
BEGIN SELECT RAISE(ABORT, 'Bet history cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS bet_revisions_no_delete BEFORE DELETE ON bet_revisions
BEGIN SELECT RAISE(ABORT, 'Bet history cannot be deleted.'); END;
-- Bets are soft-deleted (deleted_at); the row itself stays.
CREATE TRIGGER IF NOT EXISTS bets_no_delete BEFORE DELETE ON bets
BEGIN SELECT RAISE(ABORT, 'Bets are never deleted; they are marked deleted.'); END;

-- =================================================================
-- Phase 4: backtest, model performance, calibration.
-- Design: docs/architecture.md §3 "Calibration" and §9.
--
-- The backtest re-runs the statistical model for past matches as of an hour
-- before each match day, through the same buildFeatures() the live analysis
-- uses, so it can only see what was knowable then. Its rows are not
-- predictions (those cannot be made after kickoff); they are the evidence
-- for performance and for calibration.
-- =================================================================

CREATE TABLE IF NOT EXISTS backtest_matches (
  match_id      INTEGER NOT NULL REFERENCES matches(id),
  model_key     TEXT NOT NULL,
  model_version TEXT NOT NULL,
  as_of         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('priced', 'skipped')),
  reason        TEXT,
  inputs_json   TEXT,                 -- the learned model's inputs, as of as_of
  created_at    TEXT NOT NULL,
  PRIMARY KEY (match_id, model_key, model_version)
);

CREATE TABLE IF NOT EXISTS backtest_predictions (
  id              INTEGER PRIMARY KEY,
  match_id        INTEGER NOT NULL REFERENCES matches(id),
  model_key       TEXT NOT NULL,
  model_version   TEXT NOT NULL,
  market          TEXT NOT NULL REFERENCES market_types(key),
  line            REAL,
  selection       TEXT NOT NULL,
  probability     REAL NOT NULL,
  confidence_band TEXT NOT NULL,
  outcome         TEXT                -- graded from the confirmed result; NULL when the facts were missing
);
CREATE INDEX IF NOT EXISTS backtest_predictions_match_idx ON backtest_predictions(match_id);
CREATE INDEX IF NOT EXISTS backtest_predictions_market_idx ON backtest_predictions(market, model_key, model_version);

-- Isotonic calibration per market, refitted nightly. Dated rows: an analysis
-- uses the latest fit made before it, and records which.
CREATE TABLE IF NOT EXISTS calibrations (
  id             INTEGER PRIMARY KEY,
  model_key      TEXT NOT NULL,
  model_version  TEXT NOT NULL,
  market         TEXT NOT NULL REFERENCES market_types(key),
  fitted_at      TEXT NOT NULL,
  n              REAL NOT NULL,       -- graded selections it was fitted on
  knots_json     TEXT NOT NULL,       -- [[raw, calibrated], ...] increasing
  holdout_n      REAL NOT NULL,       -- the newest 20%, kept out of the trial fit
  raw_log_loss   REAL, cal_log_loss REAL,
  raw_brier      REAL, cal_brier    REAL,
  raw_ece        REAL, cal_ece      REAL,
  applied        INTEGER NOT NULL     -- 1 only when it improved the holdout
);
CREATE INDEX IF NOT EXISTS calibrations_latest_idx ON calibrations(model_key, model_version, market, fitted_at);

-- Dated snapshots of headline performance, so drift over time can be read back.
CREATE TABLE IF NOT EXISTS model_performance (
  id            INTEGER PRIMARY KEY,
  model_key     TEXT NOT NULL,
  model_version TEXT NOT NULL,
  computed_at   TEXT NOT NULL,
  source        TEXT NOT NULL,        -- live / backtest
  segment_json  TEXT NOT NULL,        -- {"market": "over_under"} ...
  n             REAL NOT NULL,
  brier         REAL, log_loss REAL, naive_brier REAL, ece REAL
);

-- A learned challenger: multinomial logistic regression for the match
-- result, trained nightly on the backtest's inputs. It runs in the shadow:
-- its views are logged and scored, never used for recommendations.
CREATE TABLE IF NOT EXISTS learned_models (
  id               INTEGER PRIMARY KEY,
  model_key        TEXT NOT NULL,
  version          TEXT NOT NULL,
  trained_at       TEXT NOT NULL,
  n_train          INTEGER NOT NULL,
  n_test           INTEGER NOT NULL,
  test_log_loss    REAL NOT NULL,
  baseline_log_loss REAL NOT NULL,    -- Dixon–Coles on the same held-out matches
  test_brier       REAL NOT NULL,
  baseline_brier   REAL NOT NULL,
  weights_json     TEXT NOT NULL,
  inputs_json      TEXT NOT NULL,     -- input names, in order
  UNIQUE (model_key, version)
);

CREATE TABLE IF NOT EXISTS challenger_predictions (
  id              INTEGER PRIMARY KEY,
  analysis_run_id INTEGER NOT NULL REFERENCES analysis_runs(id),
  match_id        INTEGER NOT NULL REFERENCES matches(id),
  model_key       TEXT NOT NULL,
  model_version   TEXT NOT NULL,
  selection       TEXT NOT NULL,      -- home / draw / away
  probability     REAL NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS challenger_predictions_match_idx ON challenger_predictions(match_id);

CREATE TRIGGER IF NOT EXISTS backtest_predictions_immutable BEFORE UPDATE ON backtest_predictions
BEGIN SELECT RAISE(ABORT, 'Backtest rows cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS calibrations_immutable BEFORE UPDATE ON calibrations
BEGIN SELECT RAISE(ABORT, 'Calibrations cannot be changed; a refit is a new row.'); END;
CREATE TRIGGER IF NOT EXISTS calibrations_no_delete BEFORE DELETE ON calibrations
BEGIN SELECT RAISE(ABORT, 'Calibrations cannot be deleted.'); END;
CREATE TRIGGER IF NOT EXISTS learned_models_immutable BEFORE UPDATE ON learned_models
BEGIN SELECT RAISE(ABORT, 'A trained model cannot be changed; retraining makes a new version.'); END;
CREATE TRIGGER IF NOT EXISTS challenger_predictions_immutable BEFORE UPDATE ON challenger_predictions
BEGIN SELECT RAISE(ABORT, 'Challenger predictions cannot be changed.'); END;
CREATE TRIGGER IF NOT EXISTS challenger_predictions_no_late_insert
BEFORE INSERT ON challenger_predictions
WHEN (SELECT kickoff_utc FROM matches WHERE id = NEW.match_id) <= NEW.created_at
BEGIN SELECT RAISE(ABORT, 'Predictions cannot be made after kickoff.'); END;

-- Every graded selection, live and backtest, in one shape: y is 1 for a
-- win, w halves the weight of a half-won or half-lost quarter line.
-- Versioned by name: a changed definition is a new view, never a rewrite.
CREATE VIEW IF NOT EXISTS scored_predictions_v1 AS
SELECT 'backtest' AS source, b.match_id, m.kickoff_utc, se.competition_id, b.market, b.line, b.selection,
       b.model_key, b.model_version, b.confidence_band, b.probability AS p_raw, b.probability AS p,
       m.home_team_id, m.away_team_id,
       CASE WHEN b.outcome IN ('won', 'half_won') THEN 1 ELSE 0 END AS y,
       CASE WHEN b.outcome IN ('half_won', 'half_lost') THEN 0.5 ELSE 1 END AS w
FROM backtest_predictions b JOIN matches m ON m.id = b.match_id JOIN seasons se ON se.id = m.season_id
WHERE b.outcome IN ('won', 'lost', 'half_won', 'half_lost')
UNION ALL
SELECT 'live', p.match_id, m.kickoff_utc, se.competition_id, mk.market_type_key, mk.line, s.key,
       r.prob_model_key, r.prob_model_version, p.confidence_band, p.model_probability,
       COALESCE(p.calibrated_probability, p.model_probability),
       m.home_team_id, m.away_team_id,
       CASE WHEN g.outcome IN ('won', 'half_won') THEN 1 ELSE 0 END,
       CASE WHEN g.outcome IN ('half_won', 'half_lost') THEN 0.5 ELSE 1 END
FROM predictions p
JOIN analysis_runs r ON r.id = p.analysis_run_id
JOIN selections s ON s.id = p.selection_id JOIN markets mk ON mk.id = s.market_id
JOIN matches m ON m.id = p.match_id JOIN seasons se ON se.id = m.season_id
JOIN prediction_grades g ON g.id = (SELECT MAX(id) FROM prediction_grades WHERE prediction_id = p.id)
WHERE p.superseded_by IS NULL AND g.outcome IN ('won', 'lost', 'half_won', 'half_lost');

-- =================================================================
-- Phase 5: bankroll tools.
-- Optional. One bankroll per currency. Settings are dated rows; the ledger
-- is append-only (a mistake is corrected with an opposite entry).
-- =================================================================

CREATE TABLE IF NOT EXISTS bankroll_settings (
  id               INTEGER PRIMARY KEY,
  user_id          TEXT NOT NULL,
  currency         TEXT NOT NULL,
  starting_minor   INTEGER NOT NULL CHECK (starting_minor >= 0),
  started_at       TEXT NOT NULL,     -- bets placed before this do not count
  method           TEXT NOT NULL CHECK (method IN ('flat', 'percent', 'unit')),
  amount           REAL NOT NULL,     -- flat: cents; percent: % of balance; unit: cents per unit
  max_exposure_pct REAL NOT NULL DEFAULT 25,
  effective_from   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bankroll_settings_user_idx ON bankroll_settings(user_id, currency, effective_from);

CREATE TABLE IF NOT EXISTS bankroll_ledger (
  id           INTEGER PRIMARY KEY,
  user_id      TEXT NOT NULL,
  currency     TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('deposit', 'withdrawal')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  at           TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bankroll_ledger_user_idx ON bankroll_ledger(user_id, currency, at);
CREATE TRIGGER IF NOT EXISTS bankroll_ledger_immutable BEFORE UPDATE ON bankroll_ledger
BEGIN SELECT RAISE(ABORT, 'Ledger entries cannot be changed; add a correcting entry.'); END;
CREATE TRIGGER IF NOT EXISTS bankroll_ledger_no_delete BEFORE DELETE ON bankroll_ledger
BEGIN SELECT RAISE(ABORT, 'Ledger entries cannot be deleted; add a correcting entry.'); END;

-- Everything the provider covers, refreshed weekly, so Settings can offer
-- any league or cup. Switching one on copies it into competitions.
CREATE TABLE IF NOT EXISTS provider_leagues (
  source_key   TEXT NOT NULL,
  source_ref   INTEGER NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT,                 -- League / Cup
  country_name TEXT,
  country_code TEXT,
  logo_url     TEXT,
  flag_url     TEXT,
  season_year  INTEGER,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (source_key, source_ref)
);

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
  ordinal          INTEGER NOT NULL
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

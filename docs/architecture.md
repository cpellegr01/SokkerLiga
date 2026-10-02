# SokkerLiga — architecture

Design for `docs/product-spec.md`, revised 2026-10-01 after Claudio's scope
decisions:

1. **Same stack as SAM**: Node 22, Vite, React, SQLite via `node:sqlite`,
   plain JavaScript.
2. **No odds feed**: football data only.
3. **API-Football is the only data source.**
4. **Recommendations, not betting**: SokkerLiga never places bets. Claudio
   bets in a separate betting app, then **records the bet in SokkerLiga by
   hand**, with the odds taken. SokkerLiga settles it from the result and
   keeps the betting history.

So SokkerLiga is: a football knowledge base that refreshes itself; a Match
Center; an analysis that produces versioned predictions and recommendations;
a log of bets entered by hand; and two scorecards — **Model Performance**
(were the predictions right?) and **Betting History** (how have the bets
done?).

Contents

1. System architecture
2. Database schema
3. Data-provider interface
4. Data sources
5. Ingestion pipeline
6. Analysis pipeline
7. Bets and settlement
8. Routes and UI
9. Roadmap

---

## 1. System architecture

### Processes

```
 browser ──https──► Caddy ──forward_auth──► Conforza front door (8787)  sign-in
                      │
                      ├── /api/*  ──► sokkerliga        (8789)  API server
                      └── /*      ──► /srv/sokkerliga/dist      built React UI

 sokkerliga-worker  (no port)  scheduler + jobs: data refresh, model fitting,
                               analysis runs queued from the UI, settlement
                       │
                       ▼
            /var/lib/sokkerliga/sokkerliga.db   (SQLite, WAL mode)
```

- **API server** — `server/index.mjs`, `node:http`, loopback only. Reads the
  signed-in user from the front door's `X-Conforza-User-*` headers (already
  built). Serves reads, bet entry and settings, and *queues* slow work.
- **Worker** — `server/worker.mjs`, a second systemd unit on the same code.
  Owns everything slow or scheduled: provider calls, model fitting, Claude
  calls, grading and settlement. A slow provider or a long analysis never
  blocks a page, and a crash in one process does not take down the other.
- **One SQLite file** in WAL mode (`journal_mode=WAL`, `busy_timeout=5000`,
  `foreign_keys=ON`). The API reads while the worker writes; one writer at a
  time suits a single-user app with one worker. Writes are batched in a
  transaction per job step.
- **Authentication** is the front door's. The front-door user id is stored
  on bets, favourites and settings, so a second user needs no schema change.
- **Secrets** (API-Football key, Anthropic key) live in
  `/etc/sokkerliga/sokkerliga.env` (0600, root), loaded by systemd via
  `EnvironmentFile=` — the SAM pattern. Never in the repo, never sent to the
  browser. Settings shows only whether a provider is configured.

### Why SQLite holds up

8 competitions × ~400 matches ≈ 3,200 matches a season. With events,
lineups, team and player statistics a season is roughly 150k–250k rows, so
ten seasons stay comfortably within what SQLite handles well. Bets entered
by hand add a negligible amount. Analytics use SQLite's window functions,
CTEs and JSON functions. Backups use `VACUUM INTO` (as SAM does), which is
safe on a live database.

### Code layout

```
server/
  index.mjs              API server (routing, as in SAM)
  worker.mjs             scheduler loop + job runner
  db.mjs                 open, pragmas, schema, seeds, migrations
  schema.sql             tables, indexes, views, immutability triggers
  seed/*.json            master data: competitions, markets, statuses, stat types
  providers/             one module per source, all implementing §3
    api-football.mjs
  ingest/                provider records → database rows (idempotent)
  features/              as-of feature builder (no look-ahead)
  models/                probability engines (Dixon–Coles, rate models, …)
  markets/               market definitions; pricing from a scoreline matrix
  odds.mjs               decimal / American / fractional conversion
  ai/                    AI service abstraction + Claude adapter
  recommend/             thresholds, Recommend / Pass
  grading/               one rule set per market: grades predictions and bet legs
  bets/                  recording bets, parlays, settlement, P/L
  analytics/             model performance and betting history queries
  jobs/                  job definitions (one file per job type)
src/                     React UI (Vite), as in SAM
test/                    node:test suites, as in SAM
```

Dependencies stay minimal: `react`, `react-dom`, and `@anthropic-ai/sdk`
(SAM already uses it). Provider HTTP uses Node's built-in `fetch`. Charts are
hand-built SVG components, as SAM's diagrams are.

---

## 2. Database schema

### Conventions

- Primary keys: `INTEGER PRIMARY KEY` for high-volume tables, `TEXT` keys for
  master data (`market_types.key = 'over_under'`).
- Times: ISO-8601 UTC text. Kickoff is always UTC; the UI converts.
- Money: integer **minor units** (cents) plus a currency code. No floats for
  money.
- Odds: `REAL` decimal odds, plus the text and format exactly as typed
  (`'+150'`, `'6/4'`).
- **Provenance**: every imported fact row carries `source_key`
  (→ `data_sources`), `source_ref` (the provider's id) and `fetched_at`. A
  unique index on `(source_key, source_ref)` makes imports idempotent.
- **Identity mapping**: internal ids are ours; `external_ids` maps every
  provider's id to them, so two providers describing one team resolve to one
  row.
- **History is never overwritten.** Three mechanisms:
  1. *Append-only tables* (predictions, analysis runs, feature snapshots,
     grades, settlements): no `UPDATE` or `DELETE`, enforced by triggers.
  2. *Revisions* for facts a provider can correct (results, statistics): the
     current row may change, but the old values are first copied to a
     `*_revisions` table with the time and reason. The feature builder reads
     them to know what was known *when*.
  3. *Validity ranges* for slowly changing facts (rosters, injuries,
     managers): `valid_from` / `valid_to`, closed rather than deleted.
     Standings are stored as a dated series.

### Reference and sourcing

| Table | Key columns |
|---|---|
| `data_sources` | `key`, `name`, `terms_url`, `licence_notes`, `is_enabled` |
| `external_ids` | `entity_type`, `entity_id`, `source_key`, `source_ref`; unique `(entity_type, source_key, source_ref)` |
| `raw_payloads` | `id`, `source_key`, `endpoint`, `params_json`, `fetched_at`, `http_status`, `body_gz` (BLOB), `sha256` — every provider response, compressed, so ingestion can be replayed after a fix without spending API quota |
| `countries` | `code`, `name`, `flag_url` |
| `images` | `id`, `entity_type`, `entity_id`, `kind` (logo/photo), `url`, `source_key`, `licence_note` |

### Competitions, teams, players

| Table | Key columns |
|---|---|
| `competitions` | `id`, `key`, `name`, `country_code`, `kind` (league/cup/continental), `is_enabled`, `ordinal` — seeded with the 8 initial competitions; more can be enabled in Settings |
| `seasons` | `id`, `competition_id`, `label` (`2026/27`), `start_date`, `end_date`, `is_current` |
| `stages` | `id`, `season_id`, `name` (Regular season, Group A, Round of 16…) |
| `venues` | `id`, `name`, `city`, `country_code`, `capacity`, `surface`, provenance |
| `teams` | `id`, `name`, `short_name`, `code`, `country_code`, `founded`, `venue_id`, provenance |
| `managers` | `id`, `name`, `nationality`, `birth_date`, provenance |
| `team_managers` | `team_id`, `manager_id`, `valid_from`, `valid_to` |
| `players` | `id`, `name`, `first_name`, `last_name`, `birth_date`, `nationality`, `height_cm`, `preferred_foot`, `position`, provenance |
| `team_rosters` | `team_id`, `player_id`, `season_id`, `shirt_number`, `position`, `valid_from`, `valid_to` |
| `standings` | `id`, `stage_id`, `team_id`, `as_of`, `position`, `played`, `won`, `drawn`, `lost`, `goals_for`, `goals_against`, `points`, `form`, home/away splits — one row set per `as_of`, so the table at any past date can be read back |

### Matches

| Table | Key columns |
|---|---|
| `matches` | `id`, `season_id`, `stage_id`, `round`, `kickoff_utc`, `venue_id`, `home_team_id`, `away_team_id`, `status_key` (scheduled/live/finished/postponed/abandoned/cancelled/awarded), `home_goals`, `away_goals`, `home_ht`, `away_ht`, `extra_time`, `penalties_home`, `penalties_away`, `referee`, `attendance`, `result_confirmed_at`, provenance |
| `match_revisions` | `match_id`, `changed_at`, `reason`, `old_json` — kickoff moves, score corrections |
| `match_events` | `id`, `match_id`, `minute`, `extra_minute`, `team_id`, `player_id`, `assist_player_id`, `type_key` (goal/own_goal/penalty_goal/missed_penalty/yellow/second_yellow/red/sub/var), `detail`, provenance |
| `lineups` | `match_id`, `team_id`, `formation`, `status` (probable/confirmed), `fetched_at` — both kept |
| `lineup_players` | `match_id`, `team_id`, `player_id`, `role` (starter/sub), `position`, `grid`, `shirt_number`, `minutes_played` |
| `availability` | `id`, `player_id`, `team_id`, `match_id` (nullable), `status` (injured/suspended/doubtful/international_duty), `reason`, `valid_from`, `valid_to`, provenance |

### Statistics

| Table | Key columns |
|---|---|
| `stat_types` | `key`, `name`, `unit`, `scope` (team/player), `description` — seeded: shots, shots_on_target, xg, possession, corners, fouls, offsides, yellow, red, saves, passes, pass_accuracy, … |
| `team_match_stats` | `match_id`, `team_id`, `stat_key`, `value`, provenance — long format, so a new provider statistic is a seed row, not a schema change |
| `team_match_stats_revisions` | old values with `changed_at` |
| `player_match_stats` | `match_id`, `player_id`, `team_id`, `minutes`, `rating`, `goals`, `assists`, `shots`, `shots_on_target`, `xg`, `xa`, `key_passes`, `tackles`, `saves`, `goals_conceded`, `yellow`, `red`, `extra_json`, provenance — wide, because these are queried constantly |
| `team_season_stats` | per team, season and home/away split; **rebuilt from match rows**, never imported as truth |

### Markets

| Table | Key columns |
|---|---|
| `market_types` | `key` (match_result, draw_no_bet, double_chance, over_under, btts, asian_handicap, european_handicap, team_total, corners_ou, cards_ou, anytime_scorer, player_shots, player_sot), `name`, `has_line`, `settles_on` (goals/corners/cards/player_stat), `period` (FT/1H) |
| `markets` | `id`, `match_id`, `market_type_key`, `line`, `team_id`, `player_id` — unique per combination |
| `selections` | `id`, `market_id`, `key` (home/draw/away/over/under/yes/no) |

Predictions and bet legs both point at a `selection`, so a bet on "Arsenal
−0.75" and the model's view of "Arsenal −0.75" line up exactly.

### Predictions (all append-only)

| Table | Key columns |
|---|---|
| `models` | `key`, `name`, `version`, `kind` (statistical/llm/calibrator), `params_json`, `created_at` |
| `prompts` | `key`, `version`, `body`, `created_at` — prompt text is versioned data, not code |
| `feature_snapshots` | `id`, `match_id`, `as_of`, `builder_version`, `features_json`, `sha256`, `data_freshness_json` — exactly what the model and Claude saw |
| `analysis_runs` | `id`, `match_id`, `requested_at`, `completed_at`, `feature_snapshot_id`, `prob_model_key`, `prob_model_version`, `ai_model`, `prompt_key`, `prompt_version`, `status`, `error`, `input_tokens`, `output_tokens`, `cost_cents` |
| `predictions` | `id`, `analysis_run_id`, `match_id`, `selection_id`, `model_probability`, `calibrated_probability`, `fair_odds` (1 ÷ p), `confidence_score`, `confidence_band` (low/medium/high), `created_at`, `superseded_by` |
| `prediction_factors` | `prediction_id`, `direction` (for/against), `factor_key`, `label`, `evidence_json`, `weight` |
| `recommendations` | `id`, `analysis_run_id`, `prediction_id`, `decision` (recommend/pass), `pass_reasons_json`, `thresholds_json` (the thresholds in force), `reasoning_summary`, `created_at` |
| `ai_explanations` | `analysis_run_id`, `summary`, `body_md`, `data_gaps_json` |
| `prediction_grades` | `id`, `prediction_id`, `outcome` (won/lost/push/void/half_won/half_lost), `source` (auto/manual), `reason`, `graded_at` — latest row is current, earlier rows are the audit trail |

**Immutability triggers** (in `schema.sql`):
- `predictions`, `prediction_factors`, `recommendations`, `feature_snapshots`,
  completed `analysis_runs`, `prediction_grades`: `BEFORE UPDATE` and
  `BEFORE DELETE` raise an error. The only allowed update is setting
  `predictions.superseded_by` *before kickoff*, when the match is
  re-analysed.
- `BEFORE INSERT` on `predictions` refuses a match whose kickoff has passed.
  A prediction made after the fact is impossible by construction.

### Bets (entered by hand)

| Table | Key columns |
|---|---|
| `sportsbooks` | `key`, `name`, `currency` — the betting apps Claudio uses, managed in Settings |
| `bets` | `id`, `user_id`, `placed_at` (when placed in the betting app; defaults to now), `sportsbook_key`, `kind` (single/parlay), `stake_minor`, `currency`, `total_odds`, `potential_payout_minor`, `notes`, `created_at`, `deleted_at` (soft delete, for typos) |
| `bet_legs` | `id`, `bet_id`, `match_id`, `selection_id`, `odds_taken` (decimal), `odds_text`, `odds_format`, `prediction_id` (nullable), `recommendation_id` (nullable), `model_probability_at_bet`, `fair_odds_at_bet`, `edge_at_bet`, `ev_at_bet` |
| `bet_revisions` | `bet_id`, `changed_at`, `old_json`, `reason` — editing a bet (wrong stake typed) keeps the old version |
| `settlements` | append-only: `id`, `bet_leg_id` or `bet_id`, `outcome` (won/lost/push/void/half_won/half_lost/pending), `source` (auto/manual), `reason`, `settled_at`, `profit_minor` — latest row is current |
| `recommendation_thresholds` | `user_id`, `min_confidence`, `min_probability`, `min_fair_odds` (keeps near-certainties out; default 1.30), `max_fair_odds`, `markets_json`, `effective_from` — dated rows |

The `*_at_bet` columns are copied at the moment the bet is recorded, from
the latest prediction made **before both `placed_at` and kickoff**. If the
analysis is re-run later, the bet still shows what the model said when the
bet was made.

### Performance and operations

| Table | Key columns |
|---|---|
| `model_performance` | `id`, `model_key`, `model_version`, `computed_at`, `segment_json` (competition/market/confidence band/team), `n`, `brier`, `log_loss`, `accuracy`, `calibration_json` (predicted vs observed per bucket) — dated snapshots |
| `jobs` | `key`, `schedule`, `is_enabled`, `next_run_at`, `locked_until` |
| `job_runs` | `id`, `job_key`, `source_key`, `started_at`, `finished_at`, `status`, `records_in`, `records_upserted`, `requests_used`, `error`, `next_run_at` |
| `provider_quota` | `source_key`, `day`, `requests_used`, `limit` |
| `user_favourites` | `user_id`, `entity_type` (competition/team), `entity_id` |
| `bankroll_settings`, `bankroll_ledger` | optional, Phase 5: starting bankroll, flat / % / unit staking, deposits and withdrawals |

---

## 3. Data-provider interface

Plain JavaScript modules with a documented shape (JSDoc), checked by a
contract test every provider must pass. A provider declares its
capabilities; ingestion asks for a capability, never a provider by name.

```js
// server/providers/<name>.mjs
export default {
  key: 'api-football',
  capabilities: ['competitions', 'fixtures', 'results', 'lineups', 'events',
                 'team_stats', 'player_stats', 'injuries', 'standings', 'squads'],
  rateLimit: { perMinute: 300, perDay: 7500 },

  // Every method returns *normalised* records, each carrying
  // { sourceRef, fetchedAt, ...fields } — never provider-shaped JSON.
  async competitions(ctx) {},
  async fixtures(ctx, { competitionRef, seasonRef, from, to }) {},
  async matchDetail(ctx, { matchRef }) {},  // result, events, lineups, stats
  async playerStats(ctx, { matchRef }) {},
  async standings(ctx, { competitionRef, seasonRef }) {},
  async squad(ctx, { teamRef, seasonRef }) {},
  async injuries(ctx, { competitionRef, seasonRef, date }) {},
};
```

`ctx` supplies an HTTP client that stores every response in `raw_payloads`,
counts quota, applies the rate limit and retries with backoff. Providers
never touch the database; they map payloads to records and `server/ingest/`
writes them. That boundary is what lets a provider be added without
redesign. (An odds feed, if ever wanted, would be one more provider.)

Matching the same team or player across providers goes through
`external_ids`, with a review list in Settings for anything that cannot be
matched with certainty. Nothing is fuzzy-matched silently.

---

## 4. Data sources

| Source | Role | Cost | Notes |
|---|---|---|---|
| **API-Football** (api-sports.io) | The main source: competitions, fixtures, results, events, lineups, team and player match statistics, injuries, squads, standings, logos and photos | **Pro $19/month**, 7,500 requests/day. The free tier (100/day) covers past seasons only | Covers all 8 competitions. xG appears in match statistics for some competitions only; recorded when present, marked missing otherwise. Images are shown from the provider's servers, not redistributed. |
| ~~football-data.co.uk~~ | — | — | **Not used** (Claudio, 2026-10-01: API-Football only). The model is fitted on API-Football's own history. |
| **Anthropic API** | Claude for the written analysis | Usage-based | One call per Analyze Match; tokens and cost logged per run. |

Deliberately **excluded**: scraping FBref, Understat, Transfermarkt or
WhoScored (their terms forbid it, or the data is licensed from Opta, and
scrapers break without warning); enterprise feeds (Opta/Stats Perform);
odds feeds (not needed). Sportmonks is the fallback if API-Football's xG
coverage proves too thin.

Running cost: **$19/month** plus Claude usage. Claudio opens the accounts; the
keys go into `/etc/sokkerliga/sokkerliga.env`.

---

## 5. Ingestion pipeline

### Jobs

| Job | Schedule | Does |
|---|---|---|
| `sync_competitions` | weekly | competitions, seasons, stages |
| `sync_fixtures` | every 6 h | fixtures for the next 14 days and kickoff changes (kept in `match_revisions`) |
| `sync_squads` | daily | rosters (validity ranges), player profiles |
| `sync_injuries` | every 6 h; hourly on match days | availability |
| `sync_lineups` | from 75 min before kickoff, every 10 min | probable → confirmed lineups |
| `sync_results` | every 15 min while matches are live or just finished; final pass +6 h | result, events, team and player statistics; sets `result_confirmed_at` |
| `sync_standings` | after results, and daily | a new dated standings set |
| `grade_and_settle` | after each `sync_results` | grade predictions and settle recorded bets for finished matches (§7) |
| `refit_models` | nightly | refit ratings on finished matches only |
| `compute_performance` | nightly | `model_performance` snapshots |
| `backfill_history` | manual, from Settings | past seasons, paced to stay inside the daily quota |
| `backup` | nightly 03:40 | `VACUUM INTO`, gzip, keep 14 (SAM's script) |

Request budget: a normal week across 8 competitions is about 80 matches.
Results, statistics, lineups and events for all of them, plus fixtures,
injuries and standings, come to a few hundred requests a day, far inside
7,500. Backfilling a past season takes about 800–1,000 requests per
competition, so a full backfill runs over a few days at a deliberately
gentle pace.

### Guarantees

- **Idempotent**: every write is an upsert keyed on `(source_key,
  source_ref)` or a natural key; running a job twice changes nothing.
  Changes to existing facts go through revisions (§2), never a blind
  overwrite.
- **Resilient**: errors are caught per item, so one bad fixture does not
  fail a job. Retries with exponential backoff on 429/5xx. A job that keeps
  failing is flagged in Settings while the others carry on. Quota is checked
  *before* a call; the scheduler defers work rather than exceeding the plan.
- **Replayable**: raw responses are stored compressed, so a normalisation
  bug is fixed by re-processing, not re-fetching.
- **Locked**: one run of a job at a time (`jobs.locked_until`).
- **Logged**: `job_runs` records provider, records in and written, requests
  used, errors and next run. Settings → Data sync shows the last successful
  sync per job and lets a job be run now.

---

## 6. Analysis pipeline

Five stages, each storing its output, so any one can be swapped or re-run.

```
1 collect     ingestion (§5)              → normalised tables
2 features    features/build(match, asOf) → feature_snapshots
3 probability models/<engine>(features)   → probability per selection
4 explain     ai/<adapter>(packet)        → factors for/against, narrative, data gaps
5 recommend   recommend(predictions, thresholds) → Recommend / Pass
```

### 2 — Features, without look-ahead

`build(matchId, asOf)` is the only door to the data for prediction, and
every query in it is filtered by `asOf`:

- matches kicked off before `asOf`, with results confirmed by `asOf` and
  revisions applied as of that time;
- availability, rosters, managers and standings valid at `asOf`;
- model ratings fitted only on matches before `asOf`.

Analyze Match uses `asOf = now`; backtests use `asOf = kickoff − N hours`,
through the **same function**. A test seeds a match with its own result and
asserts the result cannot appear in its features. That test, not code
review, is what prevents leakage. Recorded bets are **never** an input to
features.

Features: form over 5 and 10 matches (points, goals, xG, shots, shots on
target), split home/away; opponent-adjusted attack and defence ratings;
head-to-head (last 6 meetings, with their age); rest days and matches in the
last 14 days; league position and points gap; expected or confirmed lineup
against the usual XI (minutes-weighted); missing players weighted by their
share of team minutes, goals and xG; goalkeeper save rate (and goals
prevented where xG exists); share of goals from set pieces; corner and card
rates, with the referee's card rate when known. Each feature records how
fresh it is.

### 3 — Probabilities (the statistical engine, not the LLM)

- **Goals model**: Dixon–Coles (a Poisson model of each side's goals with a
  correction for low scores), with time-decayed attack and defence ratings
  per team and a home-advantage term per competition, refitted nightly. It
  produces a **probability for every scoreline**, from which each goals
  market follows exactly: 1X2, Draw No Bet, Double Chance, Over/Under at any
  line, BTTS, Asian and European handicaps (including quarter lines), team
  totals.
- **Corners and cards**: count models (negative binomial) from team rates,
  opponent rates and, for cards, the referee's rate.
- **Player markets**: anytime scorer from the player's share of team xG (or
  of shots and goals where xG is missing) × chance of playing × expected
  minutes, against the team's expected goals from the goals model. Player
  shots and shots on target the same way. Offered only when the data covers
  the player.
- **Calibration** (Phase 4): isotonic calibration per market family, fitted
  only on predictions graded before `asOf`. Raw and calibrated probabilities
  are both stored.
- **Confidence** is calculated, not chosen by the LLM: from data
  completeness (lineups confirmed? xG present? enough matches?), model
  uncertainty, and how well calibrated that kind of prediction has been.

Each prediction shows its **fair odds** (1 ÷ probability) — "worth backing
at 2.10 or better". With no odds feed, this is how a recommendation is
compared with the price in the betting app before betting.

The `models` table is the registry: a new engine (Elo, a learned model, an
external model) is a new module and key, and old predictions keep the
version that made them.

### 4 — Explanation (Claude)

`ai/` exposes one interface:

```js
explain({ packet, predictions }) → {
  factorsFor: [...], factorsAgainst: [...], summary, narrative, dataGaps: [...]
}
```

The Claude adapter sends a compact, structured **match-analysis packet**
(typically 3–6k tokens): the feature snapshot, the model's probabilities and
the relevant history — never whole tables. The reply is forced into that
JSON shape with tool use. Prompt text is stored in `prompts` with a version;
each run records the model name, prompt version and token cost.

Claude **interprets and explains**; it does not set probabilities. It can
raise concerns the model misses (a key player out, an odd fixture context),
which appear as factors against and can lower the *displayed* confidence,
but the numbers stay the model's. A different LLM, or none, is a different
adapter.

### 5 — Recommendation

Each prediction becomes **Recommend** only if it passes every threshold in
force — minimum confidence, minimum probability, maximum fair odds, enabled
markets. Otherwise it is **Pass**, with the failing rules listed. The
thresholds are copied into the recommendation, so changing settings later
never rewrites history.

### Learning from history, honestly

Past results feed future predictions only through **model refits on match
data** and **calibration** — never through "this bet won, do more like it".
The scorecards keep four questions apart:

| Question | Measure |
|---|---|
| Were the probabilities right? | Brier score, log loss, calibration (Model Performance) |
| Was the price good? | Odds taken vs the model's fair odds at bet time |
| Was the decision sound? | Edge and EV at bet time; whether the bet followed a Recommend |
| Did it win? | Profit/loss — reported, never used to judge the other three |

A sound bet can lose and a poor-value bet can win; Betting History shows
both so luck isn't mistaken for skill.

---

## 7. Bets and settlement

### Recording a bet

After betting in the betting app, Claudio opens SokkerLiga and records it —
from the Match Center ("I bet this" on a prediction, which fills in the
match, market and selection) or from My Bets. Fields: betting app, legs
(match, market, line, selection), odds taken in any format (`2.50`, `+150`,
`6/4` — stored as decimal plus what was typed), stake, when it was placed
(defaults to now), notes. Payout is shown before saving. Parlays multiply
the leg odds.

On saving, each leg is linked to the model's latest prediction from before
the bet and kickoff, and the model probability, fair odds, **edge** (model
probability − 1 ÷ odds taken) and **EV** (`p × (odds − 1) − (1 − p)` per
unit) are frozen onto the leg. Typos can be fixed; the previous version is
kept in `bet_revisions`.

### Grading and settlement

`grading/grade.mjs` is a pure function, `grade(market, line, selection,
facts)`, with one rule set per market type and exhaustive tests. It grades
both predictions and bet legs, so the two can never disagree:

- 1X2, Double Chance, Draw No Bet (draw → push), BTTS, team totals,
  Over/Under (whole line hit exactly → push), European handicap (three-way),
  **Asian handicap** including half and quarter lines (a quarter line splits
  the stake in two: half_won / half_lost), corners and cards totals, anytime
  scorer (own goals don't count; player didn't play → void), player shots
  and shots on target (didn't play → void).
- Regular time only, unless the market says otherwise.
- Postponed or abandoned → pending for 48 h, then void (the most common
  bookmaker rule), with the reason shown.
- Parlays: void legs drop out and the odds are recalculated; any lost leg
  loses the parlay; half results apply proportionally.

Settlement runs only once `result_confirmed_at` is set and writes a new
`settlements` row (`source = auto`). Betting apps' rules differ, so any
result can be corrected by hand: another row with `source = manual` and a
required reason. Nothing is overwritten; both are visible. Profit/loss comes
from the current settlement.

---

## 8. Routes and UI

### API (under `/api`, JSON; everything except `/health` needs the front door)

```
GET  /health
GET  /me
GET  /search?q=                        teams, players, matches, competitions
GET  /dashboard
GET  /competitions        GET /competitions/:id   (table, fixtures, results)
GET  /matches?date=&from=&to=&competition=&team=&country=&status=
GET  /matches/:id                      Match Center bundle
POST /matches/:id/analyze              queue an analysis run → { runId }
GET  /analysis-runs/:id                status and results
GET  /predictions?from=&to=&competition=&team=&market=&decision=&outcome=
GET  /predictions/:id                  with its frozen feature snapshot
POST /predictions/:id/grades           manual grade correction
GET  /bets?status=         POST /bets        GET /bets/:id
PUT  /bets/:id             DELETE /bets/:id  (soft)
POST /bets/:id/settlements             manual settlement correction
GET  /history?from=&to=&competition=&team=&market=&sportsbook=&kind=&followed=
GET  /performance?model=&market=&competition=&band=&from=&to=
GET  /teams/:id       GET /players/:id
POST /favourites      DELETE /favourites/:type/:id
GET  /settings/thresholds   PUT /settings/thresholds
GET  /sportsbooks           PUT /sportsbooks
GET  /sync/status     POST /sync/:job/run
```

### Screens

Navigation: **Dashboard · Matches · Predictions · My Bets · Betting History ·
Model Performance · Teams · Players · Leagues · Settings**, global search in
the top bar and a link back to the Conforza menu. Responsive down to phone
width (16px gutters; tables become cards) — bets are likely to be recorded
from a phone.

- **Dashboard**: today's matches, the next 7 days, top current
  recommendations, open bets, recently settled bets, profit/loss and ROI,
  recent prediction accuracy and calibration.
- **Matches**: date strip and filters (competition, team, country, status),
  favourites first.
- **Match Center**: header with crests, local kickoff time, venue,
  competition and positions. Tabs:
  - *Overview*: form strips, home/away records, goals and xG bars.
  - *Head-to-head*.
  - *Lineups & availability*.
  - *Players*: key players and recent statistics.
  - *Analysis*: Analyze button; probability and fair odds per market;
    factors for and against; Recommend / Pass cards, each with **"I bet
    this"**; Claude's written analysis and its data gaps; run time and
    versions.
- **Predictions**: every prediction with its grade, filters, and its frozen
  inputs.
- **My Bets**: open and settled bets; record a bet (single or parlay); fix a
  typo; correct a settlement with a reason.
- **Betting History**: totals (bets, won, lost, pushed, win rate, staked,
  returned, net profit, ROI, average odds, average edge) and breakdowns by
  competition, team, market, betting app, confidence band, odds range, and
  over time; filters for all of these plus "followed a recommendation or
  not".
- **Model Performance**: reliability diagram (predicted vs observed per
  bucket, with counts), Brier and log-loss trend, breakdowns by market,
  competition, confidence band, team and model version, hit rate of
  Recommend vs Pass.
- **Teams / Players / Leagues**: profiles as specified; team pages include
  how predictions and bets involving the team have fared.
- **Settings**: competitions enabled, favourites, recommendation thresholds,
  betting apps and currency, data sync status and manual runs,
  entity-matching review, provider status (configured or not; keys are
  never shown).

Logos and photos load from the provider where its terms allow, with an
initials badge as fallback.

---

## 9. Roadmap

Each phase ends deployed and verified at sokkerliga.conforza.tech.

**Phase 0 — groundwork**
- Claudio: API-Football Pro account; Anthropic key. Both go into
  `/etc/sokkerliga/sokkerliga.env`.
- Worker systemd unit `sokkerliga-worker`; nightly backups.

**Phase 1 — knowledge base and Match Center**
- Schema for reference data, competitions, teams, players, rosters, matches,
  events, lineups, availability and statistics, with provenance, revisions
  and raw payloads; job tables; seeds for the 8 competitions.
- Provider contract and the API-Football provider; jobs for competitions,
  fixtures, results, squads, injuries, standings and lineups; Settings →
  Data sync.
- App shell with full navigation, search and favourites.
- Matches, Match Center (overview, head-to-head, lineups, availability,
  players), Team, Player and League pages.
- Backfill of the current and previous seasons.

**Phase 2 — statistics and analysis**
- Team and player match statistics; derived season statistics.
- Feature builder with the leakage tests; Dixon–Coles goals model with
  market pricing; corners and cards models.
- AI abstraction, Claude adapter, versioned prompts; analysis runs,
  immutable predictions, factors, recommendations with thresholds;
  Predictions screen and the Analysis tab.

**Phase 3 — bets and grading**
- Grading engine for every market, shared by predictions and bets.
- Recording bets (singles and parlays, any odds format), "I bet this" from
  the Analysis tab, values frozen at bet time; automatic settlement with
  manual correction; My Bets; Betting History.

**Phase 4 — performance and calibration**
- Model Performance (Brier, log loss, reliability diagrams, breakdowns by
  segment and version); calibration layer; confidence informed by
  calibration history.

**Phase 5 — depth**
- Optional bankroll tools (starting bankroll, flat / % / unit staking,
  exposure across open bets — never scaling stakes on recent results).
- Player markets, more competitions, schedules tuned to quota, better models
  (e.g. a learned model trained on the stored feature snapshots), and a
  question page over SokkerLiga's own history: "How accurate have our
  Premier League Over 2.5 predictions been?"

# SokkerLiga — architecture

Design for `docs/product-spec.md`. Written 2026-10-01, before any application
code.

**No odds feed** (Claudio, 2026-10-01): SokkerLiga subscribes to football
data only. Odds enter the system only when Claudio types them — on the bet
slip, or as a price to evaluate on a match's Analysis tab. Everything below
reflects that; an odds provider can be added later through the same provider
interface without schema changes. Stack: Node 22, Vite, React, SQLite via `node:sqlite`, plain JavaScript —
the same as SAM, by Claudio's decision.

Contents

1. System architecture
2. Database schema
3. Data-provider interfaces
4. Recommended data and odds sources
5. Ingestion pipeline
6. AI analysis pipeline
7. Bet tracking and settlement
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

 sokkerliga-worker  (no port)  scheduler + jobs: ingestion, odds, settlement,
                               model fitting, AI runs queued from the UI
                       │
                       ▼
            /var/lib/sokkerliga/sokkerliga.db   (SQLite, WAL mode)
```

- **API server** — `server/index.mjs`, `node:http`, loopback only. Reads the
  signed-in user from the front door's `X-Conforza-User-*` headers (already
  built). Handles reads, bet entry, settings, and *queues* slow work.
- **Worker** — `server/worker.mjs`, a second systemd unit on the same code.
  Owns everything slow or scheduled: provider calls, model fitting, Claude
  calls, settlement. Keeping it separate means a slow provider or a long AI
  run never blocks a page load, and a crash in one does not take down the
  other.
- **One SQLite file** in WAL mode (`journal_mode=WAL`, `busy_timeout=5000`,
  `foreign_keys=ON`). WAL lets the API read while the worker writes; there is
  one writer at a time, which suits a single-user app with one worker.
  Writes are batched in transactions per job step.
- **Authentication** is the front door's. SokkerLiga stores the front-door
  user id on bets and settings, so a second user could be added later
  without schema changes.
- **Secrets** (provider keys, Anthropic key) live in
  `/etc/sokkerliga/sokkerliga.env` (0600, root), loaded by systemd via
  `EnvironmentFile=` — the SAM pattern. Never in the repo, never sent to the
  browser. The UI shows only whether a provider is configured.

### Why SQLite holds up here

The volumes are small for SQLite: 8 competitions × ~400 matches per season ≈
3,200 matches per season; with events, team and player stats a season is
roughly 150k–250k rows. Odds are the biggest table; section 5 stores only
*changes*, which keeps it in the low millions of rows over years. Analytics
use SQLite's window functions, CTEs and JSON functions. Backups use
`VACUUM INTO` (as SAM does), which is safe on a live database.

### Code layout

```
server/
  index.mjs              API server (routing, as in SAM)
  worker.mjs             scheduler loop + job runner
  db.mjs                 open, pragmas, schema, seeds, migrations
  schema.sql             all tables, indexes, views, immutability triggers
  seed/*.json            master data: competitions, markets, statuses, …
  providers/             one module per source, all implementing §3
    api-football.mjs  football-data-uk.mjs
  ingest/                provider payload → normalised rows (idempotent)
  features/              as-of feature builder (no look-ahead)
  models/                probability engines (Dixon–Coles, rate models, …)
  markets/               market definitions, pricing from a scoreline matrix
  odds.mjs               conversions, de-vigging, consensus, CLV
  ai/                    AI service abstraction + Claude adapter + prompts
  recommend/             thresholds, EV, Pass logic
  bets/                  bet slip, staking, settlement engine
  analytics/             betting history and model performance queries
  jobs/                  job definitions (one file per job type)
src/                     React UI (Vite), as in SAM
test/                    node:test suites, as in SAM
```

Dependencies stay minimal: `react`, `react-dom`, and `@anthropic-ai/sdk` (as
SAM uses for its AI drafting). HTTP to providers uses Node's built-in
`fetch`. Charts are hand-built SVG components (SAM's diagrams set the
precedent), so no charting library is needed.

---

## 2. Database schema

### Conventions

- Primary keys: `INTEGER PRIMARY KEY` for high-volume tables, `TEXT` keys for
  master data (e.g. `market_type.key = 'over_under'`).
- Times: ISO-8601 UTC text (`2026-10-04T14:00:00Z`). Kickoff is always UTC;
  the UI converts.
- Money: integer **minor units** (cents) plus a currency code. No floats for
  money.
- Odds: `REAL` decimal odds; the original format and text are kept alongside
  when a person types them (`'+150'`, `'6/4'`).
- **Provenance**: every imported fact row carries
  `source_key` (→ `data_sources`), `source_ref` (the provider's id),
  `fetched_at`. A unique index on `(source_key, source_ref)` makes imports
  idempotent.
- **Identity mapping**: internal ids are ours; `external_ids` maps every
  provider's id to them. Two providers describing the same team resolve to
  one row.
- **History is never overwritten.** Three mechanisms:
  1. *Append-only tables* (odds snapshots, predictions, analysis runs, feature
     snapshots, settlement events): no `UPDATE`/`DELETE`, enforced by
     triggers.
  2. *Revisions* for facts that can be corrected by the provider (match
     result, statistics): the current row may change, but every change first
     copies the old values into a `*_revisions` table with the reason and the
     time. The feature builder reads revisions to see what was known *when*.
  3. *Validity ranges* for slowly changing facts (roster membership, injury
     status, standings): `valid_from` / `valid_to`, closed rather than
     deleted.

### Reference and sourcing

| Table | Key columns |
|---|---|
| `data_sources` | `key`, `name`, `kind` (stats/odds/historical), `terms_url`, `licence_notes`, `is_enabled` |
| `external_ids` | `entity_type`, `entity_id`, `source_key`, `source_ref`, unique `(entity_type, source_key, source_ref)` |
| `raw_payloads` | `id`, `source_key`, `endpoint`, `params_json`, `fetched_at`, `http_status`, `body_gz` (BLOB), `sha256` — every provider response, compressed, so ingestion can be replayed after a bug fix without spending API quota |
| `countries` | `code`, `name`, `flag_url` |
| `images` | `id`, `entity_type`, `entity_id`, `kind` (logo/photo), `url`, `source_key`, `licence_note`, `cached_path` |

### Competitions and structure

| Table | Key columns |
|---|---|
| `competitions` | `id`, `key`, `name`, `country_code`, `kind` (league/cup/continental), `is_enabled`, `is_favourite`, `tier`, `ordinal` — seeded with the 8 initial competitions, others addable |
| `seasons` | `id`, `competition_id`, `label` (`2026/27`), `start_date`, `end_date`, `is_current` |
| `stages` | `id`, `season_id`, `name` (Regular season, Group A, Round of 16…) |
| `venues` | `id`, `name`, `city`, `country_code`, `capacity`, `surface`, provenance |
| `teams` | `id`, `name`, `short_name`, `code`, `country_code`, `founded`, `venue_id`, `is_national`, `is_favourite`, provenance |
| `managers` | `id`, `name`, `nationality`, `birth_date`, provenance |
| `team_managers` | `team_id`, `manager_id`, `valid_from`, `valid_to` |
| `players` | `id`, `name`, `first_name`, `last_name`, `birth_date`, `nationality`, `height_cm`, `preferred_foot`, `position` (G/D/M/F), provenance |
| `team_rosters` | `team_id`, `player_id`, `season_id`, `shirt_number`, `position`, `valid_from`, `valid_to` |
| `standings` | `id`, `stage_id`, `team_id`, `as_of`, `position`, `played`, `won`, `drawn`, `lost`, `goals_for`, `goals_against`, `points`, `form`, home/away splits — **one row per team per `as_of`**, so the table at any past date can be read back |

### Matches

| Table | Key columns |
|---|---|
| `matches` | `id`, `season_id`, `stage_id`, `round`, `kickoff_utc`, `venue_id`, `home_team_id`, `away_team_id`, `status_key` (scheduled/live/finished/postponed/abandoned/cancelled/awarded), `home_goals`, `away_goals`, `home_ht`, `away_ht`, `went_to_extra_time`, `penalties_home`, `penalties_away`, `referee`, `attendance`, `result_confirmed_at`, provenance |
| `match_revisions` | `match_id`, `changed_at`, `reason`, `old_json` — kickoff moves, score corrections |
| `match_events` | `id`, `match_id`, `minute`, `extra_minute`, `team_id`, `player_id`, `assist_player_id`, `type_key` (goal/own_goal/penalty_goal/missed_penalty/yellow/second_yellow/red/sub/var), `detail`, provenance |
| `lineups` | `match_id`, `team_id`, `formation`, `status` (probable/confirmed), `fetched_at` — probable and confirmed are both kept |
| `lineup_players` | `match_id`, `team_id`, `player_id`, `role` (starter/sub), `position`, `grid`, `shirt_number`, `minutes_played` |
| `availability` | `id`, `player_id`, `team_id`, `match_id` (nullable), `status` (injured/suspended/doubtful/international_duty), `reason`, `valid_from`, `valid_to`, provenance |

### Statistics

| Table | Key columns |
|---|---|
| `stat_types` | `key`, `name`, `unit`, `scope` (team/player), `description` — seeded: shots, shots_on_target, xg, possession, corners, fouls, offsides, yellow, red, saves, passes, pass_accuracy, … |
| `team_match_stats` | `match_id`, `team_id`, `stat_key`, `value`, provenance — long format, so a new provider stat needs a seed row, not a schema change |
| `team_match_stats_revisions` | old values with `changed_at` |
| `player_match_stats` | `match_id`, `player_id`, `team_id`, `minutes`, `rating`, `goals`, `assists`, `shots`, `shots_on_target`, `xg`, `xa`, `key_passes`, `tackles`, `saves`, `goals_conceded`, `yellow`, `red`, `extra_json`, provenance — wide, because these columns are queried constantly |
| `team_season_stats` | derived per team per season and venue split; **rebuilt from match rows**, never imported as truth |

### Odds

| Table | Key columns |
|---|---|
| `bookmakers` | `key`, `name`, `region`, `is_sharp` (Pinnacle, Betfair exchange) |
| `market_types` | `key` (match_result, draw_no_bet, double_chance, over_under, btts, asian_handicap, european_handicap, team_total, corners_ou, cards_ou, anytime_scorer, player_shots, player_sot), `name`, `has_line`, `settles_on` (goals/corners/cards/player_stat), `period` (FT/1H) |
| `markets` | `id`, `match_id`, `market_type_key`, `line` (2.5, −0.75…), `team_id`, `player_id` — unique per combination |
| `selections` | `id`, `market_id`, `key` (home/draw/away/over/under/yes/no) |
| `odds_snapshots` | `id`, `selection_id`, `bookmaker_key`, `price` (decimal), `captured_at`, `source_key` (`manual` for now), `is_closing` — **append-only**. Today every row is a price Claudio entered; a future odds feed would write here too |

### Predictions and AI (all append-only)

| Table | Key columns |
|---|---|
| `models` | `key`, `name`, `version`, `kind` (statistical/llm/calibrator), `params_json`, `created_at` |
| `prompts` | `key`, `version`, `body`, `created_at` — prompt text is versioned data, not code |
| `feature_snapshots` | `id`, `match_id`, `as_of`, `builder_version`, `features_json`, `sha256`, `data_freshness_json` (age of each input) — the exact packet the model and the AI saw |
| `analysis_runs` | `id`, `match_id`, `requested_at`, `completed_at`, `feature_snapshot_id`, `prob_model_key`, `prob_model_version`, `ai_model`, `prompt_key`, `prompt_version`, `status`, `error`, `input_tokens`, `output_tokens`, `cost_cents` |
| `predictions` | `id`, `analysis_run_id`, `match_id`, `selection_id`, `model_probability`, `calibrated_probability`, `confidence` (low/medium/high + numeric), `created_at`, `locked_at`, `superseded_by` |
| `prediction_factors` | `prediction_id`, `direction` (for/against), `factor_key`, `label`, `evidence_json`, `weight` |
| `recommendations` | `id`, `prediction_id`, `odds_snapshot_id` (the price it was judged against), `implied_probability`, `fair_probability` (de-vigged), `edge`, `expected_value`, `decision` (bet/pass), `pass_reasons_json`, `thresholds_json` (thresholds in force), `reasoning_summary`, `created_at` |
| `ai_explanations` | `analysis_run_id`, `summary`, `body_md`, `data_gaps_json` |

**Immutability triggers** (in `schema.sql`):
- `predictions`, `prediction_factors`, `recommendations`, `feature_snapshots`,
  `analysis_runs` (once completed), `odds_snapshots`: `BEFORE UPDATE` and
  `BEFORE DELETE` raise an error. The only permitted update is setting
  `predictions.superseded_by` *before kickoff*.
- `BEFORE INSERT` on `predictions` refuses a match whose `kickoff_utc` has
  passed. A late re-run is impossible by construction, not by convention.

### Bets

| Table | Key columns |
|---|---|
| `sportsbooks` | `key`, `name`, `currency` (the user's books; may map to a `bookmakers` key for closing-odds lookup) |
| `bets` | `id`, `user_id`, `placed_at`, `sportsbook_key`, `kind` (single/parlay), `stake_minor`, `currency`, `total_odds`, `potential_payout_minor`, `notes`, `staking_method`, `created_at` |
| `bet_legs` | `id`, `bet_id`, `match_id`, `selection_id`, `odds_taken`, `odds_text`, `odds_format`, `recommendation_id` (nullable), `model_probability_at_bet`, `edge_at_bet`, `closing_odds`, `clv` |
| `settlements` | append-only: `id`, `bet_leg_id` *or* `bet_id`, `outcome` (won/lost/push/void/half_won/half_lost/pending), `source` (auto/manual), `reason`, `settled_at`, `profit_minor` — the latest row is current; earlier rows stay as the audit trail |
| `bankroll_settings` | `user_id`, `starting_minor`, `currency`, `staking_method` (flat/percent/units), `flat_minor`, `percent`, `unit_minor`, `effective_from` — dated rows, so stake advice can be replayed |
| `bankroll_ledger` | `id`, `user_id`, `at`, `kind` (deposit/withdrawal/stake/return/adjustment), `amount_minor`, `bet_id` |
| `recommendation_thresholds` | `user_id`, `min_confidence`, `min_edge`, `min_odds`, `max_odds`, `markets_json`, `effective_from` |

`half_won` / `half_lost` are needed for quarter-line Asian handicaps (−0.25,
+0.75…); the spec's five states cannot settle those correctly.

### Performance and operations

| Table | Key columns |
|---|---|
| `model_performance` | `id`, `model_key`, `model_version`, `computed_at`, `segment_json` (league/market/bucket), `n`, `brier`, `log_loss`, `accuracy`, `calibration_json` (per-bucket predicted vs observed), `roi`, `clv_mean` — snapshots, so you can see how the evaluation itself moved |
| `jobs` | `key`, `schedule` (cron-like), `is_enabled`, `next_run_at` |
| `job_runs` | `id`, `job_key`, `provider`, `started_at`, `finished_at`, `status`, `records_in`, `records_upserted`, `requests_used`, `error`, `next_run_at` |
| `provider_quota` | `source_key`, `day`, `requests_used`, `limit` |
| `user_favourites` | `user_id`, `entity_type`, `entity_id` |

---

## 3. Data-provider interfaces

Plain JavaScript modules with a documented shape (JSDoc), checked by a
contract test that every provider must pass. Each provider declares what it
can do; the ingestion layer asks for capabilities, never for a provider by
name.

```js
// server/providers/<name>.mjs
export default {
  key: 'api-football',
  kind: 'stats',                       // 'stats' | 'odds' | 'historical'
  capabilities: ['competitions', 'fixtures', 'results', 'lineups', 'events',
                 'team_stats', 'player_stats', 'injuries', 'standings', 'squads'],
  rateLimit: { perMinute: 300, perDay: 7500 },

  // All return *normalised* records, every one carrying
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

An odds provider would be a module with `kind: 'odds'` and an `odds()` method
writing to `odds_snapshots`. None is planned.

`ctx` gives the provider an HTTP client that records every response into
`raw_payloads`, counts quota, applies the rate limit, and retries with
backoff. Providers never touch the database directly; they map payloads to
records, and `server/ingest/` writes them. That boundary is what lets a new
provider be added without redesign.

Entity matching across providers (same team, different ids) goes through
`external_ids`, with a review queue in Settings for names that cannot be
matched automatically. No fuzzy match is applied silently.

---

## 4. Recommended data and odds sources

| Source | Role | Cost | Notes |
|---|---|---|---|
| **API-Football** (api-sports.io) | Primary stats provider: competitions, fixtures, results, events, lineups, team and player match stats, injuries, squads, standings, logos and photos | **Pro $19/mo**, 7,500 requests/day (free tier: 100/day, past seasons only) | Covers all 8 competitions. xG appears in fixture statistics for some competitions only; treat as optional and record when absent. Images are served by the provider; display, don't redistribute. |
| **football-data.co.uk** | Historical results and basic match stats (since 1993 and 2000) for fitting and backtesting the statistical model; its odds columns are ignored | Free | **Free for private individuals only.** Its terms also exclude "data training products using automated bots/scrapers/AI": files are downloaded by hand and imported, used only to fit and evaluate the statistical model, and **never sent to Claude**. Claudio to confirm that reading is acceptable before Phase 2. |
| Sportmonks (alternative) | Richer xG and pressure metrics | €29+/mo plus €24 xG add-on | Not needed at first. Worth adding as a second stats provider if xG coverage from API-Football proves thin. |
| Anthropic API | Claude for explanations | Usage-based | One call per Analyze Match. Cost and tokens logged per run. |
| ~~The Odds API~~ | Odds feed | — | **Not used** — Claudio needs football data only. |

Deliberately **excluded**: scraping FBref, Understat, Transfermarkt,
WhoScored or sportsbook websites. Their terms forbid it or the data is
licensed from Opta; scrapers also break without warning. Opta/Stats Perform
and Genius Sports are enterprise-priced.

Starting budget: **$19/month** plus Claude usage. The accounts must be
opened by Claudio; keys go into `/etc/sokkerliga/sokkerliga.env`.

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
| `sync_results` | every 15 min while matches are live or just finished; final pass +6 h | result, events, team and player stats; sets `result_confirmed_at` |
| `sync_standings` | after results, and daily | a new `as_of` standings row set |
| `settle_bets` | after each `sync_results` | auto-settlement (§7) |
| `refit_models` | nightly | refit ratings using only finished matches |
| `compute_performance` | nightly | `model_performance` snapshots |
| `backfill_history` | manual, from Settings | past seasons for model fitting, rate-limited to stay inside the daily quota |
| `backup` | nightly 03:40 | `VACUUM INTO`, gzip, keep 14 (SAM's script) |

### Guarantees

- **Idempotent**: every write is an upsert keyed on `(source_key,
  source_ref)` or a natural key; running a job twice changes nothing.
  Changes to existing facts go through the revision mechanism (§2), never a
  blind overwrite.
- **Resilient**: provider errors are caught per item; one bad fixture does
  not fail the job. Retries with exponential backoff on 429/5xx; a job that
  keeps failing is marked and shown in Settings → Data sync, the others keep
  running. Quota is checked *before* a call; the scheduler defers work rather
  than exceeding the plan.
- **Replayable**: raw responses are stored compressed, so normalisation bugs
  are fixed by re-processing payloads, not by re-fetching.
- **Locked**: one job of a type at a time (a lock row in `jobs`), so an
  overrunning job is not started twice.
- **Logged**: `job_runs` holds provider, records in/upserted, requests used,
  errors, next run. Settings → Data sync shows the last successful sync per
  job and provider.

---

## 6. AI analysis pipeline

Five separate stages; each stores its output, so any stage can be swapped or
re-run without touching the others.

```
1 collect     ingestion (§5)            → normalised tables
2 features    features/build(match, as_of) → feature_snapshots
3 probability models/<engine>(features) → model probabilities per selection
4 explain     ai/<adapter>(packet)      → factors for/against, narrative, data gaps
5 recommend   recommend(probabilities, odds, thresholds) → bet / pass, EV, edge
```

### 2 — Features, without look-ahead

`build(matchId, asOf)` is the only door to the data for prediction and every
query in it is filtered by `asOf`:

- matches with `kickoff_utc < asOf` and results whose `result_confirmed_at <=
  asOf` (with revisions applied as of that time);
- availability, rosters and standings valid at `asOf`;
- manually entered prices with `captured_at <= asOf`;
- model ratings fitted on matches before `asOf`.

The live Analyze button uses `asOf = now`; backtests use `asOf = kickoff −
N hours`, through the **same function**. A test suite seeds a match
together with its own result and asserts the result cannot appear in its
features. That test is how leakage is prevented, not code review.

Features include: form over 5/10 matches (points, goals, xG, shots, shots on
target) split home/away; opponent-adjusted attack and defence ratings;
head-to-head (last 6 meetings, with the age of each); rest days and matches
in the last 14 days; league position and points gap; expected and confirmed
lineups vs. the usual XI (minutes-weighted); missing players weighted by
their share of team minutes, goals and xG; goalkeeper save rate and goals
prevented where xG exists; set-piece share of goals; corners and cards rates
(with referee card rate when known). Each feature records its freshness.

### 3 — Probabilities (the statistical engine, not the LLM)

- **Goals model**: Dixon–Coles bivariate Poisson with time-decayed attack and
  defence ratings per team, a home-advantage term per competition, refitted
  nightly. It yields a **scoreline probability matrix** from which every
  goal market is priced exactly: 1X2, Draw No Bet, Double Chance,
  Over/Under at any line, BTTS, Asian and European handicaps (including
  quarter lines), team totals.
- **Corners and cards**: negative-binomial rate models from team rates,
  opponent rates and (for cards) referee rate.
- **Player markets**: anytime scorer from the player's share of team xG (or
  shots and goals where xG is missing) × probability of playing × expected
  minutes, against the goals model's team expected goals. Shots and shots on
  target by the same rate approach. Offered only when data covers the player.
- **Market benchmark**: when Claudio enters prices for every outcome of a
  market, the bookmaker margin is removed and the fair probability stored
  beside the model's.
- **Calibration** (Phase 4): isotonic calibration per market family, fitted
  *only* on predictions settled before `asOf`. Raw and calibrated
  probabilities are both stored.
- **Confidence** is computed, not chosen by the LLM: from data completeness
  (lineups confirmed? xG present? sample size), model uncertainty (rating
  variance), and the historical calibration of that market bucket.

The model registry (`models` table) means a new engine — Elo, gradient-boosted
model, an external model — is a new module and a new key; old predictions keep
the version that made them.

### 4 — Explanation (Claude)

`ai/` exposes one interface:

```js
explain({ packet, probabilities, marketContext }) → {
  factorsFor: [...], factorsAgainst: [...], summary, narrative, dataGaps: [...]
}
```

The Claude adapter sends a compact, structured **match-analysis packet**
(typically 3–6k tokens): the feature snapshot, model probabilities, any
prices entered, and the relevant history — never whole tables. Output is forced into
that JSON shape with tool use. Prompt text is stored in `prompts` with a
version; every run records model name, prompt version and token cost.

Claude **interprets and explains**; it does not set the probabilities. It may
flag concerns (a key player missing that the model under-weights), which are
shown as factors and can lower *displayed* confidence, but the numbers
remain the model's. Another LLM, or no LLM, is a different adapter.

### 5 — Recommendation

Every analysis shows the model's probability and its **fair odds** (1 ÷ p)
for each selection — "this is worth backing at 2.10 or better" — so a
decision can be made against any bookmaker without an odds feed. When
Claudio enters the price on offer, the recommendation is completed:

```
implied        = 1 / decimal odds
fair (market)  = de-vigged consensus probability
edge           = model p − implied
EV per unit    = p × (odds − 1) − (1 − p)
```

A selection becomes **Bet** only if it passes every threshold in force
(minimum confidence, minimum edge, odds range, enabled markets); otherwise
**Pass**, with the failing rules listed. The thresholds are copied into the
recommendation, so later changes to settings don't rewrite history. Stake
advice comes from the bankroll settings (flat, % of current bankroll, or
units) and never scales with recent results.

### Learning from history, honestly

Past outcomes reach future predictions through **calibration** and **model
refits on match data**, never through "this bet won, do more like it". The
analytics keep four measures apart:

| Measure | Question | Metric |
|---|---|---|
| Prediction quality | Were the probabilities right? | Brier, log loss, calibration |
| Price quality | Did we get a good number? | Price taken vs the model's fair odds (CLV only if an odds feed is ever added) |
| Decision quality | Was it +EV when placed? | EV at bet time, threshold compliance |
| Outcome | Did it win? | P/L — reported, never used to judge the others |

---

## 7. Bet tracking and settlement

### Entry

The bet slip takes sportsbook, legs (match, market, line, selection), odds in
any format (`2.50`, `+150`, `6/4` → stored as decimal plus the original),
stake and notes. If the leg matches a live recommendation, it links it and
copies the model probability and edge **as of the moment the bet is
entered**. Payout is computed and shown before saving. Parlays multiply leg
odds.

### Settlement engine

`bets/settle.mjs` — a pure function `settleLeg(market, line, selection,
finalFacts)` with one rule set per market type, tested exhaustively:

- 1X2, DC, DNB (draw → push), BTTS, team totals, Over/Under (whole lines →
  push on exact), European handicap (three-way), **Asian handicap** with half
  and quarter lines (quarter lines split the stake: half_won / half_lost),
  corners and cards totals, anytime scorer (own goals excluded; a player who
  doesn't play → void), player shots/SOT (didn't play → void).
- Regular time only, unless the market says otherwise.
- **Postponed or abandoned** → stays pending for 48 h, then void (the most
  common sportsbook rule), with the reason shown.
- Parlays: void legs drop out (odds recalculated), any lost leg loses the
  parlay, half results apply proportionally.

Settlement only runs once `result_confirmed_at` is set. Each result is
written as a new `settlements` row (`source = auto`). A manual correction is
another row (`source = manual`, reason required); nothing is overwritten,
and both are visible. P/L is computed from the current settlement. Closing odds and CLV
columns exist but stay empty without an odds feed; a closing price can be typed
on a bet to get CLV for it.

---

## 8. Routes and UI

### API (all under `/api`, JSON; all require the front door except `/health`)

```
GET  /health
GET  /me
GET  /search?q=                         teams, players, matches, competitions
GET  /dashboard
GET  /competitions                      GET /competitions/:id (table, fixtures)
GET  /matches?date=&from=&to=&competition=&team=&country=&status=
GET  /matches/:id                       Match Center bundle
POST /matches/:id/analyze               queue an analysis run → { runId }
GET  /analysis-runs/:id                 status + results
GET  /predictions?…                     history with filters
GET  /teams/:id    GET /players/:id
POST /favourites   DELETE /favourites/:type/:id
GET  /bets?status=   POST /bets   GET /bets/:id
POST /bets/:id/settlements              manual correction
GET  /history?from=&to=&competition=&team=&market=&sportsbook=&kind=
GET  /performance?model=&market=&competition=&from=&to=
GET  /bankroll   PUT /bankroll   POST /bankroll/ledger
GET  /settings/thresholds   PUT /settings/thresholds
GET  /sync/status   POST /sync/:job/run
```

### Screens

Navigation as specified: **Dashboard · Matches · Predictions · My Bets ·
Betting History · Model Performance · Teams · Players · Leagues ·
Settings**, plus global search in the top bar and a link back to the
Conforza menu. Responsive down to phone width (16px gutters, the table views
collapse to cards).

- **Dashboard**: today's matches, next 7 days, best current opportunities
  (Bet recommendations by EV), open bets and exposure, recently settled bets,
  bankroll, P/L, ROI, recent Brier/calibration sparkline. "Best
  opportunities" ranks by model edge over fair odds where a price was entered.
- **Matches**: date strip + filters (competition, team, country, status,
  favourites first).
- **Match Center**: header (crests, kickoff in local time, venue,
  competition, positions); tabs for *Overview* (form strips, home/away
  records, goals and xG bars), *Head-to-head*, *Lineups & availability*,
  *Players* (key players, recent stats), *Analysis* (Analyze button, model probabilities and fair odds, optional
  price entry to compute edge and EV, factors for/against, Bet/Pass cards with EV and
  stake advice, "Add to bet slip").
- **Predictions**: every prediction with outcome, filters, and a link to its
  frozen feature snapshot.
- **My Bets**: open/settled lists, bet slip drawer, manual settlement with
  reason.
- **Betting History**: KPI tiles and breakdown tables/charts by competition,
  team, market, sportsbook, confidence range, odds range, over time; all
  filters from the spec.
- **Model Performance**: reliability diagram (predicted vs observed per
  bucket, with counts), Brier/log-loss trend, by market/competition/version,
  ROI of recommendations vs. passes.
- **Teams / Players / Leagues**: profiles as specified, with tracked betting
  performance on team pages.
- **Settings**: competitions enabled, thresholds, bankroll and staking,
  sportsbooks, data sync status and manual runs, entity-matching review,
  provider status (configured or not — keys are never shown).

Images: logos and photos are loaded from the provider's CDN where its terms
allow, with initials-badge fallbacks.

---

## 9. Roadmap

Each phase ends deployed and verified at sokkerliga.conforza.tech.

**Phase 0 — groundwork (small)**
- Accounts and keys (Claudio): API-Football Pro, Anthropic key. Keys into `/etc/sokkerliga/sokkerliga.env`.
- Worker systemd unit `sokkerliga-worker`, backups cron.

**Phase 1 — knowledge base and Match Center**
- Schema (reference, competitions, teams, players, rosters, matches, events,
  lineups, availability, stats tables, provenance, revisions, raw payloads,
  jobs) and seeds for the 8 competitions.
- Provider contract + API-Football provider; ingestion jobs for
  competitions, fixtures, results, squads, injuries, standings, lineups;
  Settings → Data sync.
- App shell with full navigation, search, favourites.
- Matches list, Match Center (overview, H2H, lineups, availability, players),
  Team, Player and League pages.
- Backfill of the current and previous season.

**Phase 2 — statistics and analysis**
- Team/player match statistics, derived season stats.
- Feature builder with the leakage test suite; Dixon–Coles goals model and
  market pricing; corners/cards rate models.
- Historical import from football-data.co.uk for model fitting (subject to
  the terms check in §4).
- AI service abstraction, Claude adapter, versioned prompts; analysis runs,
  immutable predictions, factors, recommendations (against odds where
  available, else model-only); Predictions screen and Match Center Analysis
  tab.

**Phase 3 — odds and bets**
- Price entry (decimal, American, fractional), conversions, de-vigging of
  entered prices.
- Thresholds and Bet/Pass; bet slip (singles and parlays); settlement engine
  and manual corrections; P/L; My Bets; Betting History.

**Phase 4 — evaluation and bankroll**
- Model Performance (Brier, log loss, reliability diagrams, by segment and
  version), calibration layer, bankroll settings, ledger,
  staking advice, exposure.

**Phase 5 — depth**
- Fully automated schedules tuned to quota, more competitions, more markets,
  player props, model improvements (e.g. a learned model on the stored
  feature snapshots), a natural-language query page over the analytics
  tables for questions like "How accurate have our Premier League Over 2.5
  predictions been?".

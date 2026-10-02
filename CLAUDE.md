# SokkerLiga

Third app on the Conforza server, at https://sokkerliga.conforza.tech.
Stack matches SAM: Node 22 + Vite + React + SQLite (`node:sqlite`), no server
runtime dependencies.

## Sign-in

SokkerLiga has **no sign-in of its own**. The Conforza front door
(`conforza-home` repo) signs people in; Caddy checks every request with it
and passes the user as `X-Conforza-User-*` headers. `server/identity.mjs`
reads them. The API must stay bound to 127.0.0.1 — that is what stops the
headers being forged. In development set `SOKKERLIGA_DEV_USER=you@example.com`
to stand in for the front door.

`people` records each front-door user the first time they are seen, so league
data can reference people by id.

## Code map (Phase 1)

- `server/providers/api-football.mjs` — the only network code: `createClient()`
  (raw payloads, quota, pacing, retries) and pure `normalise*()` functions.
  Response shapes were taken from real samples (see `test/fixtures/`).
- `server/ingest.mjs` — normalised records → rows. Idempotent; changes to
  stored facts are copied to `match_revisions` / `team_match_stats_revisions`
  first; squads use valid_from/valid_to; standings are a dated series.
- `server/jobs.mjs` — job functions + `runJob` (lock, `job_runs` log,
  next run) + `dueJobs`. `server/worker.mjs` loops over due jobs.
- `server/queries.mjs` — read models. Anything looking back from a match is
  computed **as of its kickoff**.
- `src/` — hash-routed React UI (`#/match/12`), pages in `src/pages/`.

## Code map (Phase 2 — analysis)

- `server/features.mjs` — `buildFeatures(db, matchId, asOf)`: the ONLY door
  to data for prediction. Results count only if kicked off ≥3 h before asOf;
  corrections after asOf are undone via `match_revisions`; the table is
  rebuilt from results; injuries/lineups count only if fetched by asOf.
  `test/analysis.test.mjs` "No look-ahead" guards this — keep it green.
- `server/model/goals.mjs` — Dixon–Coles fit (time decay, shrinkage, per-
  competition home advantage, ρ by grid). `server/model/markets.mjs` — every
  goals market priced from the scoreline matrix; corners/cards by negative
  binomial.
- `server/analysis.mjs` — request → run: snapshot, predictions (written
  BEFORE Claude is asked), explanation, recommendations with the thresholds
  copied in. Predictions/recommendations/snapshots/explanations are
  append-only by SQLite triggers; re-analysis marks old predictions
  superseded (the only allowed update, before kickoff only).
- `server/ai/claude.mjs` — Claude Opus 5.5, effort `medium` set explicitly,
  structured output (`output_config.format` json_schema), `fallbacks:
  "default"` (beta `server-side-fallback-2026-07-01`), refusal checked before
  parsing. Claude explains; it never sets probabilities.
- Prompts are versioned files `server/prompts/<key>.v<N>.md`; editing one
  without a new version stops start-up (checksum in the `prompts` table).
- Thresholds: dated rows per user; defaults medium confidence, p ≥ 55%,
  fair odds 1.30–2.50 (the minimum keeps near-certainties out).
- `src/markets.js` — selection labels, shared by server and UI.

## Code map (Phase 3 — bets and grading)

- `server/grading.mjs` — `grade(market, line, selection, facts)`, one rule
  set for predictions AND bet legs (regular time; whole lines push; quarter
  AH lines → half_won/half_lost; postponed → void after 48 h; awarded →
  void). `settleBet` does singles and parlays (void legs drop out; a quoted
  parlay total is honoured).
- `server/bets.mjs` — bets recorded by hand after placing them elsewhere.
  At record time each leg freezes the model's latest prediction made before
  both the bet and kickoff (p, fair odds, edge = p − 1/odds, EV). Edits write
  `bet_revisions` and mark old legs `replaced_at` (never deleted); deletes
  are soft. Settlement rows and prediction grades are append-only; a manual
  correction wins over automatic settlement.
- Job `grade_and_settle` (every 15 min) grades predictions and settles bets
  from confirmed results; it needs no provider key.
- `src/odds.js` — parse decimal / American / fractional (shared with the
  server); money in integer cents; amounts in different currencies are
  never summed (per betting app currency).
- UI: `src/components/BetSlip.jsx` (drawer; full-screen on phones; draft
  kept in localStorage), `pages/Bets.jsx`, `pages/History.jsx`.

## Code map (Phase 4 — performance and calibration)

- `server/backtest.mjs` — the model re-run for past matches as of an hour
  before each match day's first kickoff, through the SAME `buildFeatures()` /
  `priceMatch()` as live (a per-asOf fit cache makes a match day one fit).
  Raw probabilities only; each selection graded at write time. Only matches
  with details fetched. Paced: `backtest_seconds_per_run` (45 s) per run,
  yields between days. Job `backtest_model`, every 10 min.
- `scored_predictions_v1` (view, schema.sql) — every graded selection, live
  and backtest, as (p, y, w). A changed definition is a NEW view name.
- `server/performance.mjs` — Model Performance: one SQL pass builds a cube
  (source × competition × confidence × model × month × selection × 10%
  bucket), cached in the API until data change; filters/breakdowns roll up
  in memory. Team / favourite / exact-date / threshold filters go to SQL.
  Also the jobs' work: `fitCalibrations` (isotonic per market, trial fit on
  oldest 80% by count, applied only if it beat raw on the newest 20%;
  dated, append-only rows), `trainChallenger`, `snapshotPerformance`.
- `server/model/calibration.mjs` — PAV, interpolation, bin metrics,
  `calibratePriced` (renormalises each market/line group; double chance is
  rebuilt from calibrated 1X2, never fitted), `reliabilityFactor`
  (confidence × 0.8–1 from the market's calibration error).
- Analysis now stores `calibrated_probability` beside `model_probability`;
  fair odds and decisions use the calibrated one; `analysis_runs.
  calibration_json` records which fits applied. Bets freeze the calibrated
  probability when there is one.
- `server/model/learned.mjs` — the challenger: multinomial logistic
  regression starting AT Dixon–Coles (inputs include DC's log-odds) with a
  penalty pulling back to it. SHADOW ONLY: logged in
  `challenger_predictions`, scored on Model Performance, never used for
  recommendations. Promoting it is a decision for Claudio.
- Job `calibrate_and_train`, every 6 h, no provider requests.

## Code map (Phase 5 — depth)

- Bankroll (`server/bankroll.mjs`, `pages/Bankroll.jsx`): per currency;
  balance = start + deposits − withdrawals + settled profit since the start
  date; exposure = open stakes; flat / percent / unit plans; suggested stake
  capped by the exposure limit; shown in the bet slip. Dated settings rows,
  append-only ledger (triggers).
- Player markets: `anytime_scorer` only (`server/model/players.mjs`):
  player's share of team scoring per minute (shrunk to a position prior) ×
  expected minutes × the goals model's team λ. Selection key `p:<player id>`;
  `selectionLabel(..., playerName)`. Graded on regular-time goals, own goals
  excluded, no appearance = void. Not in the backtest.
- More competitions: nine more seeded, switched off; switching one on
  requests the season/teams/fixtures/table/squads jobs at once.
- Quota-aware scheduling (`jobs.mjs`): `jobs.quota_priority` essential /
  normal / deferrable; below `quota_reserve` (750) normal jobs wait for the
  next UTC day, below twice that deferrable ones; "Run now" overrides. The
  results backlog never spends into the reserve. Standings only after a
  matchday, injuries only before one.
- Ask (`server/ask.mjs`, `server/ai/questions.mjs`, `pages/Ask.jsx`): Claude
  turns the question into a filter (structured output, effort low, prompt
  `question-filter.v1.md`, registered with checksum like the other); the
  server validates it and computes every number. Claude never sees data.
- Closing prices: typed per leg on My Bets (`PUT /api/bets/:id/legs/:leg/
  closing`); closing-line value in Betting History and Ask.
- Columns added to existing tables go in `ADDED_COLUMNS` (db.mjs).

Deviations from `docs/architecture.md`, deliberately small: no `stages`
table (round text on matches, group name on standings); logos/photos are
columns rather than an `images` table; `ingest.mjs`/`jobs.mjs` are single
files rather than folders.

Match details are fetched with `/fixtures?ids=` (20 matches per request,
events + lineups + stats + player stats included) — keep it that way, it is
what keeps the request budget tiny.

## Run locally

    npm install
    SOKKERLIGA_DEV_USER=dev@example.com npm run server   # API on 5176
    npm run dev                                          # UI on 5175

## Server

VPS `root@2.25.65.188`. Code `/srv/sokkerliga`, DB
`/var/lib/sokkerliga/sokkerliga.db`, user/unit `sokkerliga`, port 8789,
Caddy block `deploy/sokkerliga.caddy` → `/etc/caddy/sites/`.

Two systemd units: `sokkerliga` (API) and `sokkerliga-worker` (jobs). Both
read `/etc/sokkerliga/sokkerliga.env` (API_FOOTBALL_KEY). One-time setup of
the worker, secrets file and backup cron: `deploy/setup-worker.sh` (root).

Deploy: bump `src/version.js`, then `./deploy/ship.sh "message"`. The health
check (`/api/health`) is open, everything else needs a front-door sign-in.

## Product

A personal soccer prediction, analytics and betting decision-support app (it
never places bets). Spec: `docs/product-spec.md`. Design — schema, providers,
pipelines, settlement, routes, phased roadmap: `docs/architecture.md`. Read
both before building. Claudio chose the SAM stack (SQLite) over the spec's
Next.js/PostgreSQL preference; don't re-propose it.

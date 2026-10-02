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

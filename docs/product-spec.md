# SokkerLiga — product spec

As given by Claudio on 2026-10-01. Recorded here in condensed form; every
requirement of the original is kept. The design that answers it is in
`docs/architecture.md`.

## Scope decisions (2026-10-01) — these override the sections below

1. **Stack**: same as SAM (SQLite), not Next.js/PostgreSQL.
2. **No odds feed**: football data only.
3. **Recommendations, not betting**: SokkerLiga never places bets; Claudio
   bets in a separate betting app. **Afterwards Claudio records the bet in
   SokkerLiga by hand** (match, market, selection, odds taken, stake, notes).
   SokkerLiga settles recorded bets from the results and keeps the Betting
   History. Bankroll tools are optional and come last.

The original odds section is kept below for reference only; the bet
sections still apply, with odds typed in by hand.

## Purpose

A personal soccer prediction, analytics and betting **decision-support**
application. It collects soccer data from multiple leagues, keeps a historical
database of teams, players, matches, statistics, predictions, bets and
outcomes, and uses AI to analyse upcoming matches and produce evidence-based
betting recommendations.

It **never places wagers**. It helps research matches, evaluate opportunities,
record bets placed elsewhere, track outcomes, and improve future analysis from
historical results.

## Core concept

SokkerLiga continuously builds its own structured soccer knowledge base from
legitimate soccer data APIs and permitted public sources: teams, players,
leagues, competitions, fixtures, results, starting lineups, substitutes,
availability, injuries and suspensions, team and player form, goals, assists,
shots, shots on target, xG where available, possession, corners, cards,
home/away performance, head-to-head, standings, schedules, venues, managers,
team and player images, match statistics, historical results.

- Never fabricate unavailable information.
- Every imported fact keeps its source, source ID and last-updated timestamp.
- Prefer official or licensed APIs to scraping.
- The provider layer is an abstraction; new providers can be added without
  redesign.

## Leagues

Multi-competition, nothing hard-coded. Initially: Premier League, Bundesliga,
La Liga, Serie A, Ligue 1, UEFA Champions League, UEFA Europa League, MLS.
More can be enabled later.

## Database

Relational, preferably PostgreSQL. Normalised entities for at least: leagues,
seasons, teams, players, team rosters, matches, match events, match
statistics, player match statistics, team statistics, standings, venues,
injuries/availability, data sources, predictions, prediction factors, betting
markets, odds snapshots, bets, bet legs, bet outcomes, AI recommendations, AI
analysis runs, model performance.

**Never overwrite historical match or betting information** because newer
data arrives.

## Match Center

Per upcoming match: both teams and logos, kickoff, competition, venue, league
positions, recent form, home/away records, head-to-head, probable or
confirmed lineups, unavailable players, key players, recent player stats,
team stats, historical matchup stats. Visual and easy to read before betting.

## AI match analysis

An **Analyze Match** action. The AI analyses the structured database rather
than general model knowledge. Factors: recent form, home vs away, opponent
strength, head-to-head, goals for/against, xG, shots and shots on target,
possession, set pieces, corners, cards, availability, starting lineup,
goalkeeper performance, key player form, rest days, schedule congestion,
league position, historical patterns. It names the factors **for and against**
each prediction.

## Betting markets

1X2, Draw No Bet, Double Chance, Over/Under goals, BTTS, Asian Handicap,
European Handicap, team total goals, corners, cards, player goalscorer, player
shots and shots on target (when data exists).

## Odds

**Changed 2026-10-01: no odds feed.** Claudio needs football data only; odds
are entered by hand (bet slip, or a price to evaluate). The original
requirement follows for reference.

An odds-provider interface importing sportsbook odds where legally and
technically available. Odds stored as **historical snapshots**, enabling:
opening, current and closing odds, line movement, implied probability, best
available price, market consensus. Convert decimal, American and fractional.

## AI recommendations

Structured output per upcoming match: market, selection, available odds,
implied probability, SokkerLiga estimated probability, estimated edge,
confidence, main supporting factors, main opposing factors, relevant stats,
data freshness, timestamp.

- Uncertain predictions are never presented as facts.
- Model probability is kept separate from sportsbook probability.
- Expected value where practical:
  `EV = model probability × potential profit − probability of losing × stake`.
- User thresholds: minimum confidence, minimum edge, minimum odds, maximum
  odds. Recommendations failing them are marked **Pass**.

## Bet slip and tracking

Manually record wagers placed at external sportsbooks: date, match,
sportsbook, market, selection, odds, stake, potential payout, linked AI
recommendation, model probability at bet time, estimated edge at bet time,
notes. Straight bets, parlays/accumulators, multiple legs.

## Settlement

After matches finish, fetch final results and stats automatically. Where the
result decides it, settle each bet: Won, Lost, Push, Void, Pending. Manual
correction allowed (sportsbook rules differ). Store final result, outcome,
profit/loss, closing odds when available, placed-vs-closing difference,
original AI prediction, actual outcome.

**Predictions are immutable once the match starts.**

## Betting History

Dashboard: total wagers, wins, losses, pushes, win rate, total staked, total
returned, net P/L, ROI, average odds, average estimated edge; performance by
league, team, market, sportsbook, confidence range, odds range, and over time.
Filters: date range, league, team, market, sportsbook, recommendation type.

## Model Performance

Accuracy, probability calibration, performance by confidence bucket, league,
market, model/version, ROI of tracked recommendations, closing-line value.
Miscalibration (a 70% call winning 55%) must be visible. **No leakage**:
historical outcomes must never feed the features of historical predictions;
guard against look-ahead bias.

## Learning from history

Past bets are context, but a bet is not "good" because it won. Distinguish
prediction quality, bet outcome, price/value quality and decision quality.
Use past performance to **calibrate** confidence, not to reward winners.
Every prediction stores a **feature snapshot** so the information available
at the time can be reconstructed exactly.

## Data ingestion

Background jobs: upcoming fixtures, completed results, standings, teams,
players/rosters, match stats, player stats, injuries/availability, odds, bet
settlement. Idempotent and resilient to provider failure. Logs: last
successful sync, provider, records imported, errors, next scheduled run.

## AI architecture

An AI service abstraction; Claude first, swappable for another LLM or a
statistical model. Never send the whole database: a retrieval/feature
pipeline builds a structured **match-analysis packet**. Separate stages: data
collection → feature engineering → probability estimation → AI explanation →
bet recommendation. **The LLM is not the sole mathematical engine**:
statistical/ML models produce probabilities, Claude interprets and explains.

## Prediction versioning

Every analysis saves: analysis ID, model name, model version, prompt version,
timestamp, data snapshot/version, prediction, probability, confidence,
recommendation, reasoning summary.

## Interface

Modern and responsive. Navigation: Dashboard, Matches, Predictions, My Bets,
Betting History, Model Performance, Teams, Players, Leagues, Settings.

Dashboard: today's matches, upcoming matches, best current opportunities,
recently completed bets, current bankroll, P/L, ROI, recent prediction
performance. Team logos and player photos where licensing permits.

Match discovery filters: date, league, team, country, status. Favourite
leagues and teams.

## Bankroll

Optional: starting and current bankroll, flat staking, percentage staking,
unit sizing, exposure across open bets. **Never increase stakes automatically
because of recent wins or losses.**

## Search

Global search over teams, players, matches, leagues, opening each profile.

## Team profile

Logo, league, standing, roster, recent and upcoming matches, form, home and
away records, goal stats, advanced stats, tracked betting performance
involving the team.

## Player profile

Photo, team, position, age, appearances, minutes, goals, assists, shots, shots
on target, cards, recent form, match history, availability.

## Security

Keys and AI credentials server-side only, in environment variables, never in
browser code. Authentication even for a single user. Respect API licensing,
robots rules, copyright, image licensing and provider terms.

## Stack

The original spec preferred Next.js, TypeScript, PostgreSQL, Prisma and
Tailwind. **Overridden by Claudio on 2026-10-01: use the same stack as SAM** —
Node 22, Vite, React, SQLite through the built-in `node:sqlite`, plain
JavaScript, no server framework or ORM. Still required: server-side API and
services, a background job scheduler, the Anthropic API.

## Process

Design first: architecture, schema, provider interfaces, recommended APIs,
ingestion pipeline, AI pipeline, bet tracking and settlement, routes and UI,
roadmap. Then build in phases:

1. Shell, database, leagues, teams, players, fixture import, results, Match
   Center, team and player pages.
2. Historical and match statistics, AI analysis, prediction storage and
   versioning, recommendation interface.
3. Odds, bet slip, tracking, settlement, P/L, Betting History.
4. Model performance, calibration, closing-line analysis, bankroll tools,
   advanced analytics.
5. Automated sync, better models, more leagues, more markets, player props.

## Questions it must eventually answer from its own data

- How accurate have our Premier League Over 2.5 predictions been?
- How does the model perform on Bundesliga home favourites?
- Which markets have the best-calibrated predictions?
- Do high-confidence recommendations outperform lower-confidence ones?
- Which teams consistently produce prediction errors?
- Did we beat the closing price?
- Which statistical factors were most useful in successful predictions?
- Which recommendation categories lose money despite high confidence?

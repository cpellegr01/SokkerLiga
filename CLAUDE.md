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

## Run locally

    npm install
    SOKKERLIGA_DEV_USER=dev@example.com npm run server   # API on 5176
    npm run dev                                          # UI on 5175

## Server

VPS `root@2.25.65.188`. Code `/srv/sokkerliga`, DB
`/var/lib/sokkerliga/sokkerliga.db`, user/unit `sokkerliga`, port 8789,
Caddy block `deploy/sokkerliga.caddy` → `/etc/caddy/sites/`.

Deploy: bump `src/version.js`, then `./deploy/ship.sh "message"`. The health
check (`/api/health`) is open, everything else needs a front-door sign-in.

## Product

A personal soccer prediction, analytics and betting decision-support app (it
never places bets). Spec: `docs/product-spec.md`. Design — schema, providers,
pipelines, settlement, routes, phased roadmap: `docs/architecture.md`. Read
both before building. Claudio chose the SAM stack (SQLite) over the spec's
Next.js/PostgreSQL preference; don't re-propose it.

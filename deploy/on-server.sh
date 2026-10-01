#!/usr/bin/env bash
# Install, build and restart SokkerLiga. Run on the server, as root, after the
# source has been synced to /srv/sokkerliga (deploy/ship.sh does both).
#
# Safe to re-run: it leaves the database alone.
set -euo pipefail

APP_DIR=/srv/sokkerliga
SERVICE=sokkerliga

cd "$APP_DIR"

echo "==> Installing dependencies and building the front end"
# Vite is a dev dependency, so the build needs the full install.
npm ci --silent
npm run build --silent

chown -R sokkerliga:sokkerliga "$APP_DIR"

echo "==> Restarting"
systemctl restart "$SERVICE"
sleep 1
systemctl is-active "$SERVICE"

echo "==> Version"
curl -fsS http://127.0.0.1:8789/api/health
echo

#!/usr/bin/env bash
# Install, build and restart SokkerLiga. Run on the server, as root, after the
# source has been synced to /srv/sokkerliga (deploy/ship.sh does both).
#
# Safe to re-run: it leaves the database alone.
set -euo pipefail

APP_DIR=/srv/sokkerliga

cd "$APP_DIR"

echo "==> Installing dependencies and building the front end"
# Vite is a dev dependency, so the build needs the full install.
npm ci --silent
npm run build --silent

chown -R sokkerliga:sokkerliga "$APP_DIR"

echo "==> Restarting"
systemctl restart sokkerliga
# The worker exists from v0.2; before its one-time install there is none.
# (Not `list-unit-files | grep -q`: under pipefail, grep closing the pipe
# early makes the whole test fail.)
if systemctl cat sokkerliga-worker >/dev/null 2>&1; then
  systemctl restart sokkerliga-worker
  sleep 1
  echo "worker: $(systemctl is-active sokkerliga-worker)"
else
  echo "worker: not installed yet (see deploy/setup-worker.sh)"
fi
sleep 1
systemctl is-active sokkerliga

echo "==> Version"
curl -fsS http://127.0.0.1:8789/api/health
echo

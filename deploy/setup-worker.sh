#!/usr/bin/env bash
# One-time server setup for the SokkerLiga worker (v0.2). Run as root:
#
#   ssh root@2.25.65.188 'bash /srv/sokkerliga/deploy/setup-worker.sh'
#
# Installs the worker unit, creates the secrets file (empty key) if missing,
# refreshes the API unit (which now reads the secrets file too), and installs
# the nightly backup. Safe to re-run; it never overwrites an existing key.
set -euo pipefail

install -d -m 0755 /etc/sokkerliga
if [ ! -f /etc/sokkerliga/sokkerliga.env ]; then
  install -m 0600 /dev/null /etc/sokkerliga/sokkerliga.env
  printf 'API_FOOTBALL_KEY=\n' > /etc/sokkerliga/sokkerliga.env
  echo "Created /etc/sokkerliga/sokkerliga.env — put the API-Football key in it."
fi

cp /srv/sokkerliga/deploy/sokkerliga.service /srv/sokkerliga/deploy/sokkerliga-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet sokkerliga-worker
systemctl restart sokkerliga sokkerliga-worker

echo '40 3 * * * root bash /srv/sokkerliga/deploy/backup.sh >/dev/null 2>&1' > /etc/cron.d/sokkerliga-backup
chmod 644 /etc/cron.d/sokkerliga-backup

echo "API: $(systemctl is-active sokkerliga) · worker: $(systemctl is-active sokkerliga-worker)"

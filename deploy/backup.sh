#!/usr/bin/env bash
# Back up the SokkerLiga database with a consistent snapshot of the live file.
set -euo pipefail

DB=/var/lib/sokkerliga/sokkerliga.db
DEST=/var/backups/sokkerliga
KEEP=14

mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)

node --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$DB', { readOnly: true });
db.exec(\"VACUUM INTO '$DEST/sokkerliga-$STAMP.db'\");
"

gzip -f "$DEST/sokkerliga-$STAMP.db"

ls -1t "$DEST"/sokkerliga-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm --

echo "Backed up to $DEST/sokkerliga-$STAMP.db.gz"

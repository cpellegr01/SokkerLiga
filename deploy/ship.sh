#!/usr/bin/env bash
# Ship SokkerLiga: test, build, commit, push, deploy, verify.
#
#   ./deploy/ship.sh "Commit message"
#
# Run from the repo root on a development machine. Stops at the first failure,
# so a broken build never reaches the server. The source is synced with rsync
# rather than pulled on the server, so the server needs no GitHub access.
set -euo pipefail

SERVER=${CONFORZA_SERVER:-root@2.25.65.188}
MESSAGE=${1:-}

if [ -z "$MESSAGE" ]; then
  echo "Usage: ./deploy/ship.sh \"Commit message\"" >&2
  exit 1
fi

VERSION=$(node --input-type=module -e "import('./src/version.js').then(m => console.log(m.VERSION))")
echo "==> Shipping v$VERSION"

echo "==> Tests"
npm test

echo "==> Build"
npm run build

if [ -n "$(git status --porcelain)" ]; then
  echo "==> Committing"
  git add -A
  git commit -q -m "SokkerLiga v$VERSION — $MESSAGE" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
fi

if git remote get-url origin >/dev/null 2>&1; then
  echo "==> Pushing"
  git push -q origin main
else
  echo "==> No GitHub remote yet; skipping push"
fi

echo "==> Syncing to the server"
rsync -az --delete --exclude node_modules/ --exclude dist/ --exclude data/ --exclude .git/ \
  ./ "$SERVER:/srv/sokkerliga/"

echo "==> Deploying"
ssh "$SERVER" 'bash /srv/sokkerliga/deploy/on-server.sh'

echo "==> Verifying the live version"
LIVE=$(ssh "$SERVER" 'curl -fsS http://127.0.0.1:8789/api/health' | node -e "
  let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).version));
")
if [ "$LIVE" != "$VERSION" ]; then
  echo "Deploy did not land: live reports $LIVE, expected $VERSION" >&2
  exit 1
fi
echo "Live version is $LIVE. Deployed."

#!/usr/bin/env bash
# Ship current main to EC2 in one command (from your Mac):
#   npm run deploy
#   # or: bash deploy/ship.sh
#
# Needs SSH open to your IP (AWS security group: SSH / port 22 / My IP).
# Config (optional): copy deploy/local.env.example → deploy/local.env

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Load optional local overrides (gitignored)
if [[ -f "$ROOT/deploy/local.env" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/deploy/local.env"
fi

EC2_HOST="${EC2_HOST:-ubuntu@54.224.28.249}"
EC2_KEY="${EC2_KEY:-$HOME/Downloads/Bounty Arena Key.pem}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/bounty-arena}"

if [[ ! -f "$EC2_KEY" ]]; then
  echo "Missing SSH key: $EC2_KEY"
  echo "Set EC2_KEY in deploy/local.env or export EC2_KEY=/path/to/key.pem"
  exit 1
fi
chmod 400 "$EC2_KEY" 2>/dev/null || true

SSH=(ssh -i "$EC2_KEY" -o ConnectTimeout=15 -o BatchMode=yes -o StrictHostKeyChecking=accept-new)

echo "==> Checking SSH to $EC2_HOST …"
if ! "${SSH[@]}" "$EC2_HOST" 'echo ok' >/dev/null; then
  cat <<EOF

SSH failed (timeout or auth). Do this once in AWS Console:

  EC2 → Instances → your instance → Security tab → security group
  → Edit inbound rules → Add:
      Type: SSH   Port: 22   Source: My IP
  → Save

Then re-run:  npm run deploy

EOF
  exit 1
fi

# Ensure commits are on remote before the server pulls
CURRENT="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT" != "$BRANCH" ]]; then
  echo "You are on branch '$CURRENT' (expected $BRANCH). Checkout $BRANCH or set BRANCH=."
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "You have uncommitted changes. Commit first, then deploy."
  git status -sb
  exit 1
fi

echo "==> Pushing $BRANCH to origin …"
git push origin "$BRANCH"

REMOTE_SHA="$(git rev-parse HEAD)"
echo "==> Updating EC2 to $REMOTE_SHA …"
"${SSH[@]}" "$EC2_HOST" "cd '$APP_DIR' && bash deploy/update.sh"

echo "==> Verifying …"
"${SSH[@]}" "$EC2_HOST" "cd '$APP_DIR' && git rev-parse --short HEAD && sudo systemctl is-active bounty-arena"
HOST_ONLY="${EC2_HOST#*@}"
if curl -sS -o /dev/null -w '' --max-time 8 "http://${HOST_ONLY}:3000/" 2>/dev/null; then
  echo "Live: http://${HOST_ONLY}:3000"
else
  echo "Server restarted; if the page doesn't load, check security group port 3000."
fi
echo "Done."

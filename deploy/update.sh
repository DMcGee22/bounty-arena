#!/usr/bin/env bash
# Pull latest from GitHub and restart. Run on the EC2 box:
#   cd /opt/bounty-arena && bash deploy/update.sh

set -euo pipefail
APP_DIR="${APP_DIR:-/opt/bounty-arena}"
BRANCH="${BRANCH:-main}"

cd "$APP_DIR"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
sudo systemctl restart bounty-arena
sudo systemctl --no-pager status bounty-arena | head -20
echo "Updated."

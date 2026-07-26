#!/usr/bin/env bash
# Run ONCE on a fresh Ubuntu 22.04/24.04 EC2 instance (as ubuntu, with sudo).
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/DMcGee22/bounty-arena/main/deploy/setup-ec2.sh | bash
# Or after git clone:
#   bash deploy/setup-ec2.sh
#
# Opens TCP 3000 for game + WS. Security group must also allow 3000 inbound.

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/DMcGee22/bounty-arena.git}"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/bounty-arena}"
DATA_DIR="${DATA_DIR:-/var/lib/bounty-arena}"
PORT="${PORT:-3000}"

echo "==> Bounty Arena EC2 setup"
echo "    repo: $REPO_URL ($BRANCH)"
echo "    dir:  $APP_DIR"

# --- packages ---------------------------------------------------------------
sudo apt-get update -y
sudo apt-get install -y curl git ufw ca-certificates

# Node 22 (matches engines in package.json)
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]]; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v
npm -v

# --- app --------------------------------------------------------------------
sudo mkdir -p "$APP_DIR" "$DATA_DIR"
sudo chown -R "$USER:$USER" "$APP_DIR" "$DATA_DIR"

if [[ -d "$APP_DIR/.git" ]]; then
  echo "==> Updating existing clone"
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
else
  echo "==> Cloning"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# --- firewall ---------------------------------------------------------------
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow OpenSSH || true
  sudo ufw allow "${PORT}/tcp" || true
  # Don't force-enable if user hasn't; but rule is there when they do
  echo "==> ufw: allowed SSH + ${PORT}/tcp (enable with: sudo ufw --force enable)"
fi

# --- systemd ----------------------------------------------------------------
SERVICE_SRC="$APP_DIR/deploy/bounty-arena.service"
if [[ -f "$SERVICE_SRC" ]]; then
  sudo cp "$SERVICE_SRC" /etc/systemd/system/bounty-arena.service
  # Patch user if not ubuntu
  if [[ "$(whoami)" != "ubuntu" ]]; then
    sudo sed -i "s/^User=ubuntu/User=$(whoami)/" /etc/systemd/system/bounty-arena.service
  fi
  sudo systemctl daemon-reload
  sudo systemctl enable bounty-arena
  sudo systemctl restart bounty-arena
  sleep 1
  sudo systemctl --no-pager status bounty-arena || true
else
  echo "⚠  missing deploy/bounty-arena.service — starting in background"
  nohup env PORT="$PORT" DATA_DIR="$DATA_DIR" node server/index.js \
    >"$DATA_DIR/server.log" 2>&1 &
fi

PUBLIC_IP=$(curl -s --max-time 2 http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
echo ""
echo "  ─────────────────────────────────────────────"
echo "  Bounty Arena should be live."
if [[ -n "${PUBLIC_IP:-}" ]]; then
  echo "  Friends join:  http://${PUBLIC_IP}:${PORT}"
  echo "  (Security group must allow inbound TCP ${PORT} from 0.0.0.0/0)"
else
  echo "  Open http://YOUR_EC2_PUBLIC_IP:${PORT}"
fi
echo "  Logs:  sudo journalctl -u bounty-arena -f"
echo "  ─────────────────────────────────────────────"
echo ""

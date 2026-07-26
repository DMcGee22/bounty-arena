#!/usr/bin/env bash
# Print the URLs a friend can use to join, and open a public tunnel if asked.
#
#   ./share.sh          → LAN URL only (best latency, same wifi only)
#   ./share.sh --tunnel → also open a public ngrok tunnel (works anywhere)
#
# Start the game server separately with `npm start`.

set -u
PORT="${PORT:-3000}"

LAN_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "")

echo ""
echo "  BOUNTY ARENA — join links"
echo "  ─────────────────────────────────────────────"

if ! curl -s -o /dev/null --max-time 3 "http://localhost:$PORT/api/arena"; then
  echo "  ⚠  Server is not running. Start it with: npm start"
  echo ""
  exit 1
fi

if [ -n "$LAN_IP" ]; then
  echo "  Same wifi:   http://$LAN_IP:$PORT     (~4ms — use this if you can)"
else
  echo "  Same wifi:   no LAN address found (are you on wifi?)"
fi

if [ "${1:-}" != "--tunnel" ]; then
  echo "  Anywhere:    re-run with --tunnel to open a public URL"
  echo ""
  exit 0
fi

pkill -f "ngrok http $PORT" 2>/dev/null
nohup ngrok http "$PORT" --log stdout > /tmp/bounty-ngrok.log 2>&1 &

for _ in $(seq 1 20); do
  sleep 0.5
  URL=$(curl -s --max-time 2 http://127.0.0.1:4040/api/tunnels 2>/dev/null \
        | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['tunnels'][0]['public_url'])" 2>/dev/null)
  [ -n "${URL:-}" ] && break
done

if [ -n "${URL:-}" ]; then
  echo "  Anywhere:    $URL   (~170ms, and they must click"
  echo "               past ngrok's one-time 'Visit Site' warning page)"
  echo ""
  echo "  Tunnel is live. Stop it with:  pkill -f 'ngrok http'"
else
  echo "  ⚠  Tunnel failed to start — see /tmp/bounty-ngrok.log"
fi
echo ""

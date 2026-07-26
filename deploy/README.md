# Deploy Bounty Arena to AWS EC2

Friends lagging on your laptop / ngrok is expected (~100–200ms+ tunnel RTT).  
A small EC2 in a region near you (e.g. `us-east-1` / `us-west-2`) is the fix.

## Easiest day-to-day flow

After the one-time SSH rule below, every update is:

```bash
cd Desktop/Claude/bounty-arena
git add -A && git commit -m "what changed"
npm run deploy          # pushes GitHub + pulls on EC2 + restarts
```

That runs `deploy/ship.sh` → `git push` → SSH → `deploy/update.sh`.

Optional config (if IP or key path change):

```bash
cp deploy/local.env.example deploy/local.env
# edit EC2_HOST / EC2_KEY
```

### One-time: allow SSH from your Mac

Deploy needs **port 22**. The game only needs **3000** (already open).  
If `npm run deploy` times out on SSH:

1. **AWS Console → EC2 → your instance → Security tab → security group**
2. **Edit inbound rules → Add rule**
   | Type | Port | Source |
   |------|------|--------|
   | SSH  | 22   | **My IP** |
3. Save, wait a few seconds, re-run `npm run deploy`

Keep **SSH = My IP** only (not `0.0.0.0/0`). Game stays **3000 → anywhere**.

Live game: **http://13.221.189.12:3000** (update if the public IP changes).

### Manual fallback (same as ship.sh)

```bash
git push origin main
ssh -i "$HOME/Downloads/Bounty Arena Key.pem" ubuntu@13.221.189.12 \
  'cd /opt/bounty-arena && bash deploy/update.sh'
```

## 1. GitHub

Repo: **https://github.com/DMcGee22/bounty-arena**

## 2. Launch EC2 (AWS Console — ~5 min)

1. **EC2 → Launch instance**
2. **Name:** `bounty-arena`
3. **AMI:** Ubuntu Server 24.04 LTS
4. **Instance type:** `t3.small` (or `t3.medium` if 8+ players + voice)
5. **Key pair:** create/download `.pem` (you need this to SSH)
6. **Network / Security group — inbound rules:**
   | Type | Port | Source |
   |------|------|--------|
   | SSH  | 22   | My IP  |
   | Custom TCP | **3000** | **0.0.0.0/0** (or friends’ IPs) |
7. **Storage:** 20 GB gp3 is fine
8. Launch → copy **Public IPv4 address**

## 3. Install the game on the box

```bash
# from your Mac (replace key + IP)
chmod 400 ~/Downloads/bounty-arena.pem
ssh -i ~/Downloads/bounty-arena.pem ubuntu@YOUR_EC2_IP

# on the instance:
curl -fsSL https://raw.githubusercontent.com/DMcGee22/bounty-arena/main/deploy/setup-ec2.sh | bash
```

Or clone then setup:

```bash
git clone https://github.com/DMcGee22/bounty-arena.git
cd bounty-arena && bash deploy/setup-ec2.sh
```

## 4. Friends join

```
http://YOUR_EC2_PUBLIC_IP:3000
```

**No ngrok interstitial. No home-upload bottleneck.**  
Expect ~20–60ms RTT same region vs ~150ms+ through a laptop tunnel.

## 5. Ops cheatsheet

```bash
sudo systemctl status bounty-arena
sudo journalctl -u bounty-arena -f
sudo systemctl restart bounty-arena
# update from GitHub
cd /opt/bounty-arena && bash deploy/update.sh
```

Data (SQLite wallets / sessions) lives in `/var/lib/bounty-arena` and survives deploys.

## Optional: HTTPS + domain

Put Cloudflare or an ALB/nginx in front, set `PUBLIC_URL=https://arena.example.com`,  
and open 443. WebSockets need sticky/upgrade support (Cloudflare proxy works).

## Cost ballpark

- `t3.small` on-demand ≈ a few dollars/day; stop the instance when not playing.
- Free tier: `t2.micro` / `t3.micro` works for 2–4 friends if you stay light on voice.

## Why not ngrok forever?

| | Laptop + ngrok | EC2 |
|--|----------------|-----|
| Latency | High / variable | Low (region pick) |
| Upload | Your home Wi‑Fi | Datacenter |
| Sleep | Your Mac sleeps | Always on |
| URL | Changes | Stable IP/DNS |

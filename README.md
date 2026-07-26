# BOUNTY ARENA

A real-money PvP arena shooter. **Every kill pays $3.00. Every death costs $3.00.**
You must hold at least $3.00 to spawn; run out and you're locked out until you deposit.

> ### ⚠️ Read this before you do anything else
>
> This ships in **sandbox mode**: balances are play-money and no real funds move
> anywhere. That is deliberate. Charging players money that transfers on kills is
> **real-money skill gaming** — a regulated activity. See [Going live](#going-live)
> for what stands between this build and a legal one. Do not flip it to real money
> on vibes.

---

## Quick start

```bash
npm install
```

```bash
npm start
```

Open <http://localhost:3000>, create an account, deposit sandbox funds, and enter
the arena.

### Play with friends (low latency)

**Do not use ngrok for real play** — tunnel RTT is what feels “laggy” on their end.

1. Code lives at **https://github.com/DMcGee22/bounty-arena**
2. Launch an Ubuntu EC2 (`t3.small`), open **TCP 3000** inbound
3. On the instance:

```bash
curl -fsSL https://raw.githubusercontent.com/DMcGee22/bounty-arena/main/deploy/setup-ec2.sh | bash
```

4. Friends join `http://YOUR_EC2_PUBLIC_IP:3000`

Full steps: [deploy/README.md](deploy/README.md).

To see real multiplayer without a second human, run bots in other terminals:

```bash
npm run bot -- hunter
```

Verify the books balance at any time:

```bash
npm run audit
```

Run the ledger/Elo/auth test suite:

```bash
npm test
```

Requires Node 22.5+ (uses the built-in `node:sqlite`). Only runtime dependency is `ws`.

---

## Playing with a friend

```bash
./share.sh
```

Prints the URL to send them. Add `--tunnel` to also open a public ngrok tunnel.

**Same wifi** is dramatically better and should be your default: measured round
trip is ~4ms on LAN versus ~170ms through a tunnel, because tunnelled traffic
detours through ngrok's edge server and back. The client's 100ms interpolation
buffer keeps *movement* smooth either way, but at 170ms your *shots* will feel
mushy — you'll lead targets and still miss. For evaluating whether the game
feels good, use LAN.

The tunnel is for when your friend isn't in the building. Two caveats: the free
tier shows a one-time "Visit Site" interstitial they must click through, and the
URL changes every time you restart ngrok.

Your friend just opens the link, creates an account, and deposits sandbox funds —
same flow as you. Tell them to open it in a **real browser tab**, not an embedded
preview pane: pointer lock is refused in most embedded webviews, and while the
game does fall back to free-look, aiming is much worse.

Stop the tunnel when you're done:

```bash
pkill -f 'ngrok http'
```

> A tunnel puts your machine's server on the public internet, and anyone with the
> URL can register. It's play-money and short-lived, so the stakes are low, but
> don't leave it running unattended.

---

## The one design rule

**The server decides everything, because everything is money.**

The client sends only inputs — which keys are down, where the mouse points,
whether the trigger is pulled. It never says "I hit him." Positions, collision,
hit detection, damage and kills are all resolved by the server simulation at
30Hz, and the client renders what it's told. A modified client can lie about
its intent, which changes nothing, but it cannot manufacture a kill or a dollar.

Everything else in the architecture follows from that rule.

---

## Architecture

```
server/
  config.js      all tunables; money as integer cents, never floats
  db.js          SQLite schema + transaction helper
  auth.js        scrypt password hashing, session tokens
  wallet.js      the ledger — balances, atomic kill transfers
  elo.js         skill rating
  match.js       one authoritative arena instance
  matchmaker.js  SBMM placement + dynamic match scaling
  payments.js    sandbox / Stripe deposit layer
  index.js       HTTP API, static files, WebSocket upgrade
public/
  js/game.js     canvas renderer, input, interpolation, reconnect
  js/app.js      lobby, auth, wallet, profile
test/
  smoke.js       ledger, Elo and auth correctness
  audit.js       proves the live database's books balance
  bot-cli.js     headless bot for multiplayer testing
```

### The ledger

Money is **integer cents in an append-only transaction log**. Every row records
the signed amount, the resulting balance, and a reason. A `CHECK (balance_cents >= 0)`
constraint on the users table is the last line of defense against a negative balance.

The kill transfer is the whole economy in one function, and it is one atomic
database transaction:

```
BEGIN IMMEDIATE
  victim  -300  →  ledger row (type 'death')
  killer  +300  →  ledger row (type 'kill')
  kill/death counters
  Elo update for both players
  kill-log row
COMMIT
```

Either all of that commits or none of it does. There is no state where the
victim is charged and the killer isn't paid, and no state where money, ratings
and history disagree with each other.

`npm run audit` proves this on real data. It checks that every user's
transactions sum to their stored balance, that combat is exactly zero-sum
(kills transfer money, they never mint it), that the float held equals deposits
minus withdrawals, and that every kill has a matched pair of ledger legs.

### Matchmaking and scaling

Matches are lightweight objects, all ticked by a single 30Hz loop. A joining
player is placed into the open match whose average Elo is closest to theirs
(within `ELO_BAND`, default 300), preferring matches that already have people in
them so games actually happen. If nothing fits or everything is full, a new
match spins up. Empty matches are destroyed after 30 seconds idle.

So concurrency scales with demand: 8 players is one match, 200 players is ~25.

**Scaling past one process.** Matches share nothing except the SQLite ledger, so
the natural next step is a router in front and N game processes behind, each
owning a disjoint set of matches. When you do that, move the ledger to Postgres
first — the atomicity guarantee above depends on a single writer, and SQLite
gives you that for free only while there is one process. `SELECT … FOR UPDATE`
on the two user rows (ordered by id, to avoid deadlock) reproduces it in Postgres.

### Elo

A kill is scored as a decisive game between killer and victim, K=24. Beating a
higher-rated player moves both ratings more than farming a weaker one, which is
what makes SBMM meaningful and blunts the incentive to hunt beginners. Ratings
are zero-sum per kill and floored at 100.

### Why movement looks smooth

Three separate things, and it's worth keeping them straight because only one of
them is netcode.

**Prediction is exact.** Client and server run the same `V.step` on the same
inputs, so the authoritative correction is a no-op. `npm run test:predict`
measures it over eight seconds of walking, turning, strafing and jumping and
reports **0.00 cm** mean error. That matters: if corrections were large, no
amount of visual smoothing would help — it would just be hiding a desync.

**Rendering interpolates between physics steps.** Simulation runs on a fixed
60Hz timer and rendering on `requestAnimationFrame`; these are independent
clocks that drift. Sampling the raw simulated position leaves the camera frozen
on any frame landing between two steps, which reads as stutter. The camera
instead interpolates using real elapsed time since the last step, which takes
frozen frames to zero.

**Corrections and step-ups are eased, not snapped.** A server correction or a
one-block auto-climb moves the body instantly. Both are absorbed into a
visual-only offset that decays over ~100ms, so the camera drifts to the truth
instead of jumping to it. Large discrepancies (respawn, teleport) deliberately
skip the easing — sliding a player across the map would be worse than a cut.

Camera shake is rotation-only for the same reason: jittering the camera's
*position* is indistinguishable from the stutter above.

### Proximity voice

Voice is **relayed through the server**, not peer-to-peer, and the server drops
frames for anyone out of earshot before sending them. That choice is deliberate:
in a P2P mesh every client receives everyone's audio and applies the distance
falloff itself, so a modified client just raises the gain and listens across the
map. Hearing where people are is worth money here, so range is enforced where a
client cannot reach it — the same reason hit detection is server-side.

The wire format is 16 kHz mono G.711 µ-law in 20 ms frames (~128 kbps while
actually speaking), gated by voice activity detection so silence costs nothing.
It sounds like radio chatter, which suits the game. Frames are opaque to the
server — it never decodes them, only decides who receives them. Audio is
spatialised at the speaker's *interpolated* position, so a voice comes from the
avatar you can see rather than where they were when the packet left.

Range is `VOICE_RANGE` (34 blocks). `npm run test:voice` asserts the invariant
directly — relayed if and only if in range — plus that speakers never hear their
own audio echoed back and that oversized frames are dropped.

**Voice needs a secure context.** Over the HTTPS tunnel or on localhost it
works; on a plain `http://` LAN address the browser blocks microphone access
entirely. The game detects this and says so rather than failing silently.

### Pronouns

Players can set pronouns in the lobby; they appear on the in-game nameplate and
next to the name in chat. Free text rather than a fixed list, capped at 24
characters, stripped of control characters, and escaped everywhere it renders.
Changes apply live — no need to rejoin the match.

### Client caching

App code is served `no-store`, vendored libraries with a long max-age. This is
not a micro-optimisation: without it a browser holds on to an old `game.js`, and
a player keeps running a stale client after an update. That surfaces as a
feature appearing broken for one person and fine for everyone else, which is a
miserable thing to debug — it cost a round of confusion over pronouns not
showing up.

### Sound

Every sound is synthesised at runtime from noise bursts and oscillators
([public/js/audio.js](public/js/audio.js)) — there are no audio files, so the
game stays a single server with no binary assets, exactly like the procedural
block textures. **M** mutes, and the choice persists.

Footsteps are **distance-based, not timed**: the cadence comes from how far you
actually moved, so strafing, wall-sliding and stepping stay in sync instead of
drifting against a timer. The sound changes with the block underfoot — grass and
sand are soft and low, stone and iron are sharp, wood is hollow.

Other players' footsteps and gunfire are positional (HRTF panning), and the two
roll off very differently on purpose:

| | audible to | why |
|---|---|---|
| Footsteps | ~20 blocks | a proximity alarm — someone is *close* |
| Gunfire | the whole map | "where is the fighting" is a navigation cue |

Measured peak amplitude at the master bus: a local shot is 0.33, the same shot
96 blocks away is 0.023, and a footstep 30 blocks away is inaudible. Under
sustained fire the voice count settles back to zero, and when the graph is
saturated other players' shots are dropped before your own — your weapon's
report is feedback you act on.

**Dying is loud.** A synthesised human yell — a sawtooth "vocal cord" with heavy
vibrato sliding downward, shaped by bandpass filters on the formants of an
"aaah", plus noise for throat rasp — followed by the character shouting
`DEATH_LINE` (edit it at the top of [audio.js](public/js/audio.js)) through the
browser's own speech synthesis. It peaks at 0.52 against a gunshot's 0.33, with
a limiter set high enough to keep the peaks: the joke is that it's obnoxious,
and a squashed scream would just sound broken instead of funny.

Other players' deaths scream from their position; only your own death speaks the
line, since speech synthesis cannot be spatialised. Speech is queued after the
scream rather than under it, and waits for voices to load — an utterance queued
before they exist is silently dropped, which is exactly how it failed the first
time.

### Fault tolerance and combat logging

These are the same mechanism viewed from two sides.

When your socket drops, your avatar **stays in the arena for 5 seconds** and
remains killable and worth $3. You cannot dodge a death by pulling your ethernet
cable. If you reconnect inside that window, you rebind to the same avatar and
resume — a network blip costs you nothing.

The client backs off exponentially across 6 reconnect attempts. The server also
pings every 10 seconds and terminates sockets that stop responding, so a client
that vanishes without closing cleanly still starts its grace timer promptly
rather than lingering as a ghost.

**Input sequence numbers must be reset on every rejoin.** The server ignores any
input whose sequence it has already seen, which is what stops replayed packets.
A reconnecting client restarts its counter at zero, so if the server keeps the
old high-water mark, every input looks stale and is dropped — the player can
look around and shoot but cannot move, until their new counter climbs back past
the old one. After a few minutes of play that is a multi-minute freeze, and
"leave and rejoin" appears to fix it only because leaving destroys the avatar
and allocates a fresh one. Both sides now reset on `welcome`.
`npm run test:reconnect` covers it: with the reset the player moves 8.2 blocks
after reconnecting, without it exactly 0.00.

Withdrawals are blocked while you're in a match, which preserves the invariant
that a live player can always cover a death.

### Anti-cheat posture

Server authority is the foundation, and on top of it: input messages are capped
at 512 bytes and 120/sec per player, fire rate is enforced server-side (the
client's claimed cooldown is ignored), bullets are substepped so they cannot
tunnel through a player at high speed, and spawn protection drops the moment you
fire so it can't be used as a shield.

What this build does *not* have, and what you'd want before real money:
aim-pattern analysis for aimbot detection, input-timing fingerprinting, rate
limits on account creation, and device fingerprinting to catch one person
running both sides of a match to launder a chargeback.

---

## Going live

This is the part that matters more than the code.

**Legal.** A game where players stake real money and the outcome transfers it is
regulated. Depending on jurisdiction it may be prohibited outright, permitted as
a skill game, or require a gambling license. In the US this is **state by
state** — Washington, Arizona, Arkansas, Delaware, Louisiana, Montana and South
Dakota are the usual problem list for real-money skill gaming, and several
others are unsettled. You need a gaming attorney's opinion on your specific
mechanic before you take a dollar. This is not a step you can defer until after
launch.

**Compliance.** Real-money operation means age verification (18+/21+ by
jurisdiction), KYC identity checks, AML monitoring and reporting, geo-fencing
with VPN detection, responsible-gaming controls (deposit limits, self-exclusion,
cool-off periods), and per-jurisdiction tax reporting. In the US, net winnings
over $600/year generally require a 1099-MISC.

**Payments.** Stripe's restricted business list covers gambling and requires
explicit pre-approval; onboarding as a skill-gaming operator without disclosing
it will get funds frozen and the account terminated. Same for PayPal and most
mainstream processors. Player funds must be held **segregated** from operating
capital — that float in the audit output is not your revenue, it's money you owe
players. Also budget for chargeback fraud, which is severe in this category:
deposit, lose, dispute.

**Crypto is not a shortcut.** Settling in USDC doesn't exit the regulatory
perimeter; it typically adds money-transmitter analysis on top of the gaming
question. The wallet-linking in this build stores an address and validates its
format — it does **not** verify ownership. Add a SIWE signed-nonce challenge
before it means anything, and note that payouts to an unverified address are how
you become a money-laundering endpoint.

**Business model.** At the moment this build is purely zero-sum — the house takes
nothing, which is why `npm run audit` reports combat net zero. A real operation
needs a rake (say 5-10% of each transfer, credited to a house account) or the
infrastructure is a pure cost center. Add that as a third leg in `killTransfer`,
inside the same transaction.

### What to change in code

1. **Postgres, not SQLite.** See scaling above. Do this before multi-process.
2. **Real Stripe.** Set `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` and deposits
   route through Stripe Checkout, credited by the webhook. Use test keys.
   Withdrawals are sandbox-only by design — real payouts need Stripe Connect with
   KYC, which is a project of its own.
3. **HTTPS and `Secure` cookies.** Session cookies are `HttpOnly; SameSite=Lax`
   but not `Secure`, because this runs on localhost. Add it behind TLS.
4. **CSRF protection.** Same-site cookies cover most of it; add explicit tokens
   on the money endpoints.
5. **Rate-limit auth and deposits** at the edge.
6. **Move the tick loop off the main thread** if you push past a few hundred
   concurrent players in one process.

---

## Configuration

Everything tunable lives in [server/config.js](server/config.js). The ones you'll
actually touch:

| Setting | Default | What it does |
|---|---|---|
| `STAKE_CENTS` | `300` | The $3 per kill/death |
| `MAX_MATCH_PLAYERS` | `8` | Players per match before a new one spins up |
| `ELO_BAND` | `300` | How far apart SBMM will pair people |
| `DISCONNECT_GRACE_S` | `5` | How long your body stays killable after a drop |
| `TICK_HZ` | `30` | Server simulation rate |
| `RESPAWN_S` | `3` | Respawn delay |

Environment variables: `PORT`, `DATA_DIR`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `PUBLIC_URL`.

---

## Controls

**WASD** move · **mouse** look · **click** fire · **Space** jump · **R** reload ·
**T** or **Enter** chat · **M** mute sound · **Esc** release the mouse (or close
chat).

Chat goes to everyone in your match. While the box is open every keystroke goes
to it — otherwise typing "was" would walk you off a ledge mid-sentence. The
sender's name comes from the authenticated session, never from the message, so
nobody can talk as someone else; messages are rate limited, capped at 120
characters, stripped of control characters, and HTML-escaped at render.

Click once to lock the mouse. If the browser refuses pointer lock — which happens
in embedded webviews and in iframes without `allow="pointer-lock"` — the game
falls back to free-look (drag to turn) rather than trapping you at the prompt,
and says so in the feed. **Open it in a normal browser tab for proper aiming.**

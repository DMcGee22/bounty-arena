// Hybrid audio: SFX are synthesised at runtime (no sample bank). Music loads
// open-source cyberpunk loops from /audio/music/ (CC0 — see LICENSE.txt) and
// falls back to a procedural bed if fetch/decode fails.
//
// Positional sounds (other players' footsteps and gunfire) run through a
// PannerNode so you can hear which direction someone is coming from. That is a
// genuine gameplay signal, not decoration: footsteps are how you notice the
// person about to take three dollars off you.

const MASTER_VOLUME = 0.78;
const MUSIC_MASTER = 0.55; // sit under gunfire; intensity still lifts it

// Single continuous loop (no multi-track crossfades — different BPMs clash).
// Intensity only rides gain/filter so the beat never jumps.
// Track: CC0 "new_factory_129bpm" from T&T Free Cyberpunk Pack 2 (OpenGameArt).
const MUSIC_URL = '/audio/music/combat_factory.ogg';
// Prefer factory; if missing, fall through this list (still one at a time)
const MUSIC_FALLBACKS = [
  '/audio/music/combat_factory.ogg',
  '/audio/music/combat_aifight.ogg',
  '/audio/music/combat_overload.ogg',
];

let ctx = null;
let master = null;
let sfxBus = null;
let musicBus = null;
let noiseBuffer = null;
let enabled = true;
let musicEnabled = true;
let unlocked = false;

// Cheap concurrency guard — a firefight can otherwise stack dozens of voices
// and turn into mush (and eat CPU).
let activeVoices = 0;
const MAX_VOICES = 36;

// Music state — one streamed loop preferred; procedural is the fallback bed
let musicNodes = null;       // procedural oscillators (fallback only)
let musicLoop = null;        // { src, gain, filter } single stream layer
let musicBuffer = null;      // decoded AudioBuffer
let musicLoadPromise = null;
let musicMode = 'none';      // 'stream' | 'procedural' | 'none'
let combatIntensity = 0;     // 0..1, decays over time
let musicStarted = false;

function init() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = enabled ? MASTER_VOLUME : 0;
  master.connect(ctx.destination);

  sfxBus = ctx.createGain();
  sfxBus.gain.value = 1.15; // punchier SFX
  sfxBus.connect(master);

  musicBus = ctx.createGain();
  musicBus.gain.value = 0;
  musicBus.connect(master);

  // one second of white noise, reused by every noise-based voice
  const len = Math.floor(ctx.sampleRate);
  noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

  // Warm the music cache in the background (decode waits for unlock/resume)
  loadMusicBuffers().catch(() => {});
  return ctx;
}

// Browsers start the context suspended until a real user gesture.
function unlock() {
  if (!ctx) init();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  unlocked = true;
}

function ready() {
  return !!ctx && enabled && ctx.state === 'running';
}

function setEnabled(on) {
  enabled = on;
  if (master && ctx) {
    master.gain.setTargetAtTime(on ? MASTER_VOLUME : 0, ctx.currentTime, 0.02);
  }
  return enabled;
}

function isEnabled() { return enabled; }

// ---- listener --------------------------------------------------------------

function setListener(pos, forward, up) {
  if (!ctx) return;
  const l = ctx.listener;
  const t = ctx.currentTime;
  if (l.positionX) {
    l.positionX.setTargetAtTime(pos.x, t, 0.02);
    l.positionY.setTargetAtTime(pos.y, t, 0.02);
    l.positionZ.setTargetAtTime(pos.z, t, 0.02);
    l.forwardX.setTargetAtTime(forward.x, t, 0.02);
    l.forwardY.setTargetAtTime(forward.y, t, 0.02);
    l.forwardZ.setTargetAtTime(forward.z, t, 0.02);
    l.upX.setTargetAtTime(up.x, t, 0.02);
    l.upY.setTargetAtTime(up.y, t, 0.02);
    l.upZ.setTargetAtTime(up.z, t, 0.02);
  } else if (l.setPosition) {
    l.setPosition(pos.x, pos.y, pos.z);
    l.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }
}

// Returns the node a voice should connect to: a positioned panner, or the
// master bus for sounds that come from the player themselves.
function destinationFor(pos, refDistance, maxDistance, rolloff = 1.1) {
  const bus = sfxBus || master;
  if (!pos) return bus;
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = refDistance;
  panner.maxDistance = maxDistance;
  panner.rolloffFactor = rolloff;
  if (panner.positionX) {
    panner.positionX.value = pos.x;
    panner.positionY.value = pos.y;
    panner.positionZ.value = pos.z;
  } else if (panner.setPosition) {
    panner.setPosition(pos.x, pos.y, pos.z);
  }
  panner.connect(bus);
  return panner;
}

function voice(node, duration) {
  activeVoices++;
  const done = () => { activeVoices = Math.max(0, activeVoices - 1); try { node.disconnect(); } catch {} };
  setTimeout(done, Math.ceil(duration * 1000) + 60);
}

// ---- building blocks -------------------------------------------------------

function noiseBurst(dest, { dur, gain, type, freq, q = 1, rate = 1, attack = 0.001 }) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  src.playbackRate.value = rate;
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  // Boost all SFX for more adrenaline
  const gOut = gain * 1.45;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gOut, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  src.connect(filter).connect(g).connect(dest || sfxBus || master);
  src.start(t);
  src.stop(t + dur + 0.02);
  voice(g, dur);
}

function toneSweep(dest, { from, to, dur, gain, type = 'sine' }) {
  const osc = ctx.createOscillator();
  osc.type = type;
  const g = ctx.createGain();
  const t = ctx.currentTime;
  const gOut = gain * 1.4;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gOut, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  osc.connect(g).connect(dest || sfxBus || master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  voice(g, dur);
}

// ---- material character ----------------------------------------------------

// Block ids come from the shared voxel module; kept as plain numbers here so
// this file has no imports and can load before anything else.
const GRASS = 1, DIRT = 2, STONE = 3, COBBLE = 4, PLANKS = 5, LOG = 6,
      LEAVES = 7, SAND = 8, BRICK = 9, IRON = 10;

const MATERIALS = {
  [GRASS]:  { type: 'bandpass', freq: 1500, q: 0.7, dur: 0.085, gain: 0.32 },
  [LEAVES]: { type: 'bandpass', freq: 2100, q: 0.6, dur: 0.075, gain: 0.28 },
  [DIRT]:   { type: 'lowpass',  freq: 760,  q: 0.8, dur: 0.080, gain: 0.34 },
  [SAND]:   { type: 'lowpass',  freq: 900,  q: 0.6, dur: 0.090, gain: 0.30 },
  [STONE]:  { type: 'bandpass', freq: 2600, q: 1.5, dur: 0.055, gain: 0.30 },
  [COBBLE]: { type: 'bandpass', freq: 2400, q: 1.4, dur: 0.060, gain: 0.31 },
  [BRICK]:  { type: 'bandpass', freq: 2200, q: 1.5, dur: 0.055, gain: 0.29 },
  [IRON]:   { type: 'bandpass', freq: 3400, q: 2.2, dur: 0.055, gain: 0.26 },
  [PLANKS]: { type: 'bandpass', freq: 1050, q: 2.0, dur: 0.085, gain: 0.34 },
  [LOG]:    { type: 'bandpass', freq: 850,  q: 2.0, dur: 0.090, gain: 0.34 },
};
const DEFAULT_MAT = MATERIALS[STONE];

// ---- the sounds ------------------------------------------------------------

function footstep(block, pos, volume = 1) {
  if (!ready() || activeVoices > MAX_VOICES) return;
  const m = MATERIALS[block] || DEFAULT_MAT;
  // Footsteps roll off hard on purpose: they should tell you someone is CLOSE,
  // not blend into a wash of distant shuffling from across the arena.
  const dest = destinationFor(pos, 3, 30, 1.5);
  const vary = 0.85 + Math.random() * 0.3;
  noiseBurst(dest, {
    dur: m.dur * vary,
    gain: m.gain * volume,
    type: m.type,
    freq: m.freq * vary,
    q: m.q,
    rate: 0.9 + Math.random() * 0.25,
  });
  if (pos) voice(dest, m.dur + 0.1);
}

function land(block, strength = 1) {
  if (!ready()) return;
  const m = MATERIALS[block] || DEFAULT_MAT;
  noiseBurst(master, {
    dur: m.dur * 1.7, gain: Math.min(0.55, m.gain * 1.5 * strength),
    type: 'lowpass', freq: Math.max(420, m.freq * 0.55), q: 0.9, rate: 0.8,
  });
  toneSweep(master, { from: 130, to: 55, dur: 0.11, gain: 0.16 * strength });
}

// Layered gunshot: noise-only crack + body + tail. No oscillator tones —
// a sine sweep under every shot read as a weird musical "boop".
// Fired without a position for your own weapon, with one for everyone else's.
function shoot(pos) {
  if (!ready()) return;
  // Under extreme load, drop other people's shots rather than your own — your
  // weapon's report is feedback you act on, theirs is situational awareness.
  if (pos && activeVoices > MAX_VOICES * 1.5) return;
  const far = !!pos;
  // Gunfire carries: a fight on the far side of the map should still register,
  // because "where is the shooting" is how you decide where to go.
  const dest = destinationFor(pos, 9, 150, 0.8);
  const vary = 0.92 + Math.random() * 0.16;

  // crack
  noiseBurst(dest, {
    dur: 0.045 * vary, gain: far ? 0.34 : 0.44,
    type: 'highpass', freq: 3200 * vary, q: 0.7, rate: 1.1,
  });
  // body
  noiseBurst(dest, {
    dur: 0.16 * vary, gain: far ? 0.32 : 0.40,
    type: 'lowpass', freq: 1100 * vary, q: 1.0, rate: 0.95,
  });
  // low thump as filtered noise (not a pitched oscillator)
  noiseBurst(dest, {
    dur: 0.10 * vary, gain: far ? 0.22 : 0.30,
    type: 'lowpass', freq: 180 * vary, q: 0.8, rate: 0.55,
  });
  // short tail so it doesn't sound clipped indoors
  noiseBurst(dest, {
    dur: 0.28, gain: far ? 0.09 : 0.11,
    type: 'lowpass', freq: 700, q: 0.5, rate: 0.6, attack: 0.012,
  });
  if (pos) voice(dest, 0.4);
}

function impact(block, pos) {
  if (!ready() || activeVoices > MAX_VOICES) return;
  const m = MATERIALS[block] || DEFAULT_MAT;
  const dest = destinationFor(pos, 3, 48);
  noiseBurst(dest, {
    dur: m.dur * 0.9, gain: m.gain * 0.75,
    type: m.type, freq: m.freq * (0.9 + Math.random() * 0.3), q: m.q * 1.4,
    rate: 1.15,
  });
  if (pos) voice(dest, m.dur + 0.1);
}

function fleshImpact(pos) {
  if (!ready()) return;
  const dest = destinationFor(pos, 3, 48);
  noiseBurst(dest, { dur: 0.09, gain: 0.30, type: 'lowpass', freq: 520, q: 1.2, rate: 0.85 });
  if (pos) voice(dest, 0.2);
}

// Rising blip on a hit, higher and brighter for a headshot — the audio half of
// the hitmarker, which is what actually tells you a shot landed.
function hitmarker(headshot, lethal) {
  if (!ready()) return;
  pulseCombat(lethal ? 0.4 : headshot ? 0.28 : 0.16);
  const base = lethal ? 1500 : headshot ? 1250 : 900;
  toneSweep(master, { from: base, to: base * 1.5, dur: 0.07, gain: 0.22, type: 'square' });
  if (lethal) toneSweep(master, { from: base * 1.5, to: base * 2.1, dur: 0.10, gain: 0.18, type: 'square' });
}

function reload() {
  if (!ready()) return;
  // mag out, then mag in
  noiseBurst(master, { dur: 0.05, gain: 0.22, type: 'bandpass', freq: 2600, q: 3, rate: 1.2 });
  setTimeout(() => {
    if (!ready()) return;
    noiseBurst(master, { dur: 0.07, gain: 0.26, type: 'bandpass', freq: 1700, q: 2.5, rate: 0.9 });
    toneSweep(master, { from: 220, to: 120, dur: 0.06, gain: 0.10 });
  }, 620);
}

function hurt() {
  if (!ready()) return;
  noiseBurst(master, { dur: 0.14, gain: 0.26, type: 'lowpass', freq: 640, q: 1.0, rate: 0.8 });
  toneSweep(master, { from: 300, to: 120, dur: 0.16, gain: 0.14, type: 'sawtooth' });
}

function death() {
  // Disabled — death audio removed from the game loop.
}

// ---- the death scream ------------------------------------------------------

// What the character yells when you die. Change or empty it to taste.
const DEATH_LINE = 'FUCK! I DIED!';

function distortionCurve(amount) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + amount) * x) / (1 + amount * Math.abs(x));
  }
  return curve;
}

// A synthesised human yell: a sawtooth "vocal cord" with heavy vibrato sliding
// downward, shaped by three bandpass filters sitting on the formants of an
// "aaah" vowel, plus a noise layer for throat rasp. Deliberately mixed far
// louder than anything else — a limiter keeps "absurdly loud" from turning into
// "clipped mush", which would just sound broken rather than funny.
function deathScream(/* pos, speak */) {
  // Disabled — death screams / "I DIED" TTS removed.
}

// speechSynthesis is fiddly: voices load asynchronously and an utterance queued
// before they exist is silently dropped, calling cancel() immediately before
// speak() kills the new utterance in Chrome, and the queue can be left paused.
// This handles all three rather than firing and hoping.
function speakLine(text) {
  const synth = window.speechSynthesis;
  if (!synth || !text || !enabled) return;

  let spoken = false;
  const say = () => {
    if (spoken) return;
    spoken = true;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.volume = 1;
      u.rate = 1.05;
      u.pitch = 1.8;
      const voices = synth.getVoices();
      const v = voices.find((x) => /^en[-_]/i.test(x.lang) && x.localService)
             || voices.find((x) => /^en[-_]/i.test(x.lang))
             || voices[0];
      if (v) u.voice = v;
      synth.resume();
      synth.speak(u);
    } catch {}
  };

  if (synth.getVoices().length === 0) {
    synth.addEventListener('voiceschanged', say, { once: true });
    setTimeout(say, 300);        // in case the event never arrives
  } else {
    say();
  }
}

function cash(positive) {
  if (!ready()) return;
  if (positive) {
    toneSweep(master, { from: 780, to: 1180, dur: 0.10, gain: 0.15, type: 'triangle' });
    setTimeout(() => ready() && toneSweep(master, { from: 1180, to: 1560, dur: 0.14, gain: 0.13, type: 'triangle' }), 85);
  } else {
    toneSweep(master, { from: 520, to: 200, dur: 0.28, gain: 0.14, type: 'triangle' });
  }
}

// ---- Throwables ------------------------------------------------------------

function throwWhoosh(pos) {
  if (!ready()) return;
  const dest = destinationFor(pos, 2, 40, 0.7) || master;
  noiseBurst(dest, { dur: 0.12, gain: 0.18, type: 'bandpass', freq: 900, q: 1.2, rate: 1.3 });
  if (pos) voice(dest, 0.2);
}

function rpgLaunch(pos) {
  if (!ready()) return;
  const dest = destinationFor(pos, 4, 80, 0.85) || master;
  // whoosh + hard backblast
  noiseBurst(dest, { dur: 0.08, gain: 0.4, type: 'highpass', freq: 1800, q: 0.8, rate: 1.4 });
  noiseBurst(dest, { dur: 0.28, gain: 0.38, type: 'lowpass', freq: 500, q: 0.9, rate: 0.7 });
  toneSweep(dest, { from: 120, to: 40, dur: 0.22, gain: 0.28 });
  // short hiss trail
  noiseBurst(dest, { dur: 0.45, gain: 0.12, type: 'bandpass', freq: 1400, q: 0.6, rate: 1.1, attack: 0.02 });
  if (pos) voice(dest, 0.5);
}

function explode(pos) {
  if (!ready()) return;
  pulseCombat(0.45);
  const dest = destinationFor(pos, 8, 120, 0.9) || master;
  // sharp crack
  noiseBurst(dest, { dur: 0.06, gain: 0.45, type: 'highpass', freq: 2400, q: 0.7, rate: 1.2 });
  // body boom
  noiseBurst(dest, { dur: 0.35, gain: 0.42, type: 'lowpass', freq: 380, q: 0.8, rate: 0.55 });
  toneSweep(dest, { from: 90, to: 28, dur: 0.32, gain: 0.32 });
  // debris rattle
  noiseBurst(dest, { dur: 0.4, gain: 0.14, type: 'bandpass', freq: 900, q: 1.4, rate: 0.9, attack: 0.04 });
  if (pos) voice(dest, 0.55);
}

function rpgExplode(pos) {
  if (!ready()) return;
  pulseCombat(0.55);
  const dest = destinationFor(pos, 10, 150, 0.95) || master;
  // bigger, dirtier than HE
  noiseBurst(dest, { dur: 0.08, gain: 0.5, type: 'highpass', freq: 2000, q: 0.6, rate: 1.0 });
  noiseBurst(dest, { dur: 0.55, gain: 0.5, type: 'lowpass', freq: 280, q: 0.7, rate: 0.45 });
  toneSweep(dest, { from: 70, to: 22, dur: 0.48, gain: 0.38 });
  noiseBurst(dest, { dur: 0.7, gain: 0.18, type: 'lowpass', freq: 500, q: 0.5, rate: 0.5, attack: 0.05 });
  if (pos) voice(dest, 0.75);
}

function smokePop(pos) {
  if (!ready()) return;
  const dest = destinationFor(pos, 4, 60, 0.7) || master;
  noiseBurst(dest, { dur: 0.2, gain: 0.22, type: 'lowpass', freq: 700, q: 1.0, rate: 0.8 });
  toneSweep(dest, { from: 200, to: 80, dur: 0.15, gain: 0.1 });
  if (pos) voice(dest, 0.3);
}

function flashbang(pos) {
  if (!ready()) return;
  const dest = pos ? destinationFor(pos, 6, 90, 0.85) : master;
  // piercing ring
  noiseBurst(dest || master, { dur: 0.05, gain: 0.4, type: 'highpass', freq: 4500, q: 1.2, rate: 1.5 });
  toneSweep(dest || master, { from: 1800, to: 900, dur: 0.18, gain: 0.22, type: 'square' });
  noiseBurst(dest || master, { dur: 0.25, gain: 0.2, type: 'bandpass', freq: 2200, q: 2, rate: 1.2 });
  if (pos && dest) voice(dest, 0.35);
}

// ---- combat music (one CC0 loop + procedural fallback) ---------------------

function loadMusicBuffers() {
  if (!ctx) return Promise.resolve(false);
  if (musicBuffer) return Promise.resolve(true);
  if (musicLoadPromise) return musicLoadPromise;
  musicLoadPromise = (async () => {
    const urls = [MUSIC_URL, ...MUSIC_FALLBACKS.filter((u) => u !== MUSIC_URL)];
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ab = await res.arrayBuffer();
        musicBuffer = await ctx.decodeAudioData(ab.slice(0));
        return true;
      } catch (err) {
        console.warn('[audio] music load failed:', url, err?.message || err);
      }
    }
    musicBuffer = null;
    return false;
  })();
  return musicLoadPromise;
}

function stopStreamLoop() {
  if (!musicLoop || !ctx) { musicLoop = null; return; }
  const t = ctx.currentTime;
  try {
    musicLoop.gain.gain.cancelScheduledValues(t);
    musicLoop.gain.gain.setTargetAtTime(0.0001, t, 0.1);
    musicLoop.src.stop(t + 0.4);
  } catch { /* already stopped */ }
  musicLoop = null;
}

function startProceduralMusic() {
  if (!ctx || musicNodes || !musicEnabled) return;
  const t = ctx.currentTime;

  const bass = ctx.createOscillator();
  bass.type = 'sawtooth';
  bass.frequency.value = 55;
  const bassF = ctx.createBiquadFilter();
  bassF.type = 'lowpass';
  bassF.frequency.value = 120;
  const bassG = ctx.createGain();
  bassG.gain.value = 0.0001;
  bass.connect(bassF).connect(bassG).connect(musicBus);

  const pad = ctx.createOscillator();
  pad.type = 'triangle';
  pad.frequency.value = 110;
  const pad2 = ctx.createOscillator();
  pad2.type = 'sine';
  pad2.frequency.value = 164.8;
  const padG = ctx.createGain();
  padG.gain.value = 0.0001;
  pad.connect(padG);
  pad2.connect(padG);
  padG.connect(musicBus);

  const arp = ctx.createOscillator();
  arp.type = 'square';
  arp.frequency.value = 220;
  const arpG = ctx.createGain();
  arpG.gain.value = 0.0001;
  const arpF = ctx.createBiquadFilter();
  arpF.type = 'bandpass';
  arpF.frequency.value = 800;
  arpF.Q.value = 4;
  arp.connect(arpF).connect(arpG).connect(musicBus);

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 1.8;
  const lfoG = ctx.createGain();
  lfoG.gain.value = 0.02;
  lfo.connect(lfoG).connect(bassG.gain);

  bass.start(t);
  pad.start(t);
  pad2.start(t);
  arp.start(t);
  lfo.start(t);

  musicNodes = { bass, pad, pad2, arp, lfo, bassG, padG, arpG, bassF, arpF };
  musicMode = 'procedural';
  musicStarted = true;
  musicBus.gain.setTargetAtTime(musicEnabled ? MUSIC_MASTER * 0.5 : 0, t, 0.3);
  applyMusicIntensity();
}

function stopProceduralMusic() {
  if (!musicNodes || !ctx) { musicNodes = null; return; }
  const t = ctx.currentTime;
  try {
    for (const k of ['bass', 'pad', 'pad2', 'arp', 'lfo']) {
      try { musicNodes[k].stop(t + 0.35); } catch {}
    }
  } catch {}
  musicNodes = null;
}

function startStreamMusic() {
  if (!ctx || !musicBuffer || musicLoop) return false;
  const src = ctx.createBufferSource();
  src.buffer = musicBuffer;
  src.loop = true;
  // Gentle lowpass — opens up slightly in fights (same track, no switch)
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2200;
  filter.Q.value = 0.7;
  const g = ctx.createGain();
  g.gain.value = 0.0001;
  src.connect(filter);
  filter.connect(g);
  g.connect(musicBus);
  // Always start at 0 so the loop downbeat is consistent every session
  src.start(0);
  musicLoop = { src, gain: g, filter };
  musicMode = 'stream';
  musicStarted = true;
  const t = ctx.currentTime;
  musicBus.gain.cancelScheduledValues(t);
  musicBus.gain.setTargetAtTime(musicEnabled ? MUSIC_MASTER : 0, t, 0.35);
  applyMusicIntensity();
  return true;
}

function startMusic() {
  if (!ctx || !musicEnabled || musicStarted) return;
  // Soft procedural bed while the file decodes (no silence after click)
  startProceduralMusic();
  loadMusicBuffers().then((ok) => {
    if (!ok || !musicEnabled || !unlocked) return;
    if (musicMode === 'stream' && musicLoop) return;
    // Crossfade out procedural, then start the single loop once
    stopProceduralMusic();
    musicStarted = false;
    musicMode = 'none';
    if (!startStreamMusic()) startProceduralMusic();
  });
}

function stopMusic() {
  if (!ctx) return;
  const t = ctx.currentTime;
  try { musicBus.gain.setTargetAtTime(0, t, 0.12); } catch {}
  stopStreamLoop();
  stopProceduralMusic();
  musicStarted = false;
  musicMode = 'none';
}

/** Raise combat intensity 0..1 (hits, kills, explosions). Decays automatically. */
function pulseCombat(amount = 0.25) {
  // Softer pulses so music doesn't pump chaotically every shot
  combatIntensity = Math.min(1, combatIntensity + amount * 0.65);
  if (!musicStarted && musicEnabled && ready()) startMusic();
  applyMusicIntensity();
}

function tickMusic(dt) {
  if (!musicEnabled) return;
  // Slower decay = steadier bed instead of pumping in/out every second
  combatIntensity = Math.max(0, combatIntensity - dt * 0.055);
  applyMusicIntensity();
}

function applyMusicIntensity() {
  if (!ctx || !musicBus || !musicEnabled) return;
  const t = ctx.currentTime;
  // Smoothstep intensity so volume changes feel gradual
  const i = combatIntensity;
  const i2 = i * i * (3 - 2 * i);

  if (musicMode === 'stream' && musicLoop) {
    // One track: quiet while exploring, fuller in fights — never a second beat
    const level = 0.22 + i2 * 0.55; // 0.22 idle → ~0.77 hot
    musicLoop.gain.gain.setTargetAtTime(Math.max(0.0001, level), t, 0.55);
    // Open the filter a little in combat (brightness, not a new track)
    if (musicLoop.filter) {
      musicLoop.filter.frequency.setTargetAtTime(1800 + i2 * 4200, t, 0.7);
    }
    musicBus.gain.setTargetAtTime(MUSIC_MASTER, t, 0.4);
    return;
  }

  if (musicMode === 'procedural' && musicNodes) {
    musicBus.gain.setTargetAtTime(MUSIC_MASTER * (0.3 + i2 * 0.5), t, 0.35);
    musicNodes.bassG.gain.setTargetAtTime(0.035 + i2 * 0.12, t, 0.25);
    musicNodes.padG.gain.setTargetAtTime(0.022 + i2 * 0.05, t, 0.3);
    musicNodes.arpG.gain.setTargetAtTime(0.006 + i2 * 0.04, t, 0.25);
    musicNodes.bassF.frequency.setTargetAtTime(100 + i2 * 200, t, 0.3);
    musicNodes.arpF.frequency.setTargetAtTime(600 + i2 * 800, t, 0.25);
    try { musicNodes.lfo.frequency.setTargetAtTime(1.4 + i2 * 2.2, t, 0.35); } catch {}
  }
}

function setMusicEnabled(on) {
  musicEnabled = !!on;
  if (!musicEnabled) stopMusic();
  else if (unlocked && ready()) startMusic();
  return musicEnabled;
}

export default {
  init, unlock, ready, setEnabled, isEnabled,
  setListener, footstep, land,
  shoot,
  impact, fleshImpact,
  hitmarker, reload, hurt, death, cash, deathScream, speakLine,
  throwWhoosh, rpgLaunch, explode, rpgExplode, smokePop, flashbang,
  startMusic, stopMusic, pulseCombat, tickMusic, setMusicEnabled,
  get context() { return ctx; },
  get master() { return master; },
  get unlocked() { return unlocked; },
  get voices() { return activeVoices; },
  get intensity() { return combatIntensity; },
};

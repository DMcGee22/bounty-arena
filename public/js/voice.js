// Proximity voice chat.
//
// Audio is relayed through the server, not peer-to-peer, and the server drops
// frames for anyone out of earshot before they are sent. That matters: with a
// P2P mesh every client receives everyone's audio and applies the distance
// falloff itself, so a modified client simply turns the gain up and hears the
// whole map. Positional information is worth three dollars a kill here, so
// range is enforced where the client cannot reach it — same reason hit
// detection lives on the server.
//
// The wire format is 16 kHz mono G.711 µ-law in 20 ms frames: about 128 kbps
// while actually speaking, gated by voice activity detection so silence costs
// nothing. It sounds like radio chatter, which suits the game.

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320;          // 20 ms
const VAD_OPEN = 0.012;             // RMS to start transmitting
const VAD_CLOSE = 0.006;            // ...and to stop (hysteresis)
const VAD_HANGOVER_MS = 320;        // keep sending briefly after you stop
const JITTER_TARGET = 0.09;         // seconds of buffer before playback starts

// ---- G.711 µ-law -----------------------------------------------------------

const EXP_LUT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let v = 7;
  for (let mask = 0x40; mask && !(i & mask); mask >>= 1) v--;
  EXP_LUT[i] = Math.max(0, v);
}

function linearToMulaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  const exponent = EXP_LUT[(sample >> 7) & 0xff];
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function mulawToLinear(u) {
  u = ~u & 0xff;
  const sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

// ---- state -----------------------------------------------------------------

let ctx = null;
let voiceGain = null;
let stream = null;
let workletNode = null;
let sourceNode = null;
let sendFn = null;
let active = false;          // capture running
let micMuted = false;
let transmitting = false;
let lastVoiceAt = 0;
let status = 'off';          // off | requesting | live | denied | insecure | unsupported
let onStatusChange = null;
let localLevel = 0;

// resampler state
let resampleAcc = [];
const pending = [];          // Float32 samples at SAMPLE_RATE awaiting framing

// per-speaker playback
const speakers = new Map();  // id -> { panner, gain, nextTime, lastHeard }

function setStatus(s) {
  status = s;
  onStatusChange?.(s);
}

// ---- capture ---------------------------------------------------------------

const WORKLET_SRC = `
class VoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
`;

async function start(audioContext, send, statusCb) {
  ctx = audioContext;
  sendFn = send;
  onStatusChange = statusCb;
  if (active || !ctx) return status;

  // getUserMedia needs a secure context. Over the ngrok HTTPS tunnel or on
  // localhost this is fine, but a plain http:// LAN address is not, and the
  // failure is otherwise silent and confusing.
  if (!window.isSecureContext) { setStatus('insecure'); return status; }
  if (!navigator.mediaDevices?.getUserMedia) { setStatus('unsupported'); return status; }

  setStatus('requesting');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
  } catch {
    setStatus('denied');
    return status;
  }

  voiceGain = ctx.createGain();
  voiceGain.gain.value = 1;
  voiceGain.connect(ctx.destination);

  const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
  } catch {
    URL.revokeObjectURL(url);
    setStatus('unsupported');
    return status;
  }
  URL.revokeObjectURL(url);

  sourceNode = ctx.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(ctx, 'voice-capture');
  workletNode.port.onmessage = (e) => onCapturedBlock(e.data);
  // The worklet only forwards samples; it must still be pulled by the graph,
  // and a zero-gain sink avoids routing the mic back to the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sourceNode.connect(workletNode).connect(sink).connect(ctx.destination);

  active = true;
  setStatus('live');
  return status;
}

function stop() {
  active = false;
  transmitting = false;
  try { workletNode?.disconnect(); } catch {}
  try { sourceNode?.disconnect(); } catch {}
  try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
  workletNode = sourceNode = stream = null;
  pending.length = 0;
  resampleAcc = [];
  for (const [id] of speakers) dropSpeaker(id);
  setStatus('off');
}

// Decimate from the context rate (usually 48 kHz) down to 16 kHz, averaging
// the samples we collapse so we are not just aliasing the signal.
function onCapturedBlock(block) {
  if (!active || micMuted) return;
  const ratio = ctx.sampleRate / SAMPLE_RATE;
  for (let i = 0; i < block.length; i++) {
    resampleAcc.push(block[i]);
    if (resampleAcc.length >= ratio) {
      let sum = 0;
      for (const v of resampleAcc) sum += v;
      pending.push(sum / resampleAcc.length);
      resampleAcc = [];
    }
  }
  while (pending.length >= FRAME_SAMPLES) {
    emitFrame(pending.splice(0, FRAME_SAMPLES));
  }
}

function emitFrame(samples) {
  let sumSq = 0;
  for (const s of samples) sumSq += s * s;
  const rms = Math.sqrt(sumSq / samples.length);
  localLevel = localLevel * 0.7 + rms * 0.3;

  const now = performance.now();
  if (rms > VAD_OPEN) { transmitting = true; lastVoiceAt = now; }
  else if (transmitting && rms < VAD_CLOSE && now - lastVoiceAt > VAD_HANGOVER_MS) transmitting = false;
  if (!transmitting) return;

  const out = new Uint8Array(1 + FRAME_SAMPLES);
  out[0] = 0x01;   // voice frame
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[1 + i] = linearToMulaw((clamped * 32767) | 0);
  }
  sendFn?.(out);
}

// ---- playback --------------------------------------------------------------

function speakerFor(id) {
  let s = speakers.get(id);
  if (s) return s;
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF';
  panner.distanceModel = 'inverse';
  panner.refDistance = 4;
  panner.maxDistance = 40;
  panner.rolloffFactor = 1.1;
  const gain = ctx.createGain();
  gain.gain.value = 1.35;         // voice sits above the effects bus
  gain.connect(panner).connect(voiceGain);
  s = { panner, gain, nextTime: 0, lastHeard: 0 };
  speakers.set(id, s);
  return s;
}

function dropSpeaker(id) {
  const s = speakers.get(id);
  if (!s) return;
  try { s.gain.disconnect(); s.panner.disconnect(); } catch {}
  speakers.delete(id);
}

// `pos` comes from the interpolated avatar, so a voice is spatialised exactly
// where its owner is drawn rather than where they were when the packet left.
function receive(id, bytes, pos) {
  if (!ctx || !voiceGain) return;
  const s = speakerFor(id);
  s.lastHeard = performance.now();

  if (pos) {
    const t = ctx.currentTime;
    if (s.panner.positionX) {
      s.panner.positionX.setTargetAtTime(pos.x, t, 0.03);
      s.panner.positionY.setTargetAtTime(pos.y, t, 0.03);
      s.panner.positionZ.setTargetAtTime(pos.z, t, 0.03);
    } else if (s.panner.setPosition) {
      s.panner.setPosition(pos.x, pos.y, pos.z);
    }
  }

  const n = bytes.length;
  const buf = ctx.createBuffer(1, n, SAMPLE_RATE);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = mulawToLinear(bytes[i]) / 32768;

  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(s.gain);

  // Small jitter buffer. If the stream stalls the schedule falls behind real
  // time, so resync rather than accumulating unbounded delay.
  const now = ctx.currentTime;
  if (s.nextTime < now + 0.005) s.nextTime = now + JITTER_TARGET;
  else if (s.nextTime > now + 0.6) s.nextTime = now + JITTER_TARGET;
  src.start(s.nextTime);
  s.nextTime += buf.duration;
}

function prune() {
  const now = performance.now();
  for (const [id, s] of speakers) if (now - s.lastHeard > 4000) dropSpeaker(id);
}

// Who is audible right now, for the HUD.
function speakingIds() {
  const now = performance.now();
  const out = [];
  for (const [id, s] of speakers) if (now - s.lastHeard < 400) out.push(id);
  return out;
}

function setMicMuted(m) {
  micMuted = m;
  if (m) transmitting = false;
  return micMuted;
}

export default {
  start, stop, receive, prune, speakingIds, setMicMuted,
  get micMuted() { return micMuted; },
  get transmitting() { return transmitting; },
  get status() { return status; },
  get active() { return active; },
  get level() { return localLevel; },
  get speakerCount() { return speakers.size; },
};

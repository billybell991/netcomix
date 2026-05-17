// Audio + haptic feedback for page turns & panel ticks.
// Sounds are generated procedurally with WebAudio so we don't ship asset files.

let ctx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      const W = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
      const AC = W.AudioContext ?? W.webkitAudioContext;
      if (AC) ctx = new AC();
    } catch { /* ignore */ }
  }
  return ctx;
}

/** Airy "whoosh" — for panel-to-panel transitions. Filtered noise with a
 *  bandpass that sweeps upward then drops, evoking a quick air movement. */
export function playTick(): void {
  const ac = getCtx();
  if (!ac) return;
  const now = ac.currentTime;
  const dur = 0.18;
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
  const data = buf.getChannelData(0);
  // Soft pink-ish noise with a gentle envelope (fast attack, slower release)
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    const env = Math.sin(Math.PI * t); // 0 → 1 → 0
    // simple lowpassed noise for a less hissy character
    last = last * 0.55 + (Math.random() * 2 - 1) * 0.45;
    data[i] = last * env * 0.9;
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 1.1;
  bp.frequency.setValueAtTime(500, now);
  bp.frequency.exponentialRampToValueAtTime(2400, now + dur * 0.45);
  bp.frequency.exponentialRampToValueAtTime(700, now + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.35, now + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(bp).connect(g).connect(ac.destination);
  src.start(now);
  src.stop(now + dur + 0.02);
}

/** Realistic paper page turn — a crinkly rustle that swells and settles,
 *  followed by a soft low thump as the page lands. */
export function playPageTurn(): void {
  const ac = getCtx();
  if (!ac) return;
  const now = ac.currentTime;
  const dur = 0.55;

  // 1. Crinkly paper rustle: noise with rapid amplitude flutter + bandpass
  //    sweep that arcs across the mid-highs (paper fibres scraping).
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    // Envelope: quick attack, sustained mid, gentle tail.
    const env = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 1.4);
    // Flutter: fast random crackle on top of the steady noise — this is what
    // makes paper sound like paper rather than a smooth whoosh.
    const flutter = 0.55 + 0.45 * Math.random();
    data[i] = (Math.random() * 2 - 1) * env * flutter;
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const bp = ac.createBiquadFilter();
  bp.type = "bandpass";
  bp.Q.value = 0.9;
  bp.frequency.setValueAtTime(900, now);
  bp.frequency.exponentialRampToValueAtTime(3200, now + dur * 0.35);
  bp.frequency.exponentialRampToValueAtTime(1400, now + dur);
  const hp = ac.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 600;
  const rustleGain = ac.createGain();
  rustleGain.gain.setValueAtTime(0.0001, now);
  rustleGain.gain.exponentialRampToValueAtTime(0.32, now + 0.04);
  rustleGain.gain.exponentialRampToValueAtTime(0.16, now + dur * 0.55);
  rustleGain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
  src.connect(hp).connect(bp).connect(rustleGain).connect(ac.destination);
  src.start(now);
  src.stop(now + dur + 0.02);

  // 2. Soft low thump as the page settles — short sine pulse around 90Hz.
  const thumpAt = now + dur * 0.78;
  const thump = ac.createOscillator();
  thump.type = "sine";
  thump.frequency.setValueAtTime(110, thumpAt);
  thump.frequency.exponentialRampToValueAtTime(60, thumpAt + 0.12);
  const thumpGain = ac.createGain();
  thumpGain.gain.setValueAtTime(0.0001, thumpAt);
  thumpGain.gain.exponentialRampToValueAtTime(0.18, thumpAt + 0.01);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, thumpAt + 0.18);
  thump.connect(thumpGain).connect(ac.destination);
  thump.start(thumpAt);
  thump.stop(thumpAt + 0.2);
}

export function hapticLight(): void {
  if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(10);
}

export function hapticMedium(): void {
  if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([15, 25, 15]);
}

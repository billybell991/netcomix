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

/** Short crisp "tick" — for panel-to-panel snap. */
export function playTick(): void {
  const ac = getCtx();
  if (!ac) return;
  const now = ac.currentTime;
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = "square";
  o.frequency.setValueAtTime(1800, now);
  o.frequency.exponentialRampToValueAtTime(900, now + 0.03);
  g.gain.setValueAtTime(0.08, now);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
  o.connect(g).connect(ac.destination);
  o.start(now);
  o.stop(now + 0.06);
}

/** Paper-flick "swoosh" — for page turn. */
export function playPageTurn(): void {
  const ac = getCtx();
  if (!ac) return;
  const now = ac.currentTime;
  const buf = ac.createBuffer(1, ac.sampleRate * 0.18, ac.sampleRate);
  const data = buf.getChannelData(0);
  // Noise that ramps down — like a paper flick
  for (let i = 0; i < data.length; i++) {
    const t = i / data.length;
    data[i] = (Math.random() * 2 - 1) * (1 - t) * 0.6;
  }
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 1200;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.4, now);
  src.connect(filter).connect(g).connect(ac.destination);
  src.start(now);
}

export function hapticLight(): void {
  if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(10);
}

export function hapticMedium(): void {
  if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([15, 25, 15]);
}

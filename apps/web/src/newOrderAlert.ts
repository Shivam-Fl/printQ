/** Shop dashboard: a short beep + flashing tab title when a new job arrives — no external asset. */

let audioCtx: AudioContext | null = null;

export function playChime(): void {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const now = ctx.currentTime;
    for (const [freq, start] of [[880, 0], [1175, 0.12]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.2, now + start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + start);
      osc.stop(now + start + 0.3);
    }
  } catch {
    // AudioContext unsupported/blocked — silent fallback, title flash still runs
  }
}

const originalTitle = typeof document !== 'undefined' ? document.title : '';
let flashInterval: ReturnType<typeof setInterval> | null = null;

function stopFlashing(): void {
  if (flashInterval) clearInterval(flashInterval);
  flashInterval = null;
  document.title = originalTitle;
}

/** Flashes the tab title until the tab regains focus or the timeout elapses. */
export function flashTitle(message: string, maxMs = 15_000): void {
  if (typeof document === 'undefined') return;
  if (flashInterval) clearInterval(flashInterval);

  let on = false;
  flashInterval = setInterval(() => {
    document.title = on ? originalTitle : message;
    on = !on;
  }, 1000);

  const onFocus = () => {
    stopFlashing();
    window.removeEventListener('focus', onFocus);
  };
  window.addEventListener('focus', onFocus);
  setTimeout(() => {
    stopFlashing();
    window.removeEventListener('focus', onFocus);
  }, maxMs);
}

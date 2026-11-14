// Fixed musical clock (shared contract): tonal centre D, 72 BPM, 4/4, 8 bars per scene.
// Pure: callers pass in absolute times; nothing here reads a clock.

export const BPM = 72;
export const BEATS_PER_BAR = 4;
export const BARS_PER_SCENE = 8;
export const BEAT_MS = 60000 / BPM; // 833.33 ms
export const BAR_MS = BEATS_PER_BAR * BEAT_MS; // 3333.33 ms
export const BAR_SEC = BAR_MS / 1000;

/** Absolute ms at which (bar, beat) sounds, given t0 = absolute ms of bar 0. beat is 0-based in [0, 4). */
export function noteAtMs(t0, bar, beat) {
  return t0 + (bar * BEATS_PER_BAR + beat) * BEAT_MS;
}

/** Index of the bar that contains absolute time `nowMs` (negative before t0). */
export function barAt(t0, nowMs) {
  return Math.floor((nowMs - t0) / BAR_MS);
}

/** Duration in seconds of `beats` beats (audio: durSec = dur * 60 / 72). */
export function beatsToSec(beats) {
  return (beats * 60) / BPM;
}

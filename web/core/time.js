// Fixed musical clock (shared contract): tonal centre D, 72 BPM, 4/4, 8 bars per scene.
// Pure: callers pass in absolute times; nothing here reads a clock.

export const BPM = 72;
export const BEATS_PER_BAR = 4;
export const BARS_PER_SCENE = 8;
export const BEAT_MS = 60000 / BPM; // 833.33 ms
export const BAR_MS = BEATS_PER_BAR * BEAT_MS; // 3333.33 ms
export const BAR_SEC = BAR_MS / 1000;

// Hub start: bar 0 begins START_LEAD_MS after Start (t0 = now + START_LEAD_MS).
// Agents plan bar 0 one bar early, at t0 - BAR_MS. That moment must come AFTER the world
// has sent scene 0's views (it sends them at once, being already inside its lookahead),
// otherwise bar 0 is planned with the default mood. Lead > 1 bar guarantees that; 1.5 bars
// gives ~1.7 s of margin. (The plan's original 2000 ms is under one bar and raced.)
export const START_LEAD_MS = 1.5 * BAR_MS; // 5000 ms

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

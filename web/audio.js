// audio.js — Tone.js instruments. [Role 3 OWNS THIS FILE]
//
// Placeholder. Tone.js must be VENDORED at web/vendor/tone.js (no CDN).
// Input: {type:'note', from, at, bar, beat, pitch, vel, dur, role, rogue} from ea-telemetry.
//   offset = ctx.currentTime - (performance.timeOrigin + performance.now()) / 1000   (once at start,
//   then re-estimated and smoothed every 30 s);  time = at / 1000 + offset;  durSec = dur * 60 / 72.
// Drop and count notes whose time has already passed.

export function createAudio() {
  return {
    async start() {
      /* await Tone.start(); await reverb.ready; compute offset */
    },
    onNote(/* note */) {},
  };
}

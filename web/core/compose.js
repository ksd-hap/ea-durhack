// compose.js — pure music logic. [Role 3 OWNS THIS FILE]
//
// >>> THIS IS A PLACEHOLDER written by Role 2 so agents + simulator run before Role 3 lands. <<<
// Role 3: replace the body, KEEP THE SIGNATURE (agent.js and sim/ call it exactly like this):
//
//   compose({
//     id,            // 'eyeA' | 'poetA' | 'eyeB' | 'poetB'
//     role,          // 'architect' | 'melodist' | 'weaver' | 'pulse'
//     bar,           // the bar being planned (integer, bar 0 = t0)
//     ctx,           // { mode: 'ionian'|'dorian'|'aeolian', density: 1|2|3 } — this agent's OWN context
//     rng,           // seeded () => [0,1) owned by this agent; use ONLY this for randomness
//     memory,        // {} persistent per-agent scratch object (motifs, previous voicing...). Mutate freely.
//     predictions,   // [{ peer, role, slot, beat, pc, pitch }] peer-model guesses for THIS bar (pc = absolute 0..11)
//     lastBarNotes,  // NoteEvents received from peers for bar-1 (collision avoidance)
//     absorb,        // null | { pcs: [absolute pitch classes, e.g. 3 = Eb, 8 = G#] } rogue flagged, comms up
//     defend,        // boolean: rogue flagged and nothing heard for 2 bars
//     rogue,         // boolean: THIS agent is Melkor
//   }) -> [{ beat, pitch, vel, dur }]   beat 0-based in [0,4), pitch MIDI, vel 0..1, dur in beats > 0
//
// Must be pure and deterministic given rng: no Math.random, no timers, no I/O.

import { SCALES, relPc } from './theory.js';

const RANGE = {
  architect: [50, 62],
  melodist: [62, 74],
  weaver: [57, 69],
  pulse: [74, 86],
};

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

export function compose({ role, ctx, rng, rogue, defend }) {
  const notes = [];
  if (rogue) {
    // Melkor placeholder: exactly half the beats, pitch classes Eb (75) and G# (68).
    const beats = [0, 1, 2, 3];
    for (let i = beats.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [beats[i], beats[j]] = [beats[j], beats[i]];
    }
    for (const beat of beats.slice(0, 2).sort((a, b) => a - b)) {
      notes.push({ beat, pitch: rng() < 0.5 ? 75 : 68, vel: 0.9, dur: 0.5 });
    }
    return notes;
  }
  const [lo, hi] = RANGE[role] ?? [60, 72];
  const allowed = defend ? [0, 7] : SCALES[ctx.mode];
  const pool = [];
  for (let p = lo; p <= hi; p++) if (allowed.includes(relPc(p))) pool.push(p);
  // Fake: one note per beat.
  for (let beat = 0; beat < 4; beat++) {
    notes.push({ beat, pitch: pick(rng, pool), vel: 0.6, dur: 1 });
  }
  return notes;
}

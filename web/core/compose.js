// compose.js — pure music logic. [Role 3 OWNS THIS FILE]
//
// >>> PLACEHOLDER written by Role 2 so agents + simulator run before Role 3 lands. <<<
// Role 3: replace the body, KEEP THE SIGNATURE. Agreed contract (CONTRACTS.md, and a worked
// example in web/core/compose.example.json checked by tests/compose.contract.test.mjs):
//
//   compose({
//     id,            // 'eyeA' | 'poetA' | 'eyeB' | 'poetB'
//     role,          // 'architect' | 'melodist' | 'weaver' | 'pulse'
//     bar,           // the bar being planned (integer, bar 0 = t0). Chord slot = floor((bar % 8) / 2)
//     ctx,           // { mode: 'ionian'|'dorian'|'aeolian', density: 1|2|3 } — this agent's OWN context
//     state,         // the `state` this function returned last bar ({} on the first call). Treat as
//                    // read-only and return a new object (motif, previous voicing, previous notes...).
//     rng,           // seeded () => [0,1) owned by this agent. The ONLY source of randomness.
//     predictions,   // [{ peer, role, bar, slot, beat, pc, pitch, count }] peer-model guesses for THIS bar
//                    //   slot = eighth-note slot 0..7, beat = slot / 2, pc = absolute pitch class (C = 0)
//     lastBarNotes,  // NoteEvents received from peers for bar - 1 (collision avoidance)
//     absorb,        // null | { pcs: [absolute pitch classes] } e.g. 3 = Eb, 8 = G#: rogue flagged, comms up
//                    //   Honest notes may use Eb/G# (outside all three modes) ONLY here, and only
//                    //   the pcs listed: Eb major answers Eb, E7 answers G#. Anything else outside
//                    //   the modes is indistinguishable from Melkor and gets this agent flagged.
//     defend,        // boolean: rogue flagged and nothing heard for 2 bars
//     rogue,         // boolean: THIS agent is Melkor
//   }) -> {
//     notes: [{ beat, pitch, dur, vel }],   // beat 0-based in [0,4) (musical beats 1 and 3 = 0 and 2),
//                                           // pitch MIDI (D4 = 62), dur in beats > 0, vel in (0,1]
//     state,                                // the new state, handed back next bar
//   }
//
// The agent wrapper adds from, bar, at (absolute ms), role and rogue to each note.
// Must be pure and deterministic given rng: no Math.random, no timers, no audio, no I/O.

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

export function compose({ role, bar, ctx, state = {}, rng, rogue, defend }) {
  const notes = [];
  if (rogue) {
    // Melkor placeholder: exactly half the beats, pitch classes Eb (75) and G# (68).
    const beats = [0, 1, 2, 3];
    for (let i = beats.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [beats[i], beats[j]] = [beats[j], beats[i]];
    }
    for (const beat of beats.slice(0, 2).sort((a, b) => a - b)) {
      notes.push({ beat, pitch: rng() < 0.5 ? 75 : 68, dur: 0.5, vel: 0.9 });
    }
  } else {
    const [lo, hi] = RANGE[role] ?? [60, 72];
    const allowed = defend ? [0, 7] : SCALES[ctx.mode];
    const pool = [];
    for (let p = lo; p <= hi; p++) if (allowed.includes(relPc(p))) pool.push(p);
    for (let beat = 0; beat < 4; beat++) notes.push({ beat, pitch: pick(rng, pool), dur: 1, vel: 0.6 });
  }
  return { notes, state: { ...state, lastBar: bar, prevNotes: notes.map((n) => n.pitch) } };
}

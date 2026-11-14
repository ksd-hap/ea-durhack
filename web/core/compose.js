// compose.js — pure music logic. [Role 3]
//
// Implemented: all four normal musical roles.
// Melodist and Weaver defence included.
// Remaining: absorption and Architect defence.
//
// Contract:
// compose({ id, role, bar, ctx, state, rng, predictions,
//           lastBarNotes, absorb, defend, rogue })
// returns { notes: [{ beat, pitch, dur, vel }], state }.
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
// Beats start at 0. Durations are in beats. Pitches are MIDI.
// The wrapper adds from, bar, at, role and rogue.
// Never mutate incoming state.
// Use only the supplied seeded rng.
// No audio, timers, networking or browser dependencies.

import { SCALES, relPc } from './theory.js';

// Absolute pitch classes: C = 0, D = 2.
const PROGRESSIONS = {
  ionian: [
    [2, 6, 9],   // D major
    [11, 2, 6],  // B minor
    [7, 11, 2],  // G major
    [9, 1, 4],   // A major
  ],
  dorian: [
    [2, 5, 9],   // D minor
    [7, 11, 2],  // G major
    [0, 4, 7],   // C major
    [2, 5, 9],   // D minor
  ],
  aeolian: [
    [2, 5, 9],   // D minor
    [10, 2, 5],  // B-flat major
    [5, 9, 0],   // F major
    [0, 4, 7],   // C major
  ],
};

const MELODY_BEATS = {
  1: [0, 2],
  2: [0, 1, 2, 3],
  3: [0, 0.5, 1, 2, 2.5, 3],
};

// Four-note motifs expressed in scale steps.
const MOTIFS = [
  [0, 1, 2, 1],
  [0, -1, -2, -1],
  [0, 1, 0, -1],
  [0, -1, 0, 1],
];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function nearestPitch(pool, target) {
  return pool.reduce(
    (best, pitch) =>
      Math.abs(pitch - target) < Math.abs(best - target)
        ? pitch
        : best,
    pool[0],
  );
}

function chordForBar(mode, bar) {
  const chordIndex = Math.floor((bar % 8) / 2);
  return PROGRESSIONS[mode][chordIndex];
}

function choosePadVoicing(chord, previous = [50, 54, 57]) {
  const pool = [];

  for (let pitch = 50; pitch <= 62; pitch++) {
    if (chord.includes(pitch % 12)) pool.push(pitch);
  }

  let best = pool.slice(0, 3);
  let bestScore = Infinity;

  for (let i = 0; i <= pool.length - 3; i++) {
    const candidate = pool.slice(i, i + 3);

    const score = candidate.reduce(
      (sum, pitch, index) =>
        sum + Math.abs(pitch - previous[index]),
      0,
    );

    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function composeMelodist({ bar, ctx, state, rng, defend }) {
  const previousPitch =
    state.lastPitch ?? state.prevNotes?.at(-1) ?? 67;

  if (defend) {
    const first = nearestPitch([62, 69, 74], previousPitch);
    const second = first === 69 ? 74 : 69;

    const notes = [
      { beat: 0, pitch: first, dur: 1.8, vel: 0.7 },
      { beat: 2, pitch: second, dur: 1.8, vel: 0.65 },
    ];

    return {
      notes,
      state: {
        ...state,
        lastBar: bar,
        lastPitch: second,
        prevNotes: notes.map((note) => note.pitch),
      },
    };
  }

  const pool = [];

  for (let pitch = 62; pitch <= 74; pitch++) {
    if (SCALES[ctx.mode].includes(relPc(pitch))) {
      pool.push(pitch);
    }
  }

  const chord = chordForBar(ctx.mode, bar);
  const chordPool = pool.filter(
    (pitch) => chord.includes(pitch % 12),
  );

  const sceneBar = bar % 8;
  const sceneStart = bar - sceneBar;

  const motif =
    state.motifBar === sceneStart && state.motif?.length === 4
      ? [...state.motif]
      : [...pick(rng, MOTIFS)];

  // Appear in scene bar 1, return in bars 3 and 5.
  const repeatMotif =
    sceneBar === 0 || sceneBar === 2 || sceneBar === 4;

  const anchors = chordPool.filter((pitch) => {
    const index = pool.indexOf(pitch);

    const fits = motif.every(
      (offset) =>
        index + offset >= 0 &&
        index + offset < pool.length,
    );

    return (
      fits &&
      chordPool.includes(pool[index + motif[2]])
    );
  });

  const anchor = nearestPitch(
    anchors.length ? anchors : chordPool,
    previousPitch,
  );

  const anchorIndex = pool.indexOf(anchor);
  const beats = MELODY_BEATS[ctx.density];
  const notes = [];
  let lastPitch = previousPitch;

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const strong = beat === 0 || beat === 2;
    let target;

    if (repeatMotif) {
      const position = Math.floor(beat);
      let offset = motif[position];

      if (!Number.isInteger(beat)) {
        offset = Math.round(
          (offset + motif[position + 1]) / 2,
        );
      }

      const index = Math.max(
        0,
        Math.min(pool.length - 1, anchorIndex + offset),
      );

      target = pool[index];
    } else {
      const currentIndex = pool.indexOf(
        nearestPitch(pool, lastPitch),
      );

      const step =
        beat === 0 ? 0 : pick(rng, [-1, 0, 1]);

      const index = Math.max(
        0,
        Math.min(pool.length - 1, currentIndex + step),
      );

      target = pool[index];
    }

    const pitch = strong
      ? nearestPitch(chordPool, target)
      : target;

    const nextBeat = beats[i + 1] ?? 4;

    notes.push({
      beat,
      pitch,
      dur: (nextBeat - beat) * 0.9,
      vel: strong
        ? beat === 0 ? 0.7 : 0.65
        : 0.5 + rng() * 0.08,
    });

    lastPitch = pitch;
  }

  return {
    notes,
    state: {
      ...state,
      lastBar: bar,
      lastPitch,
      motif,
      motifBar: sceneStart,
      prevNotes: notes.map((note) => note.pitch),
    },
  };
}

function composeWeaver({
  bar,
  ctx,
  state,
  predictions = [],
  lastBarNotes = [],
  defend,
}) {
  const chord = chordForBar(ctx.mode, bar);
  const allowed = defend ? [2, 9] : chord;
  const pool = [];

  for (let pitch = 57; pitch <= 69; pitch++) {
    if (allowed.includes(pitch % 12)) {
      pool.push(pitch);
    }
  }

  const density = defend ? 1 : ctx.density;
  const beats = {
    1: [0],
    2: [0, 2],
    3: [0, 1.5, 3],
  }[density];

  const preferredPcs = [
    chord[1],
    chord[3],
  ].filter(Number.isInteger);

  const notes = [];
  let lastPitch =
    state.lastPitch ?? state.prevNotes?.at(-1) ?? 62;

  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i];
    const slot = Math.floor(beat * 2);

    const predicted = predictions.filter(
      (note) =>
        note.role === 'melodist' &&
        note.bar === bar &&
        note.slot === slot,
    );

    const recent = lastBarNotes.filter(
      (note) =>
        note.role === 'melodist' &&
        note.bar === bar - 1 &&
        Math.floor(note.beat * 2) === slot,
    );

    const blocked = new Set(
      predicted.length
        ? predicted.map((note) => note.pc)
        : recent.map((note) => note.pitch % 12),
    );

    const clear = pool.filter(
      (pitch) => !blocked.has(pitch % 12),
    );

    const available = clear.length ? clear : pool;

    const preferred = defend
      ? []
      : available.filter(
          (pitch) => preferredPcs.includes(pitch % 12),
        );

    const pitch = nearestPitch(
      preferred.length ? preferred : available,
      lastPitch,
    );

    const nextBeat = beats[i + 1] ?? 4;

    notes.push({
      beat,
      pitch,
      dur: (nextBeat - beat) * 0.95,
      vel: 0.42,
    });

    lastPitch = pitch;
  }

  return {
    notes,
    state: {
      ...state,
      lastBar: bar,
      lastPitch,
      prevNotes: notes.map((note) => note.pitch),
    },
  };
}

export function compose({
  role,
  bar,
  ctx,
  state = {},
  rng,
  rogue,
  defend,
  predictions = [],
  lastBarNotes = [],
}) {
  const notes = [];

  if (rogue) {
    const beats = [0, 1, 2, 3];

    for (let i = beats.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [beats[i], beats[j]] = [beats[j], beats[i]];
    }

    const chosenBeats = beats
      .slice(0, 2)
      .sort((a, b) => a - b);

    for (const beat of chosenBeats) {
      notes.push({
        beat,
        pitch: rng() < 0.5 ? 75 : 68,
        dur: 0.5,
        vel: 0.9,
      });
    }
  } else if (role === 'architect') {
    let padVoicing = state.padVoicing;

    if (bar % 2 === 0) {
      const chord = chordForBar(ctx.mode, bar);
      padVoicing = choosePadVoicing(chord, state.padVoicing);
      const padPitches = [...padVoicing];

      if (ctx.density === 3) {
        const ninthPc = (chord[0] + 2) % 12;

        for (let pitch = 50; pitch <= 62; pitch++) {
          if (pitch % 12 === ninthPc) {
            padPitches.push(pitch);
            break;
          }
        }
      }

      notes.push({
        beat: 0,
        pitch: 38,
        dur: 8,
        vel: 0.35,
      });

      for (const pitch of padPitches) {
        notes.push({
          beat: 0,
          pitch,
          dur: 8,
          vel: 0.45,
        });
      }
    }

    return {
      notes,
      state: { ...state, lastBar: bar, padVoicing },
    };
  } else if (role === 'melodist') {
    return composeMelodist({
      bar, ctx, state, rng, defend,
    });
  } else if (role === 'weaver') {
    return composeWeaver({
      bar, ctx, state, predictions, lastBarNotes, defend,
    });
  } else {
    // Pulse: five-note subset of the current mode.
    const pentatonic = ctx.mode === 'ionian'
      ? [2, 4, 6, 9, 11] // D E F# A B
      : [2, 5, 7, 9, 0]; // D F G A C

    const pool = [];

    for (let pitch = 74; pitch <= 86; pitch++) {
      if (pentatonic.includes(pitch % 12)) {
        pool.push(pitch);
      }
    }

    const step = {
      1: 1,
      2: 0.5,
      3: 0.25,
    }[ctx.density];

    const chance = ctx.density === 1 ? 0.3 : 0.6;

    for (let beat = 0; beat < 4; beat += step) {
      if (rng() >= chance) continue;

      notes.push({
        beat,
        pitch: pick(rng, pool),
        dur: Math.min(0.3, step * 0.7),
        vel:
          (ctx.density === 3 ? 0.28 : 0.34) +
          rng() * 0.06,
      });
    }
  }

  return {
    notes,
    state: {
      ...state,
      lastBar: bar,
      prevNotes: notes.map((note) => note.pitch),
    },
  };
}

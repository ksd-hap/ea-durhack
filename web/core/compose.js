// compose.js — pure music logic. [Role 3]
//
// Normal Architect and Melodist composition implemented.
// Melodist defence included.
// Still to implement: Weaver, ordinary Pulse, absorption,
// and Architect defence.
//
// Contract:
// compose({ id, role, bar, ctx, state, rng, predictions,
//           lastBarNotes, absorb, defend, rogue })
// returns { notes: [{ beat, pitch, dur, vel }], state }.
//
// Beats start at 0. Durations are in beats. Pitches are MIDI.
// The wrapper adds from, bar, at, role and rogue.
// State is read-only: always return a new object.
// Use only the supplied seeded rng for randomness.
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

const RANGE = {
  architect: [50, 62],
  melodist: [62, 74],
  weaver: [57, 69],
  pulse: [74, 86],
};

// Musical beats 1 and 3 are represented by 0 and 2.
const MELODY_BEATS = {
  1: [0, 2],
  2: [0, 1, 2, 3],
  3: [0, 0.5, 1, 2, 2.5, 3],
};

// Four-note motifs stored as offsets in scale steps.
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

  // Defence: two strong, simple D/A notes per bar.
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

  // Keep one motif for the whole scene.
  const motif =
    state.motifBar === sceneStart && state.motif?.length === 4
      ? [...state.motif]
      : [...pick(rng, MOTIFS)];

  // First appearance, then returns in scene bars 3 and 5.
  const repeatMotif =
    sceneBar === 0 || sceneBar === 2 || sceneBar === 4;

  // Choose a starting note that preserves the motif's shape,
  // stays in range, and puts its strong beats on chord tones.
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
      // At density 1, use the motif's two strong-beat notes.
      // At density 2, use all four notes.
      // At density 3, add notes between the main motif notes.
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
      // Between motif returns, vary the line gently.
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

export function compose({
  role,
  bar,
  ctx,
  state = {},
  rng,
  rogue,
  defend,
}) {
  const notes = [];

  if (rogue) {
    // Melkor plays on two randomly selected beats.
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

      padVoicing = choosePadVoicing(
        chord,
        state.padVoicing,
      );

      const padPitches = [...padVoicing];

      // Add the chord's ninth at density 3.
      if (ctx.density === 3) {
        const ninthPc = (chord[0] + 2) % 12;

        for (let pitch = 50; pitch <= 62; pitch++) {
          if (pitch % 12 === ninthPc) {
            padPitches.push(pitch);
            break;
          }
        }
      }

      // Low D drone, held for two bars.
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
      state: {
        ...state,
        lastBar: bar,
        padVoicing,
      },
    };
  } else if (role === 'melodist') {
    return composeMelodist({
      bar,
      ctx,
      state,
      rng,
      defend,
    });
  } else {
    // Existing placeholder for Weaver and ordinary Pulse.
    const [lo, hi] = RANGE[role] ?? [60, 72];
    const allowed = defend ? [0, 7] : SCALES[ctx.mode];
    const pool = [];

    for (let pitch = lo; pitch <= hi; pitch++) {
      if (allowed.includes(relPc(pitch))) {
        pool.push(pitch);
      }
    }

    for (let beat = 0; beat < 4; beat++) {
      notes.push({
        beat,
        pitch: pick(rng, pool),
        dur: 1,
        vel: 0.6,
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
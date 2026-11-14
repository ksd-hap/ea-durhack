// compose.js — pure music logic. [Role 3]
// All four voices, absorption and defence.
//
// Contract:
// compose({ id, role, bar, ctx, state, rng, predictions,
//           lastBarNotes, absorb, defend, rogue })
// returns { notes: [{ beat, pitch, dur, vel }], state }.
//
// Beats are zero-based. Durations are beats. Pitches are MIDI.
// The wrapper adds from, bar, at, role and rogue.
// Never mutate input state. Use only the supplied rng.
// No audio, timers, networking or browser dependencies.
// Honest Eb/G# notes require permission in CURRENT absorb.pcs.

import {
  SCALES,
  relPc,
  absPc,
  isOutsideUnion,
} from './theory.js';

import { planResponse } from './response.js';

const PROGRESSIONS = {
  ionian: [
    [2, 6, 9],   // D
    [11, 2, 6],  // Bm
    [7, 11, 2],  // G
    [9, 1, 4],   // A
  ],
  dorian: [
    [2, 5, 9],   // Dm
    [7, 11, 2],  // G
    [0, 4, 7],   // C
    [2, 5, 9],   // Dm
  ],
  aeolian: [
    [2, 5, 9],   // Dm
    [10, 2, 5],  // Bb
    [5, 9, 0],   // F
    [0, 4, 7],   // C
  ],
};

const MELODY_BEATS = {
  1: [0, 2],
  2: [0, 1, 2, 3],
  3: [0, 0.5, 1, 2, 2.5, 3],
};

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
    if (chord.includes(absPc(pitch))) {
      pool.push(pitch);
    }
  }

  // Also supports four-note E7 and filtered response chords.
  const count = chord.length;
  let best = pool.slice(0, count);
  let bestScore = Infinity;

  for (let i = 0; i <= pool.length - count; i++) {
    const candidate = pool.slice(i, i + count);

    const score = candidate.reduce(
      (sum, pitch, index) =>
        sum + Math.abs(
          pitch -
          (previous[index] ?? previous.at(-1) ?? 57),
        ),
      0,
    );

    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function composeMelodist({
  bar, ctx, state, rng, defend, harmony,
}) {
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
    const allowed = harmony.chord
      ? harmony.chord.includes(absPc(pitch))
      : SCALES[ctx.mode].includes(relPc(pitch));

    if (allowed) pool.push(pitch);
  }

  const chord =
    harmony.chord ?? chordForBar(ctx.mode, bar);

  const chordPool = pool.filter(
    (pitch) => chord.includes(absPc(pitch)),
  );

  const sceneBar = bar % 8;
  const sceneStart = bar - sceneBar;

  const motif =
    state.motifBar === sceneStart && state.motif?.length === 4
      ? [...state.motif]
      : [...pick(rng, MOTIFS)];

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
  harmony,
}) {
  const chord =
    harmony.chord ?? chordForBar(ctx.mode, bar);

  const allowed = defend ? [2, 9] : chord;
  const pool = [];

  for (let pitch = 57; pitch <= 69; pitch++) {
    if (allowed.includes(absPc(pitch))) {
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
        : recent.map((note) => absPc(note.pitch)),
    );

    const clear = pool.filter(
      (pitch) => !blocked.has(absPc(pitch)),
    );

    const available = clear.length ? clear : pool;

    const preferred = defend
      ? []
      : available.filter(
          (pitch) => preferredPcs.includes(absPc(pitch)),
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

function composeArchitect({
  bar, ctx, state, defend, harmony,
}) {
  const notes = [];
  let padVoicing = state.padVoicing;

  if (bar % 2 === 0) {
    const chord =
      harmony.chord ?? chordForBar(ctx.mode, bar);

    padVoicing = choosePadVoicing(
      chord,
      state.padVoicing,
    );

    const padPitches = [...padVoicing];

    // Answering chords use their stated chord tones.
    if (ctx.density === 3 && !harmony.chord) {
      const ninthPc = (chord[0] + 2) % 12;

      for (let pitch = 50; pitch <= 62; pitch++) {
        if (absPc(pitch) === ninthPc) {
          padPitches.push(pitch);
          break;
        }
      }
    }

    notes.push({
      beat: 0, pitch: 38, dur: 8, vel: 0.35,
    });

    if (defend) {
      notes.push({
        beat: 0, pitch: 45, dur: 8, vel: 0.45,
      });
      notes.push({
        beat: 0, pitch: 50, dur: 8, vel: 0.45,
      });
    }

    for (const pitch of padPitches) {
      notes.push({
        beat: 0,
        pitch,
        dur: 8,
        vel: Math.min(
          1,
          0.45 + (defend ? 0.15 : 0),
        ),
      });
    }
  } else if (defend && !state.defending) {
    // Add the defensive drone immediately on an odd bar.
    // Boost pad velocity on the next normal chord attack.
    if (!state.padVoicing) {
      notes.push({
        beat: 0, pitch: 38, dur: 4, vel: 0.35,
      });
    }

    notes.push({
      beat: 0, pitch: 45, dur: 4, vel: 0.45,
    });
    notes.push({
      beat: 0, pitch: 50, dur: 4, vel: 0.45,
    });
  }

  return {
    notes,
    state: {
      ...state,
      lastBar: bar,
      padVoicing,
      defending: Boolean(defend),
    },
  };
}

function composePulse({
  bar, ctx, state, rng, harmony,
}) {
  const pentatonic =
    harmony.chord ??
    (ctx.mode === 'ionian'
      ? [2, 4, 6, 9, 11]
      : [2, 5, 7, 9, 0]);

  const pool = [];

  for (let pitch = 74; pitch <= 86; pitch++) {
    if (pentatonic.includes(absPc(pitch))) {
      pool.push(pitch);
    }
  }

  const step = {
    1: 1,
    2: 0.5,
    3: 0.25,
  }[ctx.density];

  const chance = ctx.density === 1 ? 0.3 : 0.6;
  const notes = [];

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

  return {
    notes,
    state: { ...state, lastBar: bar },
  };
}

function composeRogue({ bar, state, rng }) {
  const beats = [0, 1, 2, 3];

  for (let i = beats.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [beats[i], beats[j]] = [beats[j], beats[i]];
  }

  const notes = beats
    .slice(0, 2)
    .sort((a, b) => a - b)
    .map((beat) => ({
      beat,
      pitch: rng() < 0.5 ? 75 : 68,
      dur: 0.5,
      vel: 0.9,
    }));

  return {
    notes,
    state: {
      ...state,
      lastBar: bar,
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
  rogue = false,
  defend = false,
  absorb = null,
  predictions = [],
  lastBarNotes = [],
}) {
  if (rogue) {
    return composeRogue({ bar, state, rng });
  }

  const harmony = planResponse({
    bar,
    absorb,
    defend,
    state: state.harmony ?? {},
  });

  const nextState = {
    ...state,
    harmony: harmony.state,
    response: harmony.response,
  };

  const args = {
    bar,
    ctx,
    state: nextState,
    rng,
    defend,
    harmony,
    predictions,
    lastBarNotes,
  };

  let result;

  switch (role) {
    case 'architect':
      result = composeArchitect(args);
      break;
    case 'melodist':
      result = composeMelodist(args);
      break;
    case 'weaver':
      result = composeWeaver(args);
      break;
    case 'pulse':
      result = composePulse(args);
      break;
    default:
      throw new Error(`Unknown musical role: ${role}`);
  }

  // Remembering an old response does not authorise
  // a new Eb/G# note without current permission.
  const allowedOutside = new Set(absorb?.pcs ?? []);

  const notes = result.notes.filter(
    (note) =>
      !isOutsideUnion(note.pitch) ||
      allowedOutside.has(absPc(note.pitch)),
  );

  return {
    notes,
    state: {
      ...result.state,
      prevNotes: notes.map((note) => note.pitch),
    },
  };
}

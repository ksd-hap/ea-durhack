// Role-specific corruption and minimal cover parts. [Role 3]
// Pure functions. Absolute pitch classes: C = 0.

import { absPc } from './theory.js';

const RANGES = {
  architect: [50, 62],
  melodist: [62, 74],
  weaver: [57, 69],
  pulse: [74, 86],
};

function nearest(pool, target) {
  return pool.reduce(
    (best, pitch) =>
      Math.abs(pitch - target) < Math.abs(best - target)
        ? pitch
        : best,
    pool[0],
  );
}

export function corruptPart({
  role,
  ctx,
  bar,
  state = {},
  notes = [],
}) {
  if (!RANGES[role]) {
    throw new Error(`Unknown musical role: ${role}`);
  }

  let source = notes.map((note) => ({ ...note }));

  if (role === 'architect' && source.length < 2) {
    source = [
      { beat: 0, pitch: 38, dur: 4, vel: 0.7 },
      { beat: 0, pitch: 50, dur: 4, vel: 0.65 },
      { beat: 2, pitch: 57, dur: 1.8, vel: 0.5 },
    ];
  } else {
    // Sparse parts must still expose at least two notes.
    for (const beat of [0, 2]) {
      if (source.length >= 2) break;

      if (source.some((note) => note.beat === beat)) {
        continue;
      }

      source.push({
        beat,
        pitch: role === 'pulse' ? 74 : 69,
        dur: role === 'pulse'
          ? Math.min(
              0.3,
              0.7 / (2 ** (ctx.density - 1)),
            )
          : 1.8,
        vel: 0.65,
      });
    }
  }

  source.sort((a, b) => a.beat - b.beat);

  const [lo, hi] = RANGES[role];
  const outside = [];

  for (let pitch = lo; pitch <= hi; pitch++) {
    if ([3, 8].includes(absPc(pitch))) {
      outside.push(pitch);
    }
  }

  // Poison at least half, including the final note.
  const poisoned = new Set([0, source.length - 1]);

  for (
    let i = 2;
    poisoned.size < Math.ceil(source.length / 2);
    i += 2
  ) {
    poisoned.add(i);
  }

  if (role === 'architect') {
    poisoned.add(1);
  }

  const result = source.map((note, i) => {
    if (!poisoned.has(i)) return note;

    const pitch =
      role === 'architect' && note.pitch < 50
        ? 44 // G#2: tritone drone
        : role === 'architect' && i === 1
          ? 51 // Eb3 in the pad
          : nearest(outside, note.pitch);

    return {
      ...note,
      pitch,
      vel: Math.min(0.9, Math.max(0.7, note.vel)),
    };
  });

  return {
    notes: result,
    state: {
      ...state,
      lastBar: bar,
      lastPitch: result.at(-1).pitch,
      response: 'rogue',
      prevNotes: result.map((note) => note.pitch),
    },
  };
}

export function coverPart(cover) {
  switch (cover) {
    case 'architect':
      return [
        { beat: 0, pitch: 38, dur: 4, vel: 0.3 },
        { beat: 0, pitch: 45, dur: 4, vel: 0.28 },
      ];

    case 'melodist':
      return [
        { beat: 0, pitch: 62, dur: 1.7, vel: 0.38 },
        { beat: 2, pitch: 69, dur: 1.7, vel: 0.36 },
      ];

    case 'weaver':
      return [
        { beat: 0, pitch: 62, dur: 3.8, vel: 0.3 },
      ];

    case 'pulse':
      return [
        { beat: 0, pitch: 74, dur: 0.2, vel: 0.3 },
        { beat: 2, pitch: 81, dur: 0.2, vel: 0.28 },
      ];

    default:
      return [];
  }
}
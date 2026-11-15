// Role-specific corruption and minimal cover parts. [Role 3]
// Pure functions. Absolute pitch classes: C = 0.

import { absPc } from './theory.js';

const isRoguePitch = (pitch) =>
  [3, 8].includes(absPc(pitch));

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
    if (isRoguePitch(pitch)) {
      outside.push(pitch);
    }
  }

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
        ? 44
        : role === 'architect' && i === 1
          ? 51
          : nearest(outside, note.pitch);

    return {
      ...note,
      pitch,
      vel: Math.min(0.9, Math.max(0.7, note.vel)),
    };
  });

  // Use short off-beat stabs, always inside the current bar.
  let stabs = result.map((note, i) => ({
    ...note,
    beat:
      Math.floor(note.beat) +
      ((bar + i) % 2 ? 0.75 : 0.5),
    dur: 0.25,
    vel: isRoguePitch(note.pitch)
      ? Math.max(0.8, note.vel)
      : note.vel,
  }));

  // Alternate bars include simultaneous Eb and G#.
  if (bar % 2 === 0) {
    const first = stabs.find(
      (note) => isRoguePitch(note.pitch),
    );

    const otherPc = absPc(first.pitch) === 3 ? 8 : 3;

    const otherPool = outside.filter(
      (pitch) => absPc(pitch) === otherPc,
    );

    stabs.push({
      beat: first.beat,
      pitch: nearest(otherPool, first.pitch),
      dur: 0.25,
      vel: 0.85,
    });
  }

  // Remove accidental duplicate attacks.
  const unique = new Map();

  for (const note of stabs) {
    const key = `${note.beat}:${note.pitch}`;
    const previous = unique.get(key);

    if (!previous || note.vel > previous.vel) {
      unique.set(key, note);
    }
  }

  stabs = [...unique.values()];

  // Preserve at least two rogue notes for fast detection.
  let bad = stabs.filter(
    (note) => isRoguePitch(note.pitch),
  ).length;

  if (bad < 2) {
    const first = stabs.find(
      (note) => isRoguePitch(note.pitch),
    );

    const beat = (first.beat + 2) % 4;

    for (const pitch of outside) {
      if (bad >= 2) break;

      if (
        stabs.some(
          (note) =>
            note.beat === beat &&
            note.pitch === pitch,
        )
      ) {
        continue;
      }

      stabs.push({
        beat,
        pitch,
        dur: 0.25,
        vel: 0.85,
      });

      bad++;
    }
  }

  // Deduplication must not reduce the rogue-note fraction.
  for (
    let i = stabs.length - 1;
    bad * 2 < stabs.length;
    i--
  ) {
    if (!isRoguePitch(stabs[i].pitch)) {
      stabs.splice(i, 1);
    }
  }

  stabs.sort(
    (a, b) => a.beat - b.beat || a.pitch - b.pitch,
  );

  return {
    notes: stabs,
    state: {
      ...state,
      lastBar: bar,
      lastPitch: stabs.at(-1).pitch,
      response: 'rogue',
      prevNotes: stabs.map((note) => note.pitch),
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

// Shared music-theory constants. Pure. Role 3 may extend this file; Role 2's rogue
// detection depends on SCALES and OUTSIDE_REL_PCS, so don't change those without telling Role 2.

export const D4 = 62; // MIDI
export const TONIC_PC = 2; // D as an absolute pitch class (C = 0)

/** Scale degrees as semitones above D. */
export const SCALES = {
  ionian: [0, 2, 4, 5, 7, 9, 11], // D E F# G A B C#
  dorian: [0, 2, 3, 5, 7, 9, 10], // D E F G A B C
  aeolian: [0, 2, 3, 5, 7, 8, 10], // D E F G A Bb C
};

export const MODES = ['ionian', 'dorian', 'aeolian'];

/** Pitch class relative to D (0 = D, 1 = Eb, 6 = G#). */
export function relPc(pitch) {
  return (((pitch - D4) % 12) + 12) % 12;
}

/** Absolute pitch class (C = 0). */
export function absPc(pitch) {
  return ((pitch % 12) + 12) % 12;
}

// The union of the three modes covers every pitch class relative to D except
// 1 (Eb, minor 2nd) and 6 (G#, tritone). Honest agents can never play these,
// whatever mode they believe in, so mode disagreement cannot cause suspicion.
const UNION = new Set([...SCALES.ionian, ...SCALES.dorian, ...SCALES.aeolian]);
export const OUTSIDE_REL_PCS = [...Array(12).keys()].filter((pc) => !UNION.has(pc)); // [1, 6]
const OUTSIDE_SET = new Set(OUTSIDE_REL_PCS);

export function isOutsideUnion(pitch) {
  return OUTSIDE_SET.has(relPc(pitch));
}

export function inScale(pitch, mode) {
  return SCALES[mode].includes(relPc(pitch));
}

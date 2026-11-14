// Pure harmonic response rules. [Role 3]
// Absolute pitch classes: C = 0, Eb = 3, G# = 8.

const ANSWERS = {
  3: [3, 7, 10],    // Eb major: Eb G Bb
  8: [4, 8, 11, 2], // E7: E G# B D
};

const DOMINANT = [9, 1, 4]; // A major

export function planResponse({
  bar,
  absorb,
  defend,
  state = {},
}) {
  if (defend) {
    return {
      chord: null,
      response: 'defend',
      state: {},
    };
  }

  const slot = Math.floor(bar / 2);
  const allowed = new Set(absorb?.pcs ?? []);

  const validPrevious =
    Number.isInteger(state.answerSlot) &&
    (state.pc === 3 || state.pc === 8) &&
    slot >= state.answerSlot &&
    slot <= state.answerSlot + 1;

  let next = validPrevious ? { ...state } : null;

  // Start at a two-bar chord boundary.
  // If both rogue pitches arrive, choose Eb consistently.
  // An existing answer must resolve before another begins.
  if (!next && bar % 2 === 0) {
    const pc = allowed.has(3)
      ? 3
      : allowed.has(8) ? 8 : null;

    if (pc !== null) {
      next = { answerSlot: slot, pc };
    }
  }

  if (!next) {
    return {
      chord: null,
      response: 'normal',
      state: {},
    };
  }

  if (slot === next.answerSlot + 1) {
    return {
      chord: [...DOMINANT],
      response: 'resolve',
      state: next,
    };
  }

  // Only the CURRENT absorb.pcs can authorise Eb or G#.
  const chord = ANSWERS[next.pc].filter(
    (pc) =>
      (pc !== 3 && pc !== 8) ||
      allowed.has(pc),
  );

  return {
    chord,
    response: 'absorb',
    state: next,
  };
}
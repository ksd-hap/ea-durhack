import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compose } from '../web/core/compose.js';
import { corruptPart } from '../web/core/parts.js';
import { mulberry32 } from '../web/core/rng.js';
import { absPc, isOutsideUnion } from '../web/core/theory.js';

const ROLES = ['architect', 'melodist', 'weaver', 'pulse'];

const REGISTER = {
  architect: [38, 62],
  melodist: [62, 74],
  weaver: [57, 69],
  pulse: [74, 86],
};

function play(role, bar, state, density, rng) {
  return compose({
    role,
    bar,
    state,
    ctx: { mode: 'dorian', density },
    rng,
    rogue: true,
    absorb: null,
    defend: false,
    predictions: [],
    lastBarNotes: [],
  });
}

function hasDyad(notes) {
  const beats = new Map();

  for (const note of notes) {
    const pcs = beats.get(note.beat) ?? new Set();
    pcs.add(absPc(note.pitch));
    beats.set(note.beat, pcs);
  }

  return [...beats.values()].some(
    (pcs) => pcs.has(3) && pcs.has(8),
  );
}

for (const role of ROLES) {
  test(`${role}: 1,000 rogue bars retain short off-beats and detection evidence`, () => {
    const rng = mulberry32(104);
    const contexts = mulberry32(55);
    let state = {};

    for (let bar = 0; bar < 1000; bar++) {
      const density = 1 + Math.floor(contexts() * 3);
      const out = play(role, bar, state, density, rng);

      assert(out.notes.length >= 2);

      const bad = out.notes.filter(
        (note) => isOutsideUnion(note.pitch),
      );

      assert(bad.length >= 2);
      assert(bad.length >= Math.ceil(out.notes.length / 2));

      assert.equal(
        new Set(
          out.notes.map(
            (note) => `${note.beat}:${note.pitch}`,
          ),
        ).size,
        out.notes.length,
      );

      for (const note of out.notes) {
        assert(Number.isInteger(note.pitch));
        assert(note.pitch >= REGISTER[role][0]);
        assert(note.pitch <= REGISTER[role][1]);

        assert(note.beat >= 0 && note.beat < 4);
        assert([0.5, 0.75].includes(note.beat % 1));
        assert.equal(note.dur, 0.25);
        assert(note.beat + note.dur <= 4);
      }

      assert(
        out.notes.every(
          (note, i, notes) =>
            i === 0 || notes[i - 1].beat <= note.beat,
        ),
      );

      state = out.state;
    }
  });
}

test('sparse rogue parts alternate Eb/G# dyads with separate stabs', () => {
  for (const role of ROLES) {
    const rng = mulberry32(41);
    const first = play(role, 0, {}, 1, rng);
    const second = play(role, 1, first.state, 1, rng);

    assert(hasDyad(first.notes), `${role}: missing dyad`);

    assert(
      !hasDyad(second.notes),
      `${role}: no contrast between bars`,
    );
  }
});

test('late notes remain inside the bar without changing the input', () => {
  const source = Object.freeze([
    Object.freeze({
      beat: 3.75,
      pitch: 86,
      dur: 0.1,
      vel: 0.4,
    }),
  ]);

  const state = Object.freeze({ previous: 86 });

  const out = corruptPart({
    role: 'pulse',
    ctx: { mode: 'ionian', density: 3 },
    bar: 1,
    state,
    notes: source,
  });

  assert.deepEqual(source, [
    { beat: 3.75, pitch: 86, dur: 0.1, vel: 0.4 },
  ]);

  assert.deepEqual(state, { previous: 86 });

  assert(
    out.notes.every(
      (note) => note.beat < 4 && note.beat + note.dur <= 4,
    ),
  );
});
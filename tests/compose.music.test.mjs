import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compose } from '../web/core/compose.js';
import { mulberry32, seedFor } from '../web/core/rng.js';
import {
  SCALES,
  relPc,
  absPc,
  inScale,
  isOutsideUnion,
} from '../web/core/theory.js';
import { runOne } from '../sim/engine.mjs';

const ROLES = ['architect', 'melodist', 'weaver', 'pulse'];
const MODES = ['ionian', 'dorian', 'aeolian'];

const RANGES = {
  architect: [50, 62],
  melodist: [62, 74],
  weaver: [57, 69],
  pulse: [74, 86],
};

const CHORDS = {
  ionian: [[2, 6, 9], [11, 2, 6], [7, 11, 2], [9, 1, 4]],
  dorian: [[2, 5, 9], [7, 11, 2], [0, 4, 7], [2, 5, 9]],
  aeolian: [[2, 5, 9], [10, 2, 5], [5, 9, 0], [0, 4, 7]],
};

function play(role, extra = {}) {
  return compose({
    role,
    bar: 0,
    ctx: { mode: 'dorian', density: 2 },
    state: {},
    rng: mulberry32(8),
    predictions: [],
    lastBarNotes: [],
    absorb: null,
    defend: false,
    rogue: false,
    ...extra,
  });
}

function freeze(value) {
  if (
    value &&
    typeof value === 'object' &&
    !Object.isFrozen(value)
  ) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }

  return value;
}

function checkNote(note, role, defend = false) {
  assert.deepEqual(
    Object.keys(note).sort(),
    ['beat', 'dur', 'pitch', 'vel'],
  );

  const [lo, hi] = RANGES[role];

  const drone =
    role === 'architect' &&
    (note.pitch === 38 || defend && note.pitch === 45);

  assert(
    Number.isInteger(note.pitch) &&
    (drone || note.pitch >= lo && note.pitch <= hi),
  );

  assert(
    Number.isFinite(note.beat) &&
    note.beat >= 0 &&
    note.beat < 4,
  );

  assert(Number.isFinite(note.dur) && note.dur > 0);

  assert(
    Number.isFinite(note.vel) &&
    note.vel > 0 &&
    note.vel <= 1,
  );
}

for (const role of ROLES) {
  test(`${role}: 1,000 normal contexts obey musical rules`, () => {
    const random = mulberry32(441);
    const rng = mulberry32(seedFor(role, 7));
    let state = {};

    for (let i = 0; i < 1000; i++) {
      const mode = MODES[Math.floor(random() * 3)];
      const density = 1 + Math.floor(random() * 3);
      const bar = Math.floor(random() * 128);
      const before = structuredClone(state);

      const out = play(role, {
        bar,
        ctx: { mode, density },
        state: freeze(state),
        rng,
      });

      assert.deepEqual(state, before);
      assert.notEqual(out.state, state);

      if (role === 'architect') {
        assert.equal(
          out.notes.length,
          bar % 2 ? 0 : density === 3 ? 5 : 4,
        );
      }

      if (role === 'melodist') {
        assert.equal(out.notes.length, density * 2);
      }

      if (role === 'weaver') {
        assert.equal(out.notes.length, density);
      }

      for (const note of out.notes) {
        checkNote(note, role);
        assert(inScale(note.pitch, mode));

        if (
          role === 'melodist' &&
          [0, 2].includes(note.beat)
        ) {
          const chord =
            CHORDS[mode][Math.floor((bar % 8) / 2)];

          assert(chord.includes(absPc(note.pitch)));
        }

        if (role === 'pulse') {
          const pentatonic = mode === 'ionian'
            ? [2, 4, 6, 9, 11]
            : [2, 5, 7, 9, 0];

          assert(pentatonic.includes(absPc(note.pitch)));

          assert(
            Number.isInteger(
              note.beat * [1, 2, 4][density - 1],
            ),
          );
        }
      }

      state = out.state;
    }
  });
}

test('Architect follows progressions, durations and ninths', () => {
  for (const mode of MODES) {
    for (const density of [1, 3]) {
      let state = {};

      for (let bar = 0; bar < 16; bar++) {
        const out = play('architect', {
          bar,
          ctx: { mode, density },
          state,
        });

        if (bar % 2) {
          assert.deepEqual(out.notes, []);
        } else {
          const chord =
            CHORDS[mode][Math.floor((bar % 8) / 2)];

          const expected = density === 3
            ? [...chord, (chord[0] + 2) % 12]
            : chord;

          const pcs = out.notes
            .filter((n) => n.pitch !== 38)
            .map((n) => absPc(n.pitch));

          assert.deepEqual(pcs.sort(), [...expected].sort());
          assert(out.notes.some((n) => n.pitch === 38));

          assert(
            out.notes.every(
              (n) => n.beat === 0 && n.dur === 8,
            ),
          );
        }

        state = out.state;
      }
    }
  }
});

test('Melodist repeats its motif in scene bars 1, 3 and 5', () => {
  for (const mode of MODES) {
    const pool = Array.from(
      { length: 13 },
      (_, i) => 62 + i,
    ).filter((p) => SCALES[mode].includes(relPc(p)));

    const rng = mulberry32(58);
    let state = {};
    let original;

    for (let bar = 0; bar < 8; bar++) {
      const out = play('melodist', {
        bar,
        ctx: { mode, density: 2 },
        state,
        rng,
      });

      if ([0, 2, 4].includes(bar)) {
        const first = pool.indexOf(out.notes[0].pitch);

        const shape = out.notes.map(
          (n) => pool.indexOf(n.pitch) - first,
        );

        if (bar === 0) original = shape;
        else assert.deepEqual(shape, original);
      }

      state = out.state;
    }
  }
});

test('Weaver prefers thirds and avoids predicted melody notes', () => {
  const ctx = { mode: 'ionian', density: 2 };

  assert(
    play('weaver', { ctx }).notes.every(
      (n) => absPc(n.pitch) === 6,
    ),
  );

  const predictions = freeze([
    { role: 'melodist', bar: 0, slot: 0, pc: 6 },
  ]);

  const out = play('weaver', { ctx, predictions });

  assert.notEqual(absPc(out.notes[0].pitch), 6);
  assert.equal(absPc(out.notes[1].pitch), 6);

  const lastBarNotes = freeze([
    { role: 'melodist', bar: -1, beat: 0, pitch: 66 },
  ]);

  assert.notEqual(
    absPc(play('weaver', { ctx, lastBarNotes }).notes[0].pitch),
    6,
  );
});

test('Pulse uses the agreed grids and gate probabilities', () => {
  for (const density of [1, 2, 3]) {
    const ctx = { mode: 'ionian', density };
    const chance = density === 1 ? 0.3 : 0.6;

    assert.equal(
      play('pulse', {
        ctx,
        rng: () => chance - 0.001,
      }).notes.length,
      [4, 8, 16][density - 1],
    );

    assert.deepEqual(
      play('pulse', { ctx, rng: () => chance }).notes,
      [],
    );
  }
});

test('all roles are reproducible across response phases', () => {
  function run(role) {
    let state = {};
    const rng = mulberry32(84);
    const result = [];

    for (let bar = 0; bar < 32; bar++) {
      const absorb =
        bar >= 8 && bar < 12
          ? { pcs: [3] }
          : bar >= 16 && bar < 20
            ? { pcs: [8] }
            : null;

      const out = play(role, {
        bar,
        state,
        rng,
        absorb,
        defend: bar >= 24 && bar < 28,
      });

      result.push(out);
      state = out.state;
    }

    return result;
  }

  for (const role of ROLES) {
    assert.deepEqual(run(role), run(role));
  }
});

test('every voice answers Eb/E7 and then resolves to A', () => {
  for (const role of ROLES) {
    for (const pc of [3, 8]) {
      let state = {};

      for (let bar = 0; bar < 4; bar++) {
        const out = play(role, {
          bar,
          state,
          ctx: { mode: 'aeolian', density: 3 },
          rng: () => 0.1,
          absorb: { pcs: [pc] },
        });

        const chord = bar >= 2
          ? [9, 1, 4]
          : pc === 3
            ? [3, 7, 10]
            : [4, 8, 11, 2];

        for (const n of out.notes) {
          if (role === 'architect' && n.pitch === 38) {
            continue;
          }

          assert(chord.includes(absPc(n.pitch)));
        }

        if (
          role === 'architect' &&
          pc === 8 &&
          bar === 0
        ) {
          const pcs = out.notes
            .filter((n) => n.pitch !== 38)
            .map((n) => absPc(n.pitch));

          assert.deepEqual(
            pcs.sort(),
            [2, 4, 8, 11].sort(),
          );
        }

        state = out.state;
      }
    }
  }
});

test('1,000 response contexts per role respect outside-note permissions', () => {
  for (const role of ROLES) {
    const random = mulberry32(992);
    const rng = mulberry32(24);
    let state = {};

    for (let bar = 0; bar < 1000; bar++) {
      const ctx = {
        mode: MODES[Math.floor(random() * 3)],
        density: 1 + Math.floor(random() * 3),
      };

      const pcs = [
        [], [3], [8], [3, 8],
      ][Math.floor(random() * 4)];

      const defend = random() < 0.1;
      const before = structuredClone(state);

      const out = play(role, {
        bar,
        ctx,
        state: freeze(state),
        rng,
        defend,
        absorb: pcs.length ? { pcs } : null,
      });

      assert.deepEqual(state, before);
      assert.notEqual(out.state, state);

      for (const n of out.notes) {
        checkNote(n, role, defend);

        if (isOutsideUnion(n.pitch)) {
          assert(!defend && pcs.includes(absPc(n.pitch)));
        }
      }

      state = out.state;
    }
  }
});

test('defence strengthens Architect and simplifies the other honest voices', () => {
  const normal = play('architect');

  const odd = play('architect', {
    bar: 1,
    state: normal.state,
    defend: true,
  });

  assert.deepEqual(
    odd.notes.map((n) => n.pitch).sort(),
    [45, 50],
  );

  const defended = play('architect', {
    bar: 2,
    state: odd.state,
    defend: true,
  });

  assert.deepEqual(
    defended.notes.slice(0, 3).map((n) => n.pitch),
    [38, 45, 50],
  );

  assert(
    defended.notes.slice(3).every(
      (n) => Math.abs(n.vel - 0.6) < 1e-9,
    ),
  );

  const restored = play('architect', {
    bar: 4,
    state: defended.state,
  });

  assert(!restored.notes.some((n) => n.pitch === 45));

  for (const role of ['melodist', 'weaver']) {
    for (const density of [1, 2, 3]) {
      const out = play(role, {
        ctx: { mode: 'aeolian', density },
        defend: true,
      });

      assert.equal(
        out.notes.length,
        role === 'melodist' ? 2 : 1,
      );

      assert(
        out.notes.every(
          (n) => [57, 62, 69, 74].includes(n.pitch),
        ),
      );
    }
  }
});

test('corrupted Pulse keeps its own register despite response inputs', () => {
  const out = play('pulse', {
    rogue: true,
    defend: true,
    absorb: { pcs: [3] },
  });

  assert(out.notes.length >= 2);

  assert.equal(
    new Set(out.notes.map((n) => `${n.beat}:${n.pitch}`)).size,
    out.notes.length,
  );

  assert(
    out.notes.every(
      (n) =>
        Number.isInteger(n.pitch) &&
        n.pitch >= 74 &&
        n.pitch <= 86,
    ),
  );

  assert(
    out.notes.filter((n) => isOutsideUnion(n.pitch)).length >=
      Math.ceil(out.notes.length / 2),
  );
});

test('actual composer causes no honest rogue flags under partial loss', () => {
  const data = JSON.parse(
    readFileSync(
      new URL('../web/data/agents.json', import.meta.url),
      'utf8',
    ),
  );

  const scenes = JSON.parse(
    readFileSync(
      new URL(
        '../sim/data/scenes_eval.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ).slice(0, 12);

  for (const loss of [0, 0.25, 0.5, 0.75]) {
    for (let seed = 0; seed < 10; seed++) {
      const out = runOne({
        data,
        scenes,
        method: 'ea',
        loss,
        rogue: true,
        seed,
        compose,
      });

      assert.equal(
        out.false_positive_flags,
        0,
        `loss ${loss}, seed ${seed}`,
      );

      if (loss === 0) {
        assert(
          out.detect_all_bars !== null &&
          out.detect_all_bars <= 4,
        );
      }
    }
  }
});
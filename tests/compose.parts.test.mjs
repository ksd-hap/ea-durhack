import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compose } from '../web/core/compose.js';
import { mulberry32, seedFor } from '../web/core/rng.js';
import {
  inScale,
  isOutsideUnion,
} from '../web/core/theory.js';
import { runOne } from '../sim/engine.mjs';

const ROLES = ['architect', 'melodist', 'weaver', 'pulse'];
const MODES = ['ionian', 'dorian', 'aeolian'];

const REGISTER = {
  architect: [38, 62],
  melodist: [62, 74],
  weaver: [57, 69],
  pulse: [74, 86],
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
    cover: null,
    ...extra,
  });
}

for (const role of ROLES) {
  test(`${role}: 1,000 corrupted parts obey the new contract`, () => {
    const random = mulberry32(447);
    const rng = mulberry32(seedFor(role, 7));
    let state = {};

    for (let bar = 0; bar < 1000; bar++) {
      const ctx = {
        mode: MODES[Math.floor(random() * 3)],
        density: 1 + Math.floor(random() * 3),
      };

      const before = structuredClone(state);

      const out = play(role, {
        bar,
        ctx,
        state,
        rng,
        rogue: true,
        cover: 'architect',
        defend: true,
        absorb: { pcs: [3] },
      });

      assert.deepEqual(state, before);
      assert.notEqual(out.state, state);
      assert(out.notes.length >= 2);

      assert(
        out.notes.filter(
          (n) => isOutsideUnion(n.pitch),
        ).length >= Math.ceil(out.notes.length / 2),
      );

      for (const n of out.notes) {
        assert(
          Number.isInteger(n.pitch) &&
          n.pitch >= REGISTER[role][0] &&
          n.pitch <= REGISTER[role][1],
        );

        assert(
          Number.isFinite(n.beat) &&
          n.beat >= 0 &&
          n.beat < 4,
        );

        assert(Number.isFinite(n.dur) && n.dur > 0);

        assert(
          Number.isFinite(n.vel) &&
          n.vel > 0 &&
          n.vel <= 1,
        );

        assert.deepEqual(
          Object.keys(n).sort(),
          ['beat', 'dur', 'pitch', 'vel'],
        );
      }

      if (role === 'architect') {
        assert(out.notes.some((n) => n.pitch === 44));
        assert(out.notes.some((n) => n.pitch === 51));
      }

      assert(out.notes.every((n) => n.dur === 0.25));

      assert(
        out.notes.every(
          (n) => [0.5, 0.75].includes(n.beat % 1),
        ),
      );

      assert.equal(
        new Set(
          out.notes.map((n) => `${n.beat}:${n.pitch}`),
        ).size,
        out.notes.length,
      );

      state = out.state;
    }
  });
}

test('cover parts are in-scale additions that preserve the original part', () => {
  const expected = {
    architect: [38, 45],
    melodist: [62, 69],
    weaver: [62],
    pulse: [74, 81],
  };

  for (const role of ROLES) {
    for (const cover of ROLES) {
      for (const mode of MODES) {
        const ctx = { mode, density: 2 };

        const normal = play(role, { ctx });
        const covered = play(role, { ctx, cover });

        if (role === cover) {
          assert.deepEqual(covered.notes, normal.notes);
          continue;
        }

        assert.equal(
          covered.notes.length,
          normal.notes.length + expected[cover].length,
        );

        const remaining = covered.notes.map(
          (n) => JSON.stringify(n),
        );

        for (const note of normal.notes) {
          const i = remaining.indexOf(JSON.stringify(note));
          assert(i >= 0);
          remaining.splice(i, 1);
        }

        const extra = remaining.map((n) => JSON.parse(n));

        assert.deepEqual(
          extra.map((n) => n.pitch),
          expected[cover],
        );

        assert(
          extra.every(
            (n) => inScale(n.pitch, mode) && n.dur > 0,
          ),
        );

        assert(
          covered.notes.every(
            (n, i, arr) =>
              i === 0 || n.beat >= arr[i - 1].beat,
          ),
        );
      }
    }
  }
});

test('cover works with absorb and defend; rogues never perform an honest cover', () => {
  for (const cover of ROLES) {
    const role = cover === 'melodist'
      ? 'weaver'
      : 'melodist';

    const cases = [
      { absorb: { pcs: [3] } },
      { absorb: { pcs: [8] } },
      { defend: true },
    ];

    for (const options of cases) {
      const out = play(role, { cover, ...options });
      assert(out.notes.length > 0);

      for (const n of out.notes) {
        if (isOutsideUnion(n.pitch)) {
          assert(
            options.absorb?.pcs.includes(
              ((n.pitch % 12) + 12) % 12,
            ),
          );
        }
      }
    }

    const rogue = play(role, { rogue: true });
    const withCover = play(role, { rogue: true, cover });

    assert.deepEqual(withCover, rogue);
  }
});

test('corruption and covering remain reproducible across bars', () => {
  function run(role) {
    let state = {};
    const rng = mulberry32(99);
    const results = [];

    for (let bar = 0; bar < 24; bar++) {
      const out = play(role, {
        bar,
        state,
        rng,
        rogue: bar >= 8 && bar < 16,
        cover: bar >= 16 ? 'architect' : null,
      });

      results.push(out);
      state = out.state;
    }

    return results;
  }

  for (const role of ROLES) {
    assert.deepEqual(run(role), run(role));
  }
});

test('every corrupted role is caught within four bars at zero loss', () => {
  const data = JSON.parse(
    readFileSync(
      new URL('../web/data/agents.json', import.meta.url),
      'utf8',
    ),
  );

  const scenes = JSON.parse(
    readFileSync(
      new URL('../sim/data/scenes_eval.json', import.meta.url),
      'utf8',
    ),
  ).slice(0, 12);

  for (const rogueId of ['eyeA', 'poetA', 'eyeB', 'poetB']) {
    for (const loss of [0, 0.25, 0.5]) {
      for (let seed = 0; seed < 10; seed++) {
        const out = runOne({
          data,
          scenes,
          method: 'ea',
          loss,
          rogue: true,
          rogueId,
          seed,
          compose,
        });

        assert.equal(
          out.false_positive_flags,
          0,
          `${rogueId}, loss ${loss}, seed ${seed}`,
        );

        if (loss === 0) {
          assert(
            out.detect_all_bars !== null &&
            out.detect_all_bars <= 4,
          );
        }
      }
    }
  }
});
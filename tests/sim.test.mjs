// Role 2 simulator tests from the plan's test table:
//   healthy-run false positives: 0 rogue flags over 10 seeds with the rogue off
//   detection: rogue on, loss 0 -> flagged within 4 bars in every seed
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOne } from '../sim/engine.mjs';

const data = JSON.parse(readFileSync(new URL('../web/data/agents.json', import.meta.url), 'utf8'));
const scenes = JSON.parse(readFileSync(new URL('../sim/data/scenes_eval.json', import.meta.url), 'utf8')).slice(0, 12);

test('no false-positive flags over 10 seeds with the rogue off, at every loss', () => {
  for (const method of ['ea', 'random', 'baseline']) {
    for (const loss of [0, 0.5, 1]) {
      for (let seed = 0; seed < 10; seed++) {
        const r = runOne({ data, scenes, method, loss, rogue: false, seed });
        assert.equal(r.false_positive_flags, 0, `${method} loss ${loss} seed ${seed}`);
      }
    }
  }
});

test('rogue flagged by every honest agent within 4 bars at loss 0, every seed', () => {
  for (let seed = 0; seed < 10; seed++) {
    const r = runOne({ data, scenes, method: 'ea', loss: 0, rogue: true, seed });
    assert.ok(r.detect_all_bars !== null && r.detect_all_bars <= 4, `seed ${seed}: ${r.detect_all_bars}`);
    assert.equal(r.false_positive_flags, 0, `seed ${seed}: rogue's false accusation must fail`);
  }
});

test('EÄ beats the random-rotation control on accuracy (sanity on fake data)', () => {
  const ea = runOne({ data, scenes, method: 'ea', loss: 1, rogue: false, seed: 0 });
  const rnd = runOne({ data, scenes, method: 'random', loss: 1, rogue: false, seed: 0 });
  assert.ok(ea.accuracy > rnd.accuracy, `${ea.accuracy} vs ${rnd.accuracy}`);
});

// Contract test between Role 2 (caller) and Role 3 (compose.js owner).
// Runs the CURRENT compose() on the shared examples and checks the agreed output shape.
// Role 3's own property test (1,000 contexts per role, in-scale, in-range) is separate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compose } from '../web/core/compose.js';
import { mulberry32, seedFor } from '../web/core/rng.js';

const { examples } = JSON.parse(readFileSync(new URL('../web/core/compose.example.json', import.meta.url), 'utf8'));

function checkNotes(notes, label) {
  assert.ok(Array.isArray(notes), `${label}: notes must be an array`);
  for (const n of notes) {
    assert.deepEqual(Object.keys(n).sort(), ['beat', 'dur', 'pitch', 'vel'], `${label}: note keys`);
    assert.ok(Number.isFinite(n.beat) && n.beat >= 0 && n.beat < 4, `${label}: beat ${n.beat} in [0,4)`);
    assert.ok(Number.isInteger(n.pitch) && n.pitch >= 0 && n.pitch <= 127, `${label}: pitch ${n.pitch}`);
    assert.ok(Number.isFinite(n.dur) && n.dur > 0, `${label}: dur ${n.dur} > 0`);
    assert.ok(Number.isFinite(n.vel) && n.vel > 0 && n.vel <= 1, `${label}: vel ${n.vel} in (0,1]`);
  }
}

test('the illustrative example outputs themselves satisfy the contract', () => {
  for (const ex of examples) {
    checkNotes(ex.output.notes, ex.name);
    assert.equal(typeof ex.output.state, 'object');
  }
});

for (const ex of examples) {
  test(`compose() returns {notes, state} for: ${ex.name}`, () => {
    const rng = mulberry32(seedFor(ex.rngSeed.id, ex.rngSeed.seed));
    const frozen = structuredClone(ex.input);
    const out = compose({ ...ex.input, rng });
    assert.ok(out && !Array.isArray(out), 'must return an object { notes, state }');
    checkNotes(out.notes, ex.name);
    assert.ok(out.state && typeof out.state === 'object', 'must return a state object');
    assert.deepEqual(ex.input, frozen, 'must not mutate its input (including state)');
  });

  test(`compose() is deterministic given the rng for: ${ex.name}`, () => {
    const run = () => compose({ ...structuredClone(ex.input), rng: mulberry32(seedFor(ex.rngSeed.id, ex.rngSeed.seed)) });
    assert.deepEqual(run(), run());
  });
}

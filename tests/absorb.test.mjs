// Role 2 test: honest agents answering Melkor ("absorb") must not get flagged themselves.
//
// The absorb chords legitimately contain the two pitch classes the detector treats as rogue
// evidence: Eb major (the Neapolitan, answering a rogue Eb) contains Eb, and E7 (V/V,
// answering a rogue G#) contains G#. Found by Role 1 in review.
//
// absorbingCompose stands in for Role 3: whenever it is told to absorb, it plays only chord
// tones of the answering chord(s), every bar. That is harsher than the real rule (one chord
// slot of absorb, then A), so passing here is conservative.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOne } from '../sim/engine.mjs';
import { compose as placeholder } from '../web/core/compose.js';
import { absPc, isOutsideUnion } from '../web/core/theory.js';

const data = JSON.parse(readFileSync(new URL('../web/data/agents.json', import.meta.url), 'utf8'));
const scenes = JSON.parse(readFileSync(new URL('../sim/data/scenes_eval.json', import.meta.url), 'utf8')).slice(0, 12);

const ANSWER = {
  3: [3, 7, 10], // rogue Eb -> Eb major: Eb G Bb
  8: [4, 8, 11, 2], // rogue G# -> E7: E G# B D
};
const RANGE = { architect: [50, 62], melodist: [62, 74], weaver: [57, 69], pulse: [74, 86] };

let outsideHonestNotes = 0;
function absorbingCompose(args) {
  const { role, rng, absorb, rogue } = args;
  if (rogue || !absorb) return placeholder(args);
  const pcs = new Set(absorb.pcs.flatMap((pc) => ANSWER[pc] ?? []));
  if (pcs.size === 0) return placeholder(args);
  const [lo, hi] = RANGE[role];
  const pool = [];
  for (let p = lo; p <= hi; p++) if (pcs.has(absPc(p))) pool.push(p);
  const notes = [0, 1, 2, 3].map((beat) => ({ beat, pitch: pool[Math.floor(rng() * pool.length)], dur: 1, vel: 0.6 }));
  outsideHonestNotes += notes.filter((n) => isOutsideUnion(n.pitch)).length;
  return { notes, state: args.state };
}

test('absorbing honest agents really do play Eb/G# (the test exercises the conflict)', () => {
  outsideHonestNotes = 0;
  runOne({ data, scenes, method: 'ea', loss: 0, rogue: true, seed: 0, compose: absorbingCompose });
  assert.ok(outsideHonestNotes > 20, `only ${outsideHonestNotes} honest Eb/G# notes`);
});

test('honest agents playing absorb chords are never flagged, 10 seeds x loss 0/0.25/0.5', () => {
  for (const loss of [0, 0.25, 0.5]) {
    for (let seed = 0; seed < 10; seed++) {
      const r = runOne({ data, scenes, method: 'ea', loss, rogue: true, seed, compose: absorbingCompose });
      assert.equal(r.false_positive_flags, 0, `loss ${loss} seed ${seed}: honest agent flagged`);
      if (loss === 0) assert.ok(r.detect_all_bars !== null && r.detect_all_bars <= 4, `seed ${seed}: Melkor latency ${r.detect_all_bars}`);
    }
  }
});

test("Melkor's own accusations never excuse Melkor's notes", async () => {
  const { createAgent } = await import('../web/core/agent.js');
  const a = createAgent({ id: 'eyeA', params: data.agents.eyeA, anchors: data.anchors, thresholds: data.thresholds, seed: 0 });
  for (let bar = 0; bar < 6; bar++) {
    // poetB (Melkor) accuses poetA every bar, hoping its Eb's look like an absorb answer.
    a.onPeer({ type: 'suspect', from: 'poetB', target: 'poetA', score: 0.9, suspect: true, bar });
    for (let beat = 0; beat < 2; beat++) a.onPeer({ type: 'note', from: 'poetB', bar, beat, pitch: 75, vel: 0.9, dur: 0.5 });
    a.planBar(bar);
  }
  assert.ok(a.inspect().suspected.includes('poetB'), 'Melkor must still be suspected');
  assert.ok(!a.inspect().suspected.includes('poetA'), 'the framed agent must not be');
});

test('Melkor cannot hide behind absorb: still flagged when everyone absorbs, every seed', () => {
  for (let seed = 0; seed < 10; seed++) {
    const r = runOne({ data, scenes, method: 'ea', loss: 0.25, rogue: true, seed, compose: absorbingCompose });
    assert.ok(r.detect_first_bars !== null, `seed ${seed}: Melkor never flagged`);
  }
});

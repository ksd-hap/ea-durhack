// Role 2 tests: hysteresis, rogue-detection rules, purity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { levelWithHysteresis } from '../web/core/perception.js';
import { OUTSIDE_REL_PCS, SCALES } from '../web/core/theory.js';
import { createAgent } from '../web/core/agent.js';

const TH = [-0.43, 0.43];

test('hysteresis: a boundary only moves when crossed by more than h', () => {
  assert.equal(levelWithHysteresis(0.0, TH, 0.1, null), 1);
  assert.equal(levelWithHysteresis(0.5, TH, 0.1, 1), 1, 'just over hi: stay');
  assert.equal(levelWithHysteresis(0.54, TH, 0.1, 1), 2, 'over hi + h: move');
  assert.equal(levelWithHysteresis(0.35, TH, 0.1, 2), 2, 'just under hi: stay');
  assert.equal(levelWithHysteresis(0.3, TH, 0.1, 2), 1, 'under hi - h: move');
  assert.equal(levelWithHysteresis(-2, TH, 0.1, 2), 0, 'can jump two levels');
});

test('the three modes leave exactly Eb and G# (rel. to D) outside', () => {
  assert.deepEqual(OUTSIDE_REL_PCS, [1, 6]);
  for (const m of Object.keys(SCALES)) for (const pc of SCALES[m]) assert.ok(!OUTSIDE_REL_PCS.includes(pc));
});

const data = JSON.parse(readFileSync(new URL('../web/data/agents.json', import.meta.url), 'utf8'));
const mk = (id, seed = 0) =>
  createAgent({ id, params: data.agents[id], anchors: data.anchors, thresholds: data.thresholds, seed });

test('an uncorroborated false accusation does not flag an honest agent', () => {
  const a = mk('eyeA');
  for (let bar = 0; bar < 12; bar++) {
    a.onPeer({ type: 'suspect', from: 'poetB', target: 'poetA', score: 0.9, suspect: true, bar });
    a.onPeer({ type: 'note', from: 'poetA', bar, beat: 0, pitch: 62, vel: 0.5, dur: 1 });
    a.planBar(bar);
  }
  assert.deepEqual(a.inspect().flagged, []);
});

test('own suspicion + one corroboration flags; flags are sticky until resetFlags', () => {
  const a = mk('eyeA');
  let bar = 0;
  const step = (rogueNotes, corroborate) => {
    for (let i = 0; i < rogueNotes; i++) a.onPeer({ type: 'note', from: 'poetB', bar, beat: i, pitch: 75, vel: 0.9, dur: 0.5 });
    a.onPeer({ type: 'note', from: 'poetA', bar, beat: 0, pitch: 62, vel: 0.5, dur: 1 });
    if (corroborate) a.onPeer({ type: 'suspect', from: 'poetA', target: 'poetB', score: 0.6, suspect: true, bar });
    return a.planBar(bar++);
  };
  step(0, false);
  step(2, false);
  step(2, false);
  assert.deepEqual(a.inspect().suspected, ['poetB']);
  assert.deepEqual(a.inspect().flagged, [], 'suspected but not yet corroborated');
  step(2, true);
  const out = step(0, false);
  assert.deepEqual(a.inspect().flagged, ['poetB']);
  assert.equal(out.telemetry.find((t) => t.type === 'status').response, 'absorb');
  // Silence: a short defend phrase as it begins, then back to normal; the flag holds throughout.
  const responses = [];
  for (let i = 0; i < 10; i++) responses.push(a.planBar(bar++).telemetry.find((t) => t.type === 'status').response);
  assert.ok(responses.includes('defend'), `defended at the start of the silence: ${responses}`);
  assert.equal(responses.at(-1), 'normal', `back to its own mood after the phrase: ${responses}`);
  assert.deepEqual(a.inspect().flagged, ['poetB'], 'sticky through the cut');
  a.resetFlags();
  assert.deepEqual(a.inspect().flagged, []);
});

test('planBar output is deterministic for a given seed', () => {
  const run = () => {
    const a = mk('poetA', 7);
    a.onView(0, new Array(data.agents.poetA.dim).fill(0.01));
    return JSON.stringify([0, 1, 2].map((b) => a.planBar(b, { t0: 1000 })));
  };
  assert.equal(run(), run());
});

test('notes carry the NoteEvent contract fields', () => {
  const a = mk('eyeB');
  const { notes, outbox } = a.planBar(0, { t0: 0 });
  assert.ok(notes.length > 0);
  for (const n of notes) {
    for (const k of ['from', 'at', 'bar', 'beat', 'pitch', 'vel', 'dur', 'role', 'rogue']) assert.ok(k in n, k);
    assert.ok(Number.isFinite(n.at));
  }
  assert.ok(outbox.some((m) => m.type === 'note'));
});

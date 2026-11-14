// Belief sharing: better together, fine alone. (Roles 1 + 2)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOne } from '../sim/engine.mjs';
import { createAgent } from '../web/core/agent.js';

const data = JSON.parse(readFileSync(new URL('../web/data/agents.json', import.meta.url), 'utf8'));
const scenes = JSON.parse(readFileSync(new URL('../sim/data/scenes_eval.json', import.meta.url), 'utf8')).slice(0, 60);
const real = !data.fake && data.fusion;
const run = (method, loss, rogue = false, seed = 0, extra = {}) => runOne({ data, scenes, method, loss, rogue, seed, ...extra });

test('sharing beats independent agents while connected (real data)', { skip: !real && 'needs real data with fusion scales' }, () => {
  const ea = run('ea', 0);
  const ind = run('independent', 0);
  assert.ok(ea.accuracy > ind.accuracy + 0.05, `shared ${ea.accuracy} vs independent ${ind.accuracy}`);
});

test('after the cut, sharing degrades to exactly the independent agents', () => {
  // Beliefs about the scene starting at the cut (bar 16) were exchanged at bars 13-15, before it,
  // so that scene still benefits. From the NEXT scene on, every agent is alone: identical numbers.
  for (const rogue of [false, true]) {
    const ea = run('ea', 1, rogue, 0, { measureFrom: 24 });
    const ind = run('independent', 1, rogue, 0, { measureFrom: 24 });
    assert.equal(ea.accuracy, ind.accuracy, `rogue ${rogue}`);
    assert.equal(ea.agreement, ind.agreement, `rogue ${rogue}`);
  }
});

test('sharing in the RANDOM frame does not help (the shared frame is what matters)', { skip: !real && 'needs real data' }, () => {
  const rnd = run('random', 0);
  assert.ok(rnd.accuracy < 0.2, `random-frame sharing accuracy ${rnd.accuracy}`);
});

test('no false flags and Melkor still caught with sharing on', () => {
  for (let seed = 0; seed < 5; seed++) {
    assert.equal(run('ea', 0.5, false, seed).false_positive_flags, 0, `seed ${seed}`);
    const r = run('ea', 0, true, seed);
    assert.ok(r.detect_all_bars !== null && r.detect_all_bars <= 4, `seed ${seed}: ${r.detect_all_bars}`);
    assert.equal(r.false_positive_flags, 0);
  }
});

test("a flagged peer's beliefs are ignored, and beliefs are fused only per scene", () => {
  const mk = () => createAgent({ id: 'eyeA', params: data.agents.eyeA, anchors: data.anchors, thresholds: data.thresholds, fusion: data.fusion ?? null, seed: 0 });
  const a = mk();
  a.onView(0, scenes[0].views.eyeA);
  a.onPeer({ type: 'belief', from: 'poetA', bar: 0, v: 1, a: 1 });
  a.onPeer({ type: 'belief', from: 'poetB', bar: 0, v: -4, a: -4 });
  a.onPeer({ type: 'belief', from: 'eyeB', bar: 8, v: 2, a: 2 }); // a different scene: not used for bar 0
  let ctx = a.planBar(0).telemetry.find((t) => t.type === 'ctx');
  assert.deepEqual(ctx.sharedWith.sort(), ['poetA', 'poetB']);
  // Flag poetB (two bars of Eb plus a corroborating suspicion), then its belief must be dropped.
  for (let bar = 1; bar <= 4; bar++) {
    for (let i = 0; i < 2; i++) a.onPeer({ type: 'note', from: 'poetB', bar, beat: i, pitch: 75, vel: 0.9, dur: 0.5 });
    a.onPeer({ type: 'suspect', from: 'poetA', target: 'poetB', score: 0.6, suspect: true, bar });
    ctx = a.planBar(bar).telemetry.find((t) => t.type === 'ctx');
  }
  assert.deepEqual(a.inspect().flagged, ['poetB']);
  assert.ok(!ctx.sharedWith.includes('poetB'), `still fusing a flagged peer: ${ctx.sharedWith}`);
});

test('Melkor lies in its beliefs (broadcasts the opposite of what it perceives)', () => {
  const m = createAgent({ id: 'poetB', params: data.agents.poetB, anchors: data.anchors, thresholds: data.thresholds, fusion: data.fusion ?? null, seed: 0 });
  m.onView(0, scenes[0].views.poetB);
  const honest = m.planBar(0).outbox.find((x) => x.type === 'belief');
  m.setRogue(true);
  const lie = m.planBar(1).outbox.find((x) => x.type === 'belief');
  assert.equal(lie.v, -honest.v);
  assert.equal(lie.a, -honest.a);
});

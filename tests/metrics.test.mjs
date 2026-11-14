// Role 1 tests: web/metrics.js, the single definition of every Stage metric and simulator number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMetrics } from '../web/metrics.js';
import { runOne } from '../sim/engine.mjs';

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, `${msg}: ${a} vs ${b}`);
const note = (from, bar, beat, pitch) => ({ type: 'note', from, bar, beat, pitch, vel: 0.6, dur: 1, role: 'x', rogue: false });
const ctx = (from, bar, mode, density) => ({ type: 'ctx', from, bar, mode, density });
const status = (from, bar, o = {}) => ({ type: 'status', from, bar, rogue: false, flagged: [], suspected: [], ...o });

// Hand-built bar 8 of scene 1 (truth dorian/2):
//   eyeA dorian/2 (right), poetA dorian/1 (mode right), eyeB ionian/2, poetB = Melkor.
//   Honest = eyeA, poetA, eyeB. Accuracy 1/3, mode 2/3, agreement 0/3 pairs, mode agreement 1/3.
//   Majority mode: dorian (2 votes). Notes: D(62) F(65) in dorian; F#(66) not; Melkor Eb(75) not.
//     consonance = 2/4.
//   eyeA ghost about poetA, slot 0, pc F -> poetA played F(65) at beat 0: hit. Ghost about eyeB at
//     beat 1 pitch D -> eyeB played nothing there: miss. ghost match 1/2.
//   eyeA and poetA flag poetB; eyeB only suspects it.
function scenario() {
  return [
    { type: 'scene', index: 1, bar: 8, id: 's1', truth: { mode: 'dorian', density: 2 } },
    ctx('eyeA', 8, 'dorian', 2), ctx('poetA', 8, 'dorian', 1), ctx('eyeB', 8, 'ionian', 2), ctx('poetB', 8, 'aeolian', 3),
    status('eyeA', 8, { flagged: ['poetB'] }), status('poetA', 8, { flagged: ['poetB'] }),
    status('eyeB', 8, { suspected: ['poetB'] }), status('poetB', 8, { rogue: true, flagged: ['eyeA'] }),
    note('eyeA', 8, 2, 62), note('poetA', 8, 0, 65), note('eyeB', 8, 3, 66), note('poetB', 8, 1, 75),
    { type: 'ghost', from: 'eyeA', about: 'poetA', bar: 8, beat: 0, pitch: 65 },
    { type: 'ghost', from: 'eyeA', about: 'eyeB', bar: 8, beat: 1, pitch: 62 },
    { type: 'ghost', from: 'poetB', about: 'eyeA', bar: 8, beat: 0, pitch: 62 }, // Melkor's ghosts don't count
  ];
}

test('per-bar definitions match hand-computed values', () => {
  const m = createMetrics();
  for (const msg of scenario()) m.ingest(msg);
  m.flush();
  const s = m.summary();
  assert.equal(s.bars, 1);
  close(s.accuracy, 1 / 3, 'accuracy');
  close(s.mode_accuracy, 2 / 3, 'mode accuracy');
  close(s.agreement, 0, 'agreement');
  close(s.mode_agreement, 1 / 3, 'mode agreement');
  close(s.consonance, 2 / 4, 'consonance (Melkor notes included)');
  close(s.prediction_match, 1 / 2, 'ghost match (honest ghosts only)');
  assert.equal(s.false_positive_flags, 0, "Melkor's own flag of eyeA is not an honest flag");
  assert.equal(s.detect_first_bars, 0);
  assert.equal(s.detect_all_bars, null, 'eyeB only suspects, so not all honest agents flag yet');
});

test('live snapshot: per-agent ticks, Melkor status, rx window, phase', () => {
  const m = createMetrics();
  for (const msg of scenario()) m.ingest(msg, 1000);
  m.ingest({ type: 'rx', from: 'eyeA', count: 5, loss: 0 }, 1000);
  m.ingest({ type: 'rx', from: 'poetA', count: 7, loss: 0 }, 9000);
  m.ingest(ctx('eyeA', 9, 'dorian', 2), 9500); // telemetry for bar 9 closes bar 8
  let s = m.snapshot(10500);
  assert.equal(s.bar, 8);
  assert.equal(s.scene.id, 's1');
  assert.deepEqual(Object.fromEntries(Object.entries(s.agents).map(([k, v]) => [k, v.correct])), { eyeA: true, poetA: false, eyeB: false, poetB: false });
  assert.deepEqual(Object.fromEntries(Object.entries(s.agents).map(([k, v]) => [k, v.melkor])), { eyeA: 'none', poetA: 'none', eyeB: 'none', poetB: 'flagged' });
  assert.equal(s.agents.poetB.rogue, true);
  assert.equal(s.rxLast10s, 12);
  assert.equal(s.phase, 'Halls');
  s = m.snapshot(12000); // the t=1000 rx is now older than 10 s
  assert.equal(s.rxLast10s, 7);
  for (const id of ['eyeA', 'poetA']) m.ingest({ type: 'rx', from: id, count: 0, loss: 1 }, 12000);
  assert.equal(m.snapshot(12000).phase, 'Void');
});

test('consonance on a tie privileges no mode', () => {
  const m = createMetrics();
  // Two honest agents, dorian vs ionian (tie). F(65): dorian only -> 1/2. F#(66): ionian only -> 1/2.
  // D(62): both -> 1. Total (0.5 + 0.5 + 1) / 3.
  for (const msg of [ctx('eyeA', 0, 'dorian', 1), ctx('eyeB', 0, 'ionian', 1), note('eyeA', 0, 0, 65), note('eyeB', 0, 1, 66), note('eyeA', 0, 2, 62)]) m.ingest(msg);
  m.flush();
  close(m.summary().consonance, 2 / 3, 'tie consonance');
});

test('arrival order does not change any number (live workers interleave; the sim does not)', () => {
  const data = JSON.parse(readFileSync(new URL('../web/data/agents.json', import.meta.url), 'utf8'));
  const msgs = [];
  for (let bar = 0; bar < 3; bar++) for (const m of scenario()) msgs.push({ ...m, bar: m.bar + bar * 8, ...(m.type === 'scene' ? { index: bar } : {}) });
  const inOrder = createMetrics();
  for (const m of msgs) inOrder.ingest(m);
  inOrder.flush();
  // Shuffle WITHIN each bar (the realistic case: one bar's telemetry from 4 workers interleaves).
  const shuffled = createMetrics();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let bar = 0; bar < 3; bar++) {
    const group = msgs.filter((m) => m.bar === 8 + bar * 8); // scenario bar 8, shifted by whole scenes
    assert.ok(group.length > 0, `no messages for bar ${8 + bar * 8}`);
    for (let i = group.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [group[i], group[j]] = [group[j], group[i]]; }
    for (const m of group) shuffled.ingest(m);
  }
  shuffled.flush();
  assert.deepEqual(shuffled.summary(), inOrder.summary());
  assert.ok(data.k > 0);
});

test('simulator rows come from metrics.js (all CSV fields present and sane)', () => {
  const data = JSON.parse(readFileSync(new URL('../web/data/agents.json', import.meta.url), 'utf8'));
  const scenes = JSON.parse(readFileSync(new URL('../sim/data/scenes_eval.json', import.meta.url), 'utf8')).slice(0, 6);
  const r = runOne({ data, scenes, method: 'ea', loss: 0, rogue: true, seed: 0 });
  for (const k of ['accuracy', 'mode_accuracy', 'agreement', 'mode_agreement', 'consonance', 'prediction_match', 'false_positive_flags', 'detect_all_bars']) {
    assert.ok(k in r && r[k] !== undefined, k);
  }
  for (const k of ['accuracy', 'agreement', 'consonance']) assert.ok(r[k] >= 0 && r[k] <= 1, `${k} ${r[k]}`);
  assert.equal(r.bars, 6 * 8 - 16);
});

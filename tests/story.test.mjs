// Story lines follow the run: start, corruption, catching, covering, cut, restore. [Role 2]
import test from 'node:test';
import assert from 'node:assert/strict';
import { STORY, storyKey, createNarrator } from '../web/story.js';

const st = (from, o = {}) => ({ from, rogue: false, suspected: [], flagged: [], response: 'none', covering: null, ...o });

test('every key storyKey can return has a title and a line', () => {
  for (const [k, v] of Object.entries(STORY)) assert.ok(v.title && v.line, k);
});

test('the run tells its story in order', () => {
  const base = { started: true, hubOpen: true, loss: 0 };
  assert.equal(storyKey({}), 'idle');
  assert.equal(storyKey(base), 'theme');
  assert.equal(storyKey({ ...base, randomRot: true }), 'noise');
  assert.equal(storyKey({ ...base, hubOpen: false }), 'theirs');
  assert.equal(storyKey({ ...base, loss: 0.5 }), 'thin');
  const rogue = { poetB: st('poetB', { rogue: true }) };
  assert.equal(storyKey({ ...base, status: rogue }), 'discord');
  assert.equal(storyKey({ ...base, status: { ...rogue, eyeA: st('eyeA', { suspected: ['poetB'] }) } }), 'suspect');
  assert.equal(storyKey({ ...base, status: { ...rogue, eyeA: st('eyeA', { response: 'absorb' }) } }), 'absorb');
  assert.equal(storyKey({ ...base, status: { ...rogue, eyeA: st('eyeA', { flagged: ['poetB'] }) } }), 'caught');
  assert.equal(storyKey({ ...base, status: { ...rogue, eyeA: st('eyeA', { flagged: ['poetB'], covering: 'pulse' }) } }), 'covered');
  assert.equal(storyKey({ ...base, loss: 1 }), 'void');
  assert.equal(storyKey({ ...base, loss: 1, status: rogue }), 'voidRogue');
  assert.equal(storyKey({ ...base, loss: 1, status: { ...rogue, eyeA: st('eyeA', { flagged: ['poetB'] }) } }), 'voidCaught');
  assert.equal(storyKey({ ...base, wasCut: true }), 'restored');
});

test('a flag on an honest agent does not count as catching Melkor', () => {
  const s = { poetB: st('poetB', { rogue: true }), eyeA: st('eyeA', { flagged: ['poetA'] }) };
  assert.equal(storyKey({ started: true, status: s }), 'discord');
});

test('lines are held long enough to read, but a cut shows at once', () => {
  let t = 0;
  const n = createNarrator({ holdMs: 5000, now: () => t });
  assert.equal(n.update('theme'), 'theme');
  t = 1000; assert.equal(n.update('discord'), 'theme'); // status flicker: held
  t = 5000; assert.equal(n.update('discord'), 'discord');
  t = 5100; assert.equal(n.update('voidRogue'), 'voidRogue'); // the cut: immediate
});

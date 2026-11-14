// Role 2 test: JavaScript maths vs NumPy on web/data/testvectors.json (to 1e-4),
// plus small hand-checked linalg cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { matrix, vecMat, normalise, cosine, dot } from '../web/core/linalg.js';
import { prepareParams, prepareAnchors, embed, moodScores, level, contextFromLevels } from '../web/core/perception.js';

const TOL = 1e-4;
const close = (a, b, msg) => assert.ok(Math.abs(a - b) <= TOL, `${msg}: ${a} vs ${b}`);

test('vecMat matches x @ W', () => {
  const W = matrix([[1, 2], [3, 4], [5, 6]]);
  assert.deepEqual([...vecMat([1, 0, -1], W)], [-4, -4]);
});

test('normalise and cosine', () => {
  const u = normalise([3, 4]);
  close(u[0], 0.6, 'u0');
  close(u[1], 0.8, 'u1');
  close(cosine([1, 0], [0, 2]), 0, 'orthogonal');
  close(cosine([1, 1], [2, 2]), 1, 'parallel');
  assert.deepEqual([...normalise([0, 0])], [0, 0], 'zero vector stays zero, never NaN');
  close(dot([1, 2], [3, 4]), 11, 'dot');
});

test('ragged matrix throws', () => {
  assert.throws(() => matrix([[1, 2], [3]]));
});

const tvPath = new URL('../web/data/testvectors.json', import.meta.url);
const agentsPath = new URL('../web/data/agents.json', import.meta.url);

test('JS perception matches NumPy testvectors to 1e-4', { skip: !existsSync(tvPath) && 'no testvectors.json yet' }, () => {
  const data = JSON.parse(readFileSync(agentsPath, 'utf8'));
  const tvs = JSON.parse(readFileSync(tvPath, 'utf8'));
  const anchors = prepareAnchors(data.anchors);
  assert.ok(tvs.length >= 4, 'expected at least one vector per agent');
  for (const tv of tvs) {
    const prep = prepareParams(data.agents[tv.agent]);
    const z = embed(prep, tv.x);
    assert.equal(z.length, tv.z.length);
    for (let i = 0; i < z.length; i++) close(z[i], tv.z[i], `${tv.agent} z[${i}]`);
    const s = moodScores(prep, anchors, z);
    close(s.valence, tv.valence, `${tv.agent} valence`);
    close(s.arousal, tv.arousal, `${tv.agent} arousal`);
    const ctx = contextFromLevels(level(s.valence, data.thresholds.valence), level(s.arousal, data.thresholds.arousal));
    assert.deepEqual(ctx, tv.context, `${tv.agent} ${tv.scene} context`);
  }
});

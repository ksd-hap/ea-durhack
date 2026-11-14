// Any agent can be corrupted, it corrupts ITS OWN job, it gets caught, and one honest agent
// covers for it. (Role 2; the music itself is Role 3's compose.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOne } from '../sim/engine.mjs';
import { createAgent, AGENT_IDS, ROLE_OF } from '../web/core/agent.js';
import { compose as realCompose } from '../web/core/compose.js';

const data = JSON.parse(readFileSync(new URL('../web/data/agents.json', import.meta.url), 'utf8'));
const scenes = JSON.parse(readFileSync(new URL('../sim/data/scenes_eval.json', import.meta.url), 'utf8')).slice(0, 24);

// Stand-in for Role 3's role-specific Melkor, following the contract in compose.js: corrupt your
// own register and rhythm, Eb/G# for >= half the notes, >= 2 notes per bar.
const REGISTER = { architect: [38, 62], melodist: [62, 74], weaver: [57, 69], pulse: [74, 86] };
const OUTSIDE = [3, 8]; // absolute pcs Eb, G#
function inRegister(pc, [lo, hi], rng) {
  const opts = [];
  for (let p = lo; p <= hi; p++) if (((p % 12) + 12) % 12 === pc) opts.push(p);
  return opts[Math.floor(rng() * opts.length)];
}
export function roleMelkor(args) {
  if (!args.rogue) return realCompose(args);
  const reg = REGISTER[args.role];
  const notes = [];
  if (args.role === 'architect') {
    // A poisoned drone and pad: the tritone G# under everything, Eb in the chord.
    notes.push({ beat: 0, pitch: inRegister(8, [38, 50], args.rng), dur: 4, vel: 0.8 });
    notes.push({ beat: 0, pitch: inRegister(3, [50, 62], args.rng), dur: 4, vel: 0.7 });
    notes.push({ beat: 2, pitch: inRegister(2, [50, 62], args.rng), dur: 2, vel: 0.5 });
  } else {
    for (let beat = 0; beat < 4; beat++) {
      const pc = beat % 2 === 0 ? OUTSIDE[Math.floor(args.rng() * 2)] : 2;
      notes.push({ beat, pitch: inRegister(pc, reg, args.rng), dur: 1, vel: 0.8 });
    }
  }
  return { notes, state: args.state };
}

for (const rogueId of AGENT_IDS) {
  test(`corrupting ${rogueId} (${ROLE_OF[rogueId]}) in its own job: caught within 4 bars, 0 false flags`, () => {
    for (let seed = 0; seed < 5; seed++) {
      for (const compose of [undefined, roleMelkor]) {
        const r = runOne({ data, scenes, method: 'ea', loss: 0, rogue: true, seed, rogueId, compose });
        const which = compose ? 'role-specific Melkor' : 'current composer';
        assert.ok(r.detect_all_bars !== null && r.detect_all_bars <= 4, `${which}, seed ${seed}: ${r.detect_all_bars}`);
        assert.equal(r.false_positive_flags, 0, `${which}, seed ${seed}`);
      }
    }
  });
}

test('exactly one honest agent covers the flagged agent, the next one in the fixed order', () => {
  for (const rogueId of AGENT_IDS) {
    const agents = AGENT_IDS.map((id) => createAgent({ id, params: data.agents[id], anchors: data.anchors, thresholds: data.thresholds, fusion: data.fusion ?? null, seed: 0 }));
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
    byId[rogueId].setRogue(true);
    let pending = [];
    let covering = {};
    for (let bar = 0; bar < 12; bar++) {
      for (const { from, msg } of pending) for (const a of agents) if (a.id !== from) a.onPeer(msg);
      pending = [];
      covering = {};
      for (const a of agents) {
        const out = a.planBar(bar);
        for (const m of out.outbox) pending.push({ from: a.id, msg: m });
        const st = out.telemetry.find((t) => t.type === 'status');
        if (st.covering) covering[a.id] = st.covering;
      }
    }
    const expected = AGENT_IDS[(AGENT_IDS.indexOf(rogueId) + 1) % 4];
    assert.deepEqual(covering, { [expected]: ROLE_OF[rogueId] }, `rogue ${rogueId}`);
  }
});

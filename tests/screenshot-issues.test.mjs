// Two issues seen on the live Stage (14 Nov, 22:40 screenshot), reproduced and pinned. [Role 2]
//  1. After the cut with a saboteur flagged, the Melodist and Weaver played only D/A forever
//     ("defend"), so the mountains and aurora went perfectly regular and the mood vanished.
//  2. After un-corrupting one agent and corrupting another, a stale flag made an honest agent
//     keep "repairing" the first one's layer ("Eye-B is repairing the mountains").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAgent, AGENT_IDS, DETECT } from '../web/core/agent.js';
import { absPc } from '../web/core/theory.js';
import { mulberry32, seedFor } from '../web/core/rng.js';

const data = JSON.parse(readFileSync(new URL('../web/data/agents.json', import.meta.url), 'utf8'));
const scenes = JSON.parse(readFileSync(new URL('../web/data/scenes.json', import.meta.url), 'utf8'));

/** A small live-like run: plan, deliver (with loss), call hooks per bar. */
function run({ bars, lossAt = () => 0, onBar = () => {}, seed = 0 }) {
  const agents = AGENT_IDS.map((id) => createAgent({ id, params: data.agents[id], anchors: data.anchors, thresholds: data.thresholds, fusion: data.fusion ?? null, seed }));
  const by = Object.fromEntries(agents.map((a) => [a.id, a]));
  const rng = Object.fromEntries(AGENT_IDS.map((id) => [id, mulberry32(seedFor(`t:${id}`, seed))]));
  let pending = [];
  const trace = [];
  for (let bar = 0; bar < bars; bar++) {
    if (bar % 8 === 0) for (const a of agents) a.onView(bar, scenes[(bar / 8) % scenes.length].views[a.id]);
    onBar(bar, by);
    const loss = lossAt(bar);
    for (const { from, msg } of pending) for (const a of agents) if (a.id !== from && rng[a.id]() >= loss) a.onPeer(msg);
    pending = [];
    const row = {};
    for (const a of agents) {
      const out = a.planBar(bar);
      for (const m of out.outbox) pending.push({ from: a.id, msg: m });
      row[a.id] = { status: out.telemetry.find((t) => t.type === 'status'), notes: out.notes };
    }
    trace.push(row);
  }
  return trace;
}

test('defend is a short phrase after the cut, then each agent plays its own mood again', () => {
  const CUT = 20;
  const trace = run({ bars: 48, lossAt: (b) => (b >= CUT ? 1 : 0), onBar: (b, by) => b === 8 && by.eyeA.setRogue(true) });
  for (const id of ['poetA', 'eyeB', 'poetB']) {
    const defendBars = trace.map((r, b) => (r[id].status.response === 'defend' ? b : null)).filter((b) => b !== null);
    assert.ok(defendBars.length > 0, `${id} never defended`);
    assert.ok(defendBars.length <= DETECT.defendBars, `${id} defended for ${defendBars.length} bars`);
    assert.ok(defendBars.every((b) => b >= CUT), `${id} defended before the cut`);
    assert.ok(trace[47][id].status.flagged.includes('eyeA'), `${id} forgot the flag after the cut`);
  }
  // The Melodist's last 16 bars use more than just D and A again (its mood is back in the music).
  const late = trace.slice(32).flatMap((r) => r.poetA.notes.map((n) => absPc(n.pitch)));
  const pcs = new Set(late);
  assert.ok([...pcs].some((pc) => pc !== 2 && pc !== 9), `melodist still only D/A after the phrase: ${[...pcs]}`);
});

test('un-corrupting then corrupting someone else leaves no stale cover (the screenshot case)', () => {
  // Poet-A corrupted, caught; then switched off WITH the runtime's flag reset; then Eye-A corrupted.
  const redeem = (by) => { for (const a of Object.values(by)) a.resetFlags(); };
  const go = (withReset) => run({
    bars: 40,
    onBar: (b, by) => {
      if (b === 8) by.poetA.setRogue(true);
      if (b === 18) { by.poetA.setRogue(false); if (withReset) redeem(by); }
      if (b === 20) by.eyeA.setRogue(true);
    },
  });
  const covering = (row) => Object.fromEntries(Object.entries(row).filter(([, v]) => !v.status.rogue && v.status.covering).map(([k, v]) => [k, v.status.covering]));
  // Without the reset: reproduces the screenshot (Eye-B still covers the melodist = Poet-A's mountains).
  const stale = go(false);
  assert.equal(covering(stale[39]).eyeB, 'melodist', 'expected to reproduce the stale cover');
  // With the reset (what rt.setRogue(id, false) now does): only Poet-A covers Eye-A's job.
  const fixed = go(true);
  assert.deepEqual(covering(fixed[39]), { poetA: 'architect' });
  for (const id of ['poetA', 'eyeB', 'poetB']) assert.deepEqual(fixed[39][id].status.flagged, ['eyeA'], id);
});

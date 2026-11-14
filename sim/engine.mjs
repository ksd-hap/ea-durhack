// Simulator engine: the live agent core with no channels, no clock, no audio. [Role 2]
// Steps bars in a loop; each message is delivered to each other agent with probability 1 - p,
// using a seeded generator per receiver (same as transport.js).
//
// Protocol per run (mirrors the demo):
//   bars [0, EVENT_BAR)  "Halls": loss 0, rogue off (baseline followers hear the leader)
//   bars [EVENT_BAR, ..) "Void"/attack: loss = p; rogue (if on) is corrupted at EVENT_BAR
// Metrics are measured over bars >= EVENT_BAR only, by web/metrics.js: the SAME code that
// computes the Stage's live metrics panel, fed the same telemetry the Stage receives.

import { createAgent, AGENT_IDS } from '../web/core/agent.js';
import { mulberry32, seedFor } from '../web/core/rng.js';
import { BARS_PER_SCENE } from '../web/core/time.js';
import { createMetrics } from '../web/metrics.js';

export const ROGUE_ID = 'poetB';
export const EVENT_BAR = 16;
export const LOOKAHEAD_BARS = 3; // must match web/world.worker.js

/**
 * @param {object} o
 * @param {object} o.data      parsed agents.json
 * @param {object[]} o.scenes  scenes with .views and .truth (the simulator, unlike agents, may read truth)
 * @param {'ea'|'independent'|'baseline'|'random'} o.method   ea = belief sharing; independent = none
 * @param {number} o.loss      0..1
 * @param {boolean} o.rogue
 * @param {number} o.seed
 * @param {number} [o.measureFrom]  first bar measured (default: the event bar)
 * @param {Function} [o.compose]  override compose() (default: web/core/compose.js)
 */
export function runOne({ data, scenes, method, loss, rogue, seed, eventBar = EVENT_BAR, measureFrom = eventBar, compose }) {
  const agents = AGENT_IDS.map((id) =>
    createAgent({ id, params: data.agents[id], anchors: data.anchors, thresholds: data.thresholds, fusion: data.fusion ?? null, seed, ...(compose ? { compose } : {}) }),
  );
  for (const a of agents) {
    if (method === 'baseline') a.setBaseline(true);
    if (method === 'random') a.setRandomRotation(true);
    if (method === 'independent') a.setSharing(false);
  }
  const netRng = Object.fromEntries(AGENT_IDS.map((id) => [id, mulberry32(seedFor(`simnet:${id}`, seed))]));

  const metrics = createMetrics();
  let delivered = 0;
  let pending = [];

  for (let s = 0; s < scenes.length; s++) {
    const scene = scenes[s];
    const start = s * BARS_PER_SCENE;
    // Views arrive LOOKAHEAD_BARS early, as from world.worker.js, so beliefs can cross the net.
    if (s === 0) for (const a of agents) a.onView(0, scene.views[a.id]);

    for (let bar = start; bar < start + BARS_PER_SCENE; bar++) {
      const p = bar >= eventBar ? loss : 0;
      const next = scenes[s + 1];
      if (next && bar === start + BARS_PER_SCENE - LOOKAHEAD_BARS) {
        for (const a of agents) a.onView(start + BARS_PER_SCENE, next.views[a.id]);
      }
      if (rogue && bar === eventBar) agents.find((a) => a.id === ROGUE_ID).setRogue(true);

      // Deliver last bar's outboxes.
      for (const { from, msg } of pending) {
        for (const a of agents) {
          if (a.id === from) continue;
          if (netRng[a.id]() < p) continue;
          a.onPeer(msg);
          delivered++;
        }
      }
      pending = [];

      const plans = {};
      for (const a of agents) {
        plans[a.id] = a.planBar(bar);
        for (const msg of plans[a.id].outbox) pending.push({ from: a.id, msg });
      }
      // Replay exactly the telemetry the Stage would receive into the shared metrics module.
      if (bar === start) metrics.ingest({ type: 'scene', index: s, bar: start, id: scene.id, truth: scene.truth });
      for (const a of agents) {
        for (const n of plans[a.id].notes) metrics.ingest({ type: 'note', ...n });
        for (const t of plans[a.id].telemetry) metrics.ingest(t);
      }
    }
  }
  metrics.flush();

  return {
    method,
    loss,
    rogue: rogue ? 1 : 0,
    seed,
    ...metrics.summary({ fromBar: measureFrom }),
    delivered,
  };
}

export const GRID = {
  methods: ['ea', 'independent', 'baseline', 'random'],
  losses: [0, 0.25, 0.5, 0.75, 1],
  rogue: [false, true],
  seeds: 10,
};

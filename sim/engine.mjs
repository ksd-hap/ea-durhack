// Simulator engine: the live agent core with no channels, no clock, no audio. [Role 2]
// Steps bars in a loop; each message is delivered to each other agent with probability 1 - p,
// using a seeded generator per receiver (same as transport.js).
//
// Protocol per run (mirrors the demo):
//   bars [0, EVENT_BAR)  "Halls": loss 0, rogue off (baseline followers hear the leader)
//   bars [EVENT_BAR, ..) "Void"/attack: loss = p; rogue (if on) is corrupted at EVENT_BAR
// Metrics are measured over bars >= EVENT_BAR only.

import { createAgent, AGENT_IDS } from '../web/core/agent.js';
import { mulberry32, seedFor } from '../web/core/rng.js';
import { BARS_PER_SCENE } from '../web/core/time.js';
import { SCALES, relPc, absPc } from '../web/core/theory.js';

export const ROGUE_ID = 'poetB';
export const EVENT_BAR = 16;

/**
 * @param {object} o
 * @param {object} o.data      parsed agents.json
 * @param {object[]} o.scenes  scenes with .views and .truth (the simulator, unlike agents, may read truth)
 * @param {'ea'|'baseline'|'random'} o.method
 * @param {number} o.loss      0..1
 * @param {boolean} o.rogue
 * @param {number} o.seed
 * @param {Function} [o.compose]  override compose() (default: web/core/compose.js)
 */
export function runOne({ data, scenes, method, loss, rogue, seed, eventBar = EVENT_BAR, compose }) {
  const agents = AGENT_IDS.map((id) =>
    createAgent({ id, params: data.agents[id], anchors: data.anchors, thresholds: data.thresholds, seed, ...(compose ? { compose } : {}) }),
  );
  for (const a of agents) {
    if (method === 'baseline') a.setBaseline(true);
    if (method === 'random') a.setRandomRotation(true);
  }
  const netRng = Object.fromEntries(AGENT_IDS.map((id) => [id, mulberry32(seedFor(`simnet:${id}`, seed))]));

  const m = {
    bars: 0,
    agentBars: 0,
    correct: 0,
    modeCorrect: 0,
    agreePairs: 0,
    pairs: 0,
    notes: 0,
    consonant: 0,
    ghosts: 0,
    ghostHits: 0,
    detectFirst: null,
    detectAll: null,
    falsePositives: 0,
    delivered: 0,
  };
  const fpSeen = new Set();
  let pending = [];

  for (let s = 0; s < scenes.length; s++) {
    const scene = scenes[s];
    const start = s * BARS_PER_SCENE;
    for (const a of agents) a.onView(start, scene.views[a.id]);

    for (let bar = start; bar < start + BARS_PER_SCENE; bar++) {
      const p = bar >= eventBar ? loss : 0;
      if (rogue && bar === eventBar) agents.find((a) => a.id === ROGUE_ID).setRogue(true);

      // Deliver last bar's outboxes.
      for (const { from, msg } of pending) {
        for (const a of agents) {
          if (a.id === from) continue;
          if (netRng[a.id]() < p) continue;
          a.onPeer(msg);
          m.delivered++;
        }
      }
      pending = [];

      const plans = {};
      for (const a of agents) {
        plans[a.id] = a.planBar(bar);
        for (const msg of plans[a.id].outbox) pending.push({ from: a.id, msg });
      }
      if (bar < eventBar) continue;

      const honest = AGENT_IDS.filter((id) => !(rogue && id === ROGUE_ID));
      const ctxOf = (id) => plans[id].telemetry.find((t) => t.type === 'ctx');
      const truth = scene.truth;
      m.bars++;

      // Accuracy vs truth and agreement among honest agents.
      for (const id of honest) {
        const c = ctxOf(id);
        m.agentBars++;
        if (c.mode === truth.mode) m.modeCorrect++;
        if (c.mode === truth.mode && c.density === truth.density) m.correct++;
      }
      for (let i = 0; i < honest.length; i++) {
        for (let j = i + 1; j < honest.length; j++) {
          const a = ctxOf(honest[i]);
          const b = ctxOf(honest[j]);
          m.pairs++;
          if (a.mode === b.mode && a.density === b.density) m.agreePairs++;
        }
      }

      // Consonance: share of ALL sounding notes inside the honest majority's scale.
      const votes = {};
      for (const id of honest) votes[ctxOf(id).mode] = (votes[ctxOf(id).mode] ?? 0) + 1;
      const majority = Object.entries(votes).sort((x, y) => y[1] - x[1])[0][0];
      for (const id of AGENT_IDS) {
        for (const n of plans[id].notes) {
          m.notes++;
          if (SCALES[majority].includes(relPc(n.pitch))) m.consonant++;
        }
      }

      // Ghost (peer-model prediction) match: did the peer play that pitch class in that slot?
      for (const id of honest) {
        for (const g of plans[id].telemetry) {
          if (g.type !== 'ghost') continue;
          m.ghosts++;
          const slot = Math.floor(g.beat * 2);
          const hit = plans[g.about].notes.some(
            (n) => Math.floor(n.beat * 2) === slot && absPc(n.pitch) === absPc(g.pitch),
          );
          if (hit) m.ghostHits++;
        }
      }

      // Detection latency and false positives.
      const flaggedBy = {};
      for (const id of honest) {
        const st = plans[id].telemetry.find((t) => t.type === 'status');
        flaggedBy[id] = st.flagged;
        for (const f of st.flagged) {
          if (rogue && f === ROGUE_ID) continue;
          const key = `${id}>${f}`;
          if (!fpSeen.has(key)) {
            fpSeen.add(key);
            m.falsePositives++;
          }
        }
      }
      if (rogue) {
        const n = honest.filter((id) => flaggedBy[id].includes(ROGUE_ID)).length;
        if (n > 0 && m.detectFirst === null) m.detectFirst = bar - eventBar;
        if (n === honest.length && m.detectAll === null) m.detectAll = bar - eventBar;
      }
    }
  }

  const r = (a, b) => (b > 0 ? a / b : null);
  return {
    method,
    loss,
    rogue: rogue ? 1 : 0,
    seed,
    bars: m.bars,
    accuracy: r(m.correct, m.agentBars),
    mode_accuracy: r(m.modeCorrect, m.agentBars),
    agreement: r(m.agreePairs, m.pairs),
    consonance: r(m.consonant, m.notes),
    prediction_match: r(m.ghostHits, m.ghosts),
    ghosts: m.ghosts,
    detect_first_bars: m.detectFirst,
    detect_all_bars: m.detectAll,
    false_positive_flags: m.falsePositives,
    delivered: m.delivered,
  };
}

export const GRID = {
  methods: ['ea', 'baseline', 'random'],
  losses: [0, 0.25, 0.5, 0.75, 1],
  rogue: [false, true],
  seeds: 10,
};

// metrics.js — the ONE definition of every number the Stage shows and the simulator reports.
// [Role 1 owns correctness; Role 4's metrics panel and sim/engine.mjs both use this file.]
//
// Pure: no clock, no channels, no DOM. Feed it telemetry messages (and the time, for the
// 10-second message count); read a live snapshot or a summary over a bar range. Because
// the simulator computes its CSV with this same code, the panel cannot disagree with the
// slides. It reads the right answers (scene truth), so it is display-side only: agent code
// never imports it (tools/check_isolation.sh).
//
//   import { createMetrics } from './metrics.js';
//   const m = createMetrics();
//   rt.onTelemetry((msg) => m.ingest(msg, Date.now()));
//   const s = m.snapshot(Date.now());   // see snapshot() below for the shape
//
// Definitions (per bar b, over the HONEST agents H = agents whose status says rogue: false):
//   accuracy       share of h in H whose (mode, density) for b equals the truth of b's scene
//   mode_accuracy  same, mode only
//   agreement      share of pairs in H with identical (mode, density) for b
//   consonance     share of ALL notes sounding in b (Melkor's included) whose pitch class is in
//                  the scale of the honest majority's mode for b. On a tie there is no majority:
//                  each note scores the fraction of tied modes whose scale contains it
//   ghost match    share of ghosts (peer-model predictions by h in H for b) where the predicted
//                  peer played that pitch class in that eighth-note slot of b
//   Melkor status  per agent X: 'flagged' if any honest agent flags X, else 'suspected' if any
//                  honest agent suspects X, else 'none' (latest closed bar)
//   detection      bars from the first bar any agent is rogue until first / all honest agents
//                  flag it; false positives = distinct (honest flagger, honest flagged) pairs
// Rolling values are over the last `rollingBars` closed bars. A bar closes once telemetry for
// a later bar arrives (agents plan one bar ahead), or on flush().

import { SCALES, relPc, absPc } from './core/theory.js';

const MODE_ORDER = ['ionian', 'dorian', 'aeolian']; // tie-break for the majority mode

export function createMetrics({ rollingBars = 8, rxWindowMs = 10000, maxBars = Infinity } = {}) {
  const scenes = []; // {index, bar, id, truth, thumb, caption}, sorted by bar
  const pending = new Map(); // bar -> raw telemetry for that bar
  const closed = []; // compact per-bar stats, in bar order
  const rx = []; // {t, from, count}
  const lastRx = {}; // from -> latest rx message
  let maxSeenBar = -Infinity;
  let lastClosed = -Infinity;
  let rogueOnset = null;

  const raw = (bar) => {
    if (!pending.has(bar)) pending.set(bar, { ctx: {}, status: {}, notes: [], ghosts: [] });
    return pending.get(bar);
  };

  function truthAt(bar) {
    let s = null;
    for (const sc of scenes) if (sc.bar <= bar) s = sc;
    return s ? s.truth : null;
  }

  function closeBar(bar) {
    const r = pending.get(bar);
    pending.delete(bar);
    if (!r) return;
    const ids = Object.keys(r.ctx);
    const rogueIds = ids.filter((id) => r.status[id]?.rogue);
    if (rogueIds.length && rogueOnset === null) rogueOnset = bar;
    const honest = ids.filter((id) => !r.status[id]?.rogue);
    const truth = truthAt(bar);

    let correct = 0;
    let modeCorrect = 0;
    if (truth) {
      for (const id of honest) {
        const c = r.ctx[id];
        if (c.mode === truth.mode) modeCorrect++;
        if (c.mode === truth.mode && c.density === truth.density) correct++;
      }
    }
    let pairs = 0;
    let agreePairs = 0;
    let modeAgreePairs = 0;
    for (let i = 0; i < honest.length; i++) {
      for (let j = i + 1; j < honest.length; j++) {
        const a = r.ctx[honest[i]];
        const b = r.ctx[honest[j]];
        pairs++;
        if (a.mode === b.mode) modeAgreePairs++;
        if (a.mode === b.mode && a.density === b.density) agreePairs++;
      }
    }
    // Majority mode among honest agents. On a tie there is no majority, so no mode is
    // privileged: each note scores the FRACTION of tied top modes whose scale contains it.
    const votes = {};
    for (const id of honest) votes[r.ctx[id].mode] = (votes[r.ctx[id].mode] ?? 0) + 1;
    const top = Math.max(0, ...Object.values(votes));
    const majority = MODE_ORDER.filter((m) => votes[m] === top && top > 0);
    let consonant = 0;
    if (majority.length) {
      for (const n of r.notes) consonant += majority.filter((m) => SCALES[m].includes(relPc(n.pitch))).length / majority.length;
    }

    let ghosts = 0;
    let ghostHits = 0;
    for (const g of r.ghosts) {
      if (!honest.includes(g.from)) continue;
      ghosts++;
      const slot = Math.floor(g.beat * 2);
      if (r.notes.some((n) => n.from === g.about && Math.floor(n.beat * 2) === slot && absPc(n.pitch) === absPc(g.pitch))) ghostHits++;
    }

    closed.push({
      bar, truth, honest, rogueIds,
      ctx: Object.fromEntries(ids.map((id) => [id, { mode: r.ctx[id].mode, density: r.ctx[id].density }])),
      hasTruth: !!truth, correct, modeCorrect, pairs, agreePairs, modeAgreePairs,
      notes: r.notes.length, consonant, consonanceNotes: majority.length ? r.notes.length : 0,
      ghosts, ghostHits,
      flaggedBy: Object.fromEntries(honest.map((id) => [id, r.status[id]?.flagged ?? []])),
      suspectedBy: Object.fromEntries(honest.map((id) => [id, r.status[id]?.suspected ?? []])),
    });
    if (closed.length > maxBars) closed.splice(0, closed.length - maxBars);
    lastClosed = bar;
  }

  function advanceTo(bar) {
    if (bar <= maxSeenBar) return;
    maxSeenBar = bar;
    for (const b of [...pending.keys()].sort((x, y) => x - y)) if (b < bar) closeBar(b);
  }

  function ingest(msg, nowMs = 0) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'scene': {
        if (!scenes.some((s) => s.index === msg.index && s.bar === msg.bar)) {
          scenes.push({ index: msg.index, bar: msg.bar, id: msg.id, truth: msg.truth, thumb: msg.thumb ?? null, caption: msg.caption ?? '' });
          scenes.sort((a, b) => a.bar - b.bar);
        }
        return;
      }
      case 'rx':
        rx.push({ t: nowMs, from: msg.from, count: msg.count ?? 0 });
        lastRx[msg.from] = msg;
        while (rx.length && rx[0].t < nowMs - rxWindowMs) rx.shift();
        return;
      case 'ctx':
        if (msg.bar <= lastClosed) return;
        advanceTo(msg.bar);
        raw(msg.bar).ctx[msg.from] = { mode: msg.mode, density: msg.density };
        return;
      case 'status':
        if (msg.bar <= lastClosed) return;
        raw(msg.bar).status[msg.from] = { rogue: !!msg.rogue, flagged: msg.flagged ?? [], suspected: msg.suspected ?? [] };
        return;
      case 'note':
        if (msg.bar <= lastClosed) return;
        raw(msg.bar).notes.push({ from: msg.from, beat: msg.beat, pitch: msg.pitch });
        return;
      case 'ghost':
        if (msg.bar <= lastClosed) return;
        raw(msg.bar).ghosts.push({ from: msg.from, about: msg.about, beat: msg.beat, pitch: msg.pitch });
        return;
      default:
    }
  }

  function aggregate(bars) {
    const sum = (k) => bars.reduce((s, b) => s + b[k], 0);
    const withTruth = bars.filter((b) => b.hasTruth);
    const agentBars = withTruth.reduce((s, b) => s + b.honest.length, 0);
    const r = (a, b) => (b > 0 ? a / b : null);
    return {
      bars: bars.length,
      accuracy: r(withTruth.reduce((s, b) => s + b.correct, 0), agentBars),
      mode_accuracy: r(withTruth.reduce((s, b) => s + b.modeCorrect, 0), agentBars),
      agreement: r(sum('agreePairs'), sum('pairs')),
      mode_agreement: r(sum('modeAgreePairs'), sum('pairs')),
      consonance: r(sum('consonant'), sum('consonanceNotes')),
      prediction_match: r(sum('ghostHits'), sum('ghosts')),
      ghosts: sum('ghosts'),
    };
  }

  function melkorStatus(b) {
    const out = {};
    if (!b) return out;
    for (const id of Object.keys(b.ctx)) {
      const flagged = b.honest.some((h) => h !== id && b.flaggedBy[h].includes(id));
      const suspected = b.honest.some((h) => h !== id && b.suspectedBy[h].includes(id));
      out[id] = flagged ? 'flagged' : suspected ? 'suspected' : 'none';
    }
    return out;
  }

  return {
    ingest,
    /** Close every pending bar (end of a simulation run). */
    flush() {
      for (const b of [...pending.keys()].sort((x, y) => x - y)) closeBar(b);
    },
    /** Compact per-bar records (for charts and tests). */
    bars: () => closed,

    /** Everything the metrics panel shows, from telemetry only. */
    snapshot(nowMs = 0) {
      while (rx.length && rx[0].t < nowMs - rxWindowMs) rx.shift();
      const last = closed[closed.length - 1] ?? null;
      const losses = Object.values(lastRx).map((m) => m.loss ?? 0);
      const scene = last ? [...scenes].reverse().find((s) => s.bar <= last.bar) ?? null : scenes[0] ?? null;
      const status = melkorStatus(last);
      return {
        phase: losses.length && losses.every((p) => p >= 1) ? 'Void' : 'Halls',
        rxLast10s: rx.reduce((s, m) => s + m.count, 0),
        bar: last?.bar ?? null,
        scene,
        agents: last
          ? Object.fromEntries(Object.entries(last.ctx).map(([id, c]) => [id, {
              ...c,
              correct: last.truth ? c.mode === last.truth.mode && c.density === last.truth.density : null,
              rogue: last.rogueIds.includes(id),
              melkor: status[id],
            }]))
          : {},
        rolling: aggregate(closed.slice(-rollingBars)),
      };
    },

    /** Run-level metrics over closed bars in [fromBar, toBar] (the simulator's CSV row). */
    summary({ fromBar = -Infinity, toBar = Infinity } = {}) {
      const bars = closed.filter((b) => b.bar >= fromBar && b.bar <= toBar);
      const out = aggregate(bars);
      const fp = new Set();
      let detectFirst = null;
      let detectAll = null;
      for (const b of bars) {
        for (const h of b.honest) for (const f of b.flaggedBy[h]) if (!b.rogueIds.includes(f)) fp.add(`${h}>${f}`);
        if (rogueOnset === null || b.bar < rogueOnset || !b.rogueIds.length) continue;
        const flaggers = b.honest.filter((h) => b.rogueIds.some((rid) => b.flaggedBy[h].includes(rid))).length;
        if (flaggers > 0 && detectFirst === null) detectFirst = b.bar - rogueOnset;
        if (flaggers === b.honest.length && detectAll === null) detectAll = b.bar - rogueOnset;
      }
      return { ...out, detect_first_bars: detectFirst, detect_all_bars: detectAll, false_positive_flags: fp.size };
    },
  };
}

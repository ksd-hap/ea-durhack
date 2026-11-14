// agent.js — pure agent logic. [Role 2]
// No timers, no channels, no audio, no clock, no Math.random. The same module runs in
// agent.worker.js (live) and sim/engine.mjs (offline), so the resilience chart is produced
// by exactly the code that plays on stage.
//
// Interface (shared contract):
//   createAgent({ id, role, params, anchors, thresholds, seed })
//     .onView(bar, vec)          its own senses: raw embedding of its own view of the scene starting at `bar`
//     .onPeer(msg)               a network message that the lossy transport delivered
//     .planBar(bar, {t0}?)       -> { notes: NoteEvent[], outbox: msg[], telemetry: msg[] }
//     .setRogue(on)              experimenter switch: become Melkor
//     .setBaseline(on)           experimenter switch: conductor-baseline mode (comparison only)
//   Extensions (see CONTRACTS.md):
//     .setRandomRotation(on)     rehearsal-only control: use R_random instead of R
//     .resetFlags()              experimenter pressed Restore: clear sticky rogue flags
//     .inspect()                 read-only snapshot for tests and the simulator

import { mulberry32, seedFor } from './rng.js';
import { noteAtMs } from './time.js';
import { absPc, isOutsideUnion } from './theory.js';
import {
  prepareParams,
  prepareAnchors,
  embed,
  moodScores,
  levelWithHysteresis,
  contextFromLevels,
} from './perception.js';
import { compose as defaultCompose } from './compose.js';

export const AGENT_IDS = ['eyeA', 'poetA', 'eyeB', 'poetB'];
export const ROLE_OF = { eyeA: 'architect', poetA: 'melodist', eyeB: 'weaver', poetB: 'pulse' };
export const BASELINE_LEADER = 'eyeA';

export const DETECT = {
  alpha: 0.2, // EMA weight per delivered note
  level: 0.3, // EMA above this ...
  bars: 2, // ... for this many consecutive bars => suspect
  silenceBars: 2, // nothing heard for this long => "silent"
  suspicionTtlBars: 4, // a peer's suspect message counts for this long
  roguePcWindowBars: 3, // absorb uses rogue pitch classes from the last N bars
};
export const PEER_MODEL_MIN_COUNT = 3;
const SLOTS = 8; // eighth-note slots per bar
const DEFAULT_CTX = Object.freeze({ mode: 'dorian', density: 2 });

export function createAgent({
  id,
  role = ROLE_OF[id],
  params,
  anchors,
  thresholds,
  seed = 0,
  compose = defaultCompose,
  peers = AGENT_IDS.filter((p) => p !== id),
}) {
  if (!AGENT_IDS.includes(id)) throw new Error(`createAgent: unknown id ${id}`);
  const prep = prepareParams(params);
  const anc = prepareAnchors(anchors);
  const th = {
    valence: thresholds.valence,
    arousal: thresholds.arousal,
    h: thresholds.hysteresis ?? 0.1,
  };
  const rng = mulberry32(seedFor(id, seed));
  let musicState = {}; // compose()'s private state; it returns the updated copy each bar

  // Experimenter switches.
  let rogue = false;
  let baseline = false;
  let useRandomRotation = false;

  // Perception: contexts keyed by the bar they take effect, in arrival order.
  const contexts = []; // [{ bar, ctx, valence, arousal, vLevel, aLevel }]
  let lastLevels = { v: null, a: null };

  // Agent's own notion of time: the bar currently sounding (= last planned bar - 1).
  let nowBar = -Infinity;
  let lastPlanned = null;

  // Network bookkeeping.
  const lastRxBar = {}; // peer -> nowBar when we last heard anything from it
  let rxSincePlan = 0;
  let barsSilent = 0;
  const received = new Map(); // note bar -> NoteEvent[] from peers
  let leaderCtx = null; // conductor baseline: last context heard from the leader

  // Peer models: counts[peer][myMode][slot][absPc]; pitchSum for octave placement.
  const counts = {};
  const pitchStats = {};

  // Rogue detection.
  const ema = {};
  const aboveBars = {};
  const suspected = {};
  const flagged = {};
  const peerSuspicion = {}; // target -> { from -> { suspect, score, bar } }
  const roguePcs = {}; // peer -> [{ bar, pc }] recent unexplained outside notes (feeds absorb)
  const rogueSeen = {}; // peer -> Set(absolute pc) every unexplained outside pc since reset
  for (const p of peers) {
    ema[p] = 0;
    aboveBars[p] = 0;
    suspected[p] = false;
    flagged[p] = false;
    peerSuspicion[p] = {};
    roguePcs[p] = [];
    rogueSeen[p] = new Set();
  }

  // An outside pitch class (Eb / G#) from `from` is EXPLAINED, and so is not evidence
  // against it, only when I already suspect or have flagged some OTHER peer that has been
  // playing that same pc. Then `from` is plausibly answering that rogue with an absorb
  // chord (Eb major contains Eb; E7 contains G#). Melkor can't exploit this: before anyone
  // is suspected nothing is excused, and the suspect's own notes never are. No sender-side
  // "I'm absorbing" tag exists for a rogue to fake: the excuse is the receiver's own evidence.
  //
  // Under heavy loss I may have missed the rogue's notes yet still hear that a peer
  // suspects it. So a recent suspicion of some q != from, REPORTED BY some r != from,
  // also explains it. (r != from: a rogue's own accusations never excuse the rogue.)
  function explainedByAbsorb(from, pc) {
    return peers.some((q) => {
      if (q === from) return false;
      if ((suspected[q] || flagged[q]) && rogueSeen[q].has(pc)) return true;
      return Object.entries(peerSuspicion[q]).some(
        ([r, s]) => r !== from && s.suspect && nowBar - s.bar <= DETECT.suspicionTtlBars,
      );
    });
  }

  function ownCtxAt(bar) {
    let best = null;
    for (const c of contexts) if (c.bar <= bar && (!best || c.bar >= best.bar)) best = c;
    return best ? best.ctx : DEFAULT_CTX;
  }

  function onView(bar, vec) {
    const z = embed(prep, vec, useRandomRotation);
    const s = moodScores(prep, anc, z);
    const vLevel = levelWithHysteresis(s.valence, th.valence, th.h, lastLevels.v);
    const aLevel = levelWithHysteresis(s.arousal, th.arousal, th.h, lastLevels.a);
    lastLevels = { v: vLevel, a: aLevel };
    const entry = { bar, ctx: contextFromLevels(vLevel, aLevel), valence: s.valence, arousal: s.arousal };
    const i = contexts.findIndex((c) => c.bar === bar);
    if (i >= 0) contexts[i] = entry;
    else contexts.push(entry);
    if (contexts.length > 16) contexts.splice(0, contexts.length - 16);
    return entry.ctx;
  }

  function updatePeerModel(from, note) {
    if (flagged[from]) return;
    const myMode = ownCtxAt(note.bar).mode; // conditioned on MY context: I can't know the peer's
    const slot = Math.min(SLOTS - 1, Math.max(0, Math.floor(note.beat * 2)));
    const byMode = (counts[from] ??= {});
    const grid = (byMode[myMode] ??= Array.from({ length: SLOTS }, () => new Uint16Array(12)));
    grid[slot][absPc(note.pitch)]++;
    const ps = (pitchStats[from] ??= { sum: 0, n: 0 });
    ps.sum += note.pitch;
    ps.n++;
  }

  function onPeer(msg) {
    if (!msg || msg.from === id || !peers.includes(msg.from)) return;
    const from = msg.from;
    lastRxBar[from] = nowBar;
    rxSincePlan++;
    switch (msg.type) {
      case 'note': {
        if (!Number.isFinite(msg.pitch) || !Number.isFinite(msg.beat)) return;
        const list = received.get(msg.bar) ?? [];
        list.push(msg);
        received.set(msg.bar, list);
        const pc = absPc(msg.pitch);
        const evidence = isOutsideUnion(msg.pitch) && !explainedByAbsorb(from, pc);
        ema[from] = (1 - DETECT.alpha) * ema[from] + DETECT.alpha * (evidence ? 1 : 0);
        if (evidence) {
          roguePcs[from].push({ bar: msg.bar, pc });
          rogueSeen[from].add(pc);
        }
        updatePeerModel(from, msg);
        break;
      }
      case 'suspect': {
        if (!peers.includes(msg.target) && msg.target !== id) return;
        if (msg.target === id) return; // accusations against me don't change my own behaviour
        peerSuspicion[msg.target][from] = { suspect: !!msg.suspect, score: msg.score, bar: msg.bar };
        break;
      }
      case 'lead': {
        if (from === BASELINE_LEADER) leaderCtx = { mode: msg.mode, density: msg.density, bar: msg.bar };
        break;
      }
      default:
        break;
    }
  }

  // Close out the bar that just finished sounding: update suspicion streaks and silence.
  function closeBar() {
    for (const p of peers) {
      aboveBars[p] = ema[p] > DETECT.level ? aboveBars[p] + 1 : 0;
      suspected[p] = aboveBars[p] >= DETECT.bars;
    }
    barsSilent = rxSincePlan > 0 ? 0 : barsSilent + 1;
    rxSincePlan = 0;
  }

  function heardFromRecently(q) {
    return lastRxBar[q] !== undefined && nowBar - lastRxBar[q] <= DETECT.silenceBars;
  }

  function verdicts() {
    for (const p of peers) {
      if (flagged[p] || !suspected[p]) continue;
      const others = peers.filter((q) => q !== p);
      const corroborated = others.some((q) => {
        const s = peerSuspicion[p][q];
        return s && s.suspect && nowBar - s.bar <= DETECT.suspicionTtlBars;
      });
      const isolated = others.every((q) => !heardFromRecently(q));
      if (corroborated || isolated) {
        flagged[p] = true; // sticky until resetFlags()
        delete counts[p]; // drop the rogue from peer models
      }
    }
  }

  function predictionsFor(bar, myMode) {
    const preds = [];
    for (const p of peers) {
      if (flagged[p]) continue;
      const grid = counts[p]?.[myMode];
      if (!grid) continue;
      const ps = pitchStats[p];
      const centre = ps && ps.n ? ps.sum / ps.n : 66;
      for (let slot = 0; slot < SLOTS; slot++) {
        const row = grid[slot];
        let bestPc = -1;
        let best = 0;
        for (let pc = 0; pc < 12; pc++) {
          if (row[pc] > best) {
            best = row[pc];
            bestPc = pc;
          }
        }
        if (best >= PEER_MODEL_MIN_COUNT) {
          // Place the pitch class in the octave nearest the peer's usual register.
          const pitch = bestPc + 12 * Math.round((centre - bestPc) / 12);
          preds.push({ peer: p, role: ROLE_OF[p], bar, slot, beat: slot / 2, pc: bestPc, pitch, count: best });
        }
      }
    }
    return preds;
  }

  function planBar(bar, { t0 = null } = {}) {
    if (lastPlanned !== null) closeBar();
    nowBar = bar - 1;
    lastPlanned = bar;
    verdicts();

    const own = ownCtxAt(bar);
    const followLeader = baseline && id !== BASELINE_LEADER && leaderCtx;
    const ctx = followLeader ? { mode: leaderCtx.mode, density: leaderCtx.density } : own;

    const flaggedPeers = peers.filter((p) => flagged[p]);
    let absorb = null;
    let defend = false;
    let response = 'normal';
    if (flaggedPeers.length > 0) {
      if (barsSilent >= DETECT.silenceBars) {
        defend = true;
        response = 'defend';
      } else {
        const pcs = new Set();
        for (const p of flaggedPeers) {
          for (const r of roguePcs[p]) if (r.bar >= bar - DETECT.roguePcWindowBars) pcs.add(r.pc);
        }
        if (pcs.size > 0) {
          absorb = { pcs: [...pcs].sort((a, b) => a - b) };
          response = 'absorb';
        }
      }
    }
    for (const p of peers) {
      roguePcs[p] = roguePcs[p].filter((r) => r.bar >= bar - DETECT.roguePcWindowBars);
    }

    const predictions = predictionsFor(bar, ctx.mode);
    const lastBarNotes = received.get(bar - 1) ?? [];
    for (const k of received.keys()) if (k < bar - 4) received.delete(k);

    const result = compose({
      id,
      role,
      bar,
      ctx,
      rng,
      state: musicState,
      predictions,
      lastBarNotes,
      absorb,
      defend,
      rogue,
    });

    const notes = [];
    // Contract: compose returns { notes, state }. A bare array is accepted as notes-only.
    const raw = Array.isArray(result) ? result : (result?.notes ?? []);
    if (!Array.isArray(result) && result && result.state !== undefined) musicState = result.state;
    for (const n of raw) {
      if (!Number.isFinite(n.pitch) || !Number.isFinite(n.beat) || !(n.dur > 0)) continue;
      notes.push({
        from: id,
        at: t0 === null ? null : noteAtMs(t0, bar, n.beat),
        bar,
        beat: n.beat,
        pitch: n.pitch,
        vel: n.vel ?? 0.6,
        dur: n.dur,
        role,
        rogue,
      });
    }

    const outbox = notes.map((n) => ({ type: 'note', ...n }));
    for (const p of peers) {
      outbox.push({ type: 'suspect', from: id, target: p, score: ema[p], suspect: suspected[p], bar });
    }
    if (rogue) {
      // Melkor also lies: a false accusation against an honest agent. It must fail,
      // because no honest agent's own evidence supports it.
      const victim = peers[Math.floor(rng() * peers.length)];
      outbox.push({ type: 'suspect', from: id, target: victim, score: 0.9, suspect: true, bar });
    }
    if (baseline && id === BASELINE_LEADER) {
      outbox.push({ type: 'lead', from: id, bar, mode: own.mode, density: own.density });
    }

    const telemetry = [
      { type: 'ctx', from: id, bar, mode: ctx.mode, density: ctx.density, own: { ...own }, followingLeader: !!followLeader },
      ...predictions.map((g) => ({ type: 'ghost', from: id, about: g.peer, bar, beat: g.beat, pitch: g.pitch })),
      {
        type: 'status',
        from: id,
        bar,
        rogue,
        baseline,
        randomRotation: useRandomRotation,
        response,
        suspected: peers.filter((p) => suspected[p]),
        flagged: flaggedPeers,
        barsSilent,
      },
    ];

    return { notes, outbox, telemetry };
  }

  return {
    id,
    role,
    onView,
    onPeer,
    planBar,
    setRogue(on) {
      rogue = !!on;
    },
    setBaseline(on) {
      baseline = !!on;
      if (!baseline) leaderCtx = null;
    },
    setRandomRotation(on) {
      useRandomRotation = !!on;
    },
    resetFlags() {
      for (const p of peers) {
        ema[p] = 0;
        aboveBars[p] = 0;
        suspected[p] = false;
        flagged[p] = false;
        peerSuspicion[p] = {};
        roguePcs[p] = [];
        rogueSeen[p] = new Set();
      }
    },
    inspect() {
      return {
        id,
        role,
        rogue,
        baseline,
        useRandomRotation,
        ctx: ownCtxAt(lastPlanned ?? 0),
        ema: { ...ema },
        suspected: peers.filter((p) => suspected[p]),
        flagged: peers.filter((p) => flagged[p]),
        barsSilent,
      };
    },
  };
}

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
//     .setSharing(on)            belief sharing on (default, EÄ) / off (independent comparison)
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
  level,
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
  // OR: this many UNEXPLAINED Eb/G# notes within countWindowBars => suspect. Honest agents never
  // play an unexplained one, so a few is proof enough; this catches a SUBTLE saboteur that keeps
  // its rate of bad notes too low for the EMA (e.g. one bad note every 2 bars).
  count: 4,
  countWindowBars: 8,
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
  fusion = null, // agents.json .fusion: per-subset rescaling for belief sharing
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
  let sharing = true; // belief sharing (EÄ); off = fully independent agents (comparison)

  // Perception. views: my own standardised scores per scene, keyed by the scene's start bar.
  // beliefs: the latest scores each peer broadcast for each scene. decided: the context I
  // actually played each bar (my reading fused with the beliefs I had heard by then).
  const views = []; // [{ bar, v, a }]
  const beliefs = {}; // peer -> { sceneBar -> { v, a } }
  const decided = new Map(); // bar -> { mode, density }
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
  const evidenceBars = {}; // peer -> [bar of each unexplained outside note] (count rule)
  for (const p of peers) {
    ema[p] = 0;
    aboveBars[p] = 0;
    suspected[p] = false;
    flagged[p] = false;
    peerSuspicion[p] = {};
    roguePcs[p] = [];
    rogueSeen[p] = new Set();
    evidenceBars[p] = [];
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

  function viewAt(bar) {
    let best = null;
    for (const w of views) if (w.bar <= bar && (!best || w.bar >= best.bar)) best = w;
    return best;
  }

  function quantise(v, a) {
    return contextFromLevels(level(v, th.valence), level(a, th.arousal));
  }

  /** The context I played (or will play) at `bar`; before planning it, my own reading. */
  function ownCtxAt(bar) {
    if (decided.has(bar)) return decided.get(bar);
    const w = viewAt(bar);
    return w ? quantise(w.v, w.a) : DEFAULT_CTX;
  }

  function onView(bar, vec) {
    const z = embed(prep, vec, useRandomRotation);
    const s = moodScores(prep, anc, z, useRandomRotation);
    const entry = { bar, v: s.valence, a: s.arousal };
    const i = views.findIndex((w) => w.bar === bar);
    if (i >= 0) views[i] = entry;
    else views.push(entry);
    if (views.length > 8) views.splice(0, views.length - 8);
    return quantise(entry.v, entry.a);
  }

  // Belief sharing: fuse my standardised scores for this scene with the latest scores each
  // un-flagged peer broadcast for the SAME scene (clipped, so a wild value can't dominate),
  // then rescale by the calibration std of that subset's mean (averaging shrinks the spread).
  const CLIP = 4;
  const clip = (x) => Math.max(-CLIP, Math.min(CLIP, x));
  function fuse(w) {
    const used = [id];
    let v = w.v;
    let a = w.a;
    if (sharing && !baseline) {
      for (const p of peers) {
        const b = beliefs[p]?.[w.bar];
        if (!b || flagged[p] || suspected[p]) continue; // stop trusting a peer as soon as I suspect it
        used.push(p);
        v += clip(b.v);
        a += clip(b.a);
      }
    }
    v /= used.length;
    a /= used.length;
    const key = AGENT_IDS.filter((x) => used.includes(x)).join('+');
    const scale = fusion?.[useRandomRotation ? 'random' : 'fitted']?.[key];
    if (scale) {
      v /= scale[0];
      a /= scale[1];
    }
    return { v, a, used: used.filter((x) => x !== id) };
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
          evidenceBars[from].push(msg.bar);
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
      case 'belief': {
        if (!Number.isFinite(msg.v) || !Number.isFinite(msg.a) || !Number.isFinite(msg.bar)) return;
        const byScene = (beliefs[from] ??= {});
        byScene[msg.bar] = { v: msg.v, a: msg.a };
        for (const k of Object.keys(byScene)) if (+k < msg.bar - 32) delete byScene[k];
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
      evidenceBars[p] = evidenceBars[p].filter((b) => b > lastPlanned - DETECT.countWindowBars);
      suspected[p] = aboveBars[p] >= DETECT.bars || evidenceBars[p].length >= DETECT.count;
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

    // My mood for this bar: my own reading fused with the beliefs I've heard (hysteresis
    // carries across bars, so late-arriving beliefs can't make the context flicker).
    const w = viewAt(bar);
    let own = DEFAULT_CTX;
    let fusedCtx = DEFAULT_CTX;
    let sharedWith = [];
    if (w) {
      own = quantise(w.v, w.a);
      const fz = fuse(w);
      const vL = levelWithHysteresis(fz.v, th.valence, th.h, lastLevels.v);
      const aL = levelWithHysteresis(fz.a, th.arousal, th.h, lastLevels.a);
      lastLevels = { v: vL, a: aL };
      fusedCtx = contextFromLevels(vL, aL);
      sharedWith = fz.used;
    }
    const followLeader = baseline && id !== BASELINE_LEADER && leaderCtx;
    const ctx = followLeader ? { mode: leaderCtx.mode, density: leaderCtx.density } : fusedCtx;
    decided.set(bar, ctx);
    for (const k of decided.keys()) if (k < bar - 16) decided.delete(k);

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

    // "Try to fix it": when a peer is flagged, exactly one honest agent covers that peer's job.
    // Every agent applies the same rule on its own (no coordinator): the coverer is the first
    // agent AFTER the flagged one in the fixed order that I consider honest; if that's me, I
    // cover. (Under disagreement two agents may both cover for a while; that's harmless.)
    let cover = null;
    if (!rogue) {
      for (const x of flaggedPeers) {
        const i = AGENT_IDS.indexOf(x);
        for (let k = 1; k < AGENT_IDS.length; k++) {
          const c = AGENT_IDS[(i + k) % AGENT_IDS.length];
          if (c === id || !flagged[c]) {
            if (c === id) cover = ROLE_OF[x];
            break;
          }
        }
        if (cover) break;
      }
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
      cover,
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
    // Broadcast my beliefs for the current and upcoming scenes every bar (repeats make them
    // robust to loss). Melkor lies: it broadcasts the opposite of what it perceives.
    if (sharing && !baseline) {
      for (const vw of views) {
        if (vw.bar + 8 <= bar) continue;
        outbox.push({ type: 'belief', from: id, bar: vw.bar, v: rogue ? -vw.v : vw.v, a: rogue ? -vw.a : vw.a });
      }
    }
    if (baseline && id === BASELINE_LEADER) {
      outbox.push({ type: 'lead', from: id, bar, mode: fusedCtx.mode, density: fusedCtx.density });
    }

    const telemetry = [
      { type: 'ctx', from: id, bar, mode: ctx.mode, density: ctx.density, own: { ...own }, sharedWith, followingLeader: !!followLeader },
      ...predictions.map((g) => ({ type: 'ghost', from: id, about: g.peer, bar, beat: g.beat, pitch: g.pitch })),
      {
        type: 'status',
        from: id,
        bar,
        rogue,
        baseline,
        randomRotation: useRandomRotation,
        response,
        covering: cover,
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
    /** Comparison switch: false = fully independent agents (no belief sharing). */
    setSharing(on) {
      sharing = !!on;
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
        evidenceBars[p] = [];
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

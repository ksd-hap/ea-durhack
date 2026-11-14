// world.worker.js — the scene stream and the right answers. [Role 2]
//
// The world is the only agent-facing component that reads scenes.json. It sends each
// agent ONLY that agent's own view, on that agent's own sense channel (its "eyes"). The
// scene id, truth, caption and thumbnail go to telemetry only, for the Stage's metrics.
//
// Timing: at hub start, t0 (= now + 2000 ms, chosen by the hub) is bar 0. Scene i starts
// at bar 8i. Views are sent LOOKAHEAD_BARS before the scene starts, because agents plan
// one bar ahead: the view for bar 8i must be in hand when bar 8i is planned, which is
// at the start of bar 8i-1. Contexts are keyed by bar, so arriving early is harmless.

import { BARS_PER_SCENE, barAt } from './core/time.js';
import { createTelemetrySender } from './telemetry-out.js';

const AGENT_IDS = ['eyeA', 'poetA', 'eyeB', 'poetB'];
const LOOKAHEAD_BARS = 2;
const TICK_MS = 50;

let scenes = null;
let t0 = null;
let nextView = 0; // next scene index whose views are not yet sent
let nextAnnounce = 0; // next scene index not yet announced on telemetry

const senses = Object.fromEntries(AGENT_IDS.map((id) => [id, new BroadcastChannel(`ea-sense-${id}`)]));
const telemetry = createTelemetrySender();
const now = () => performance.timeOrigin + performance.now();

let hub = new BroadcastChannel('ea-hub');
hub.onmessage = (e) => {
  const h = e.data ?? {};
  if (h.type === 'start') {
    t0 = h.t0;
    nextView = 0;
    nextAnnounce = 0;
  } else if (h.type === 'end') {
    hub.close();
    hub = null;
  }
};

self.onmessage = async (e) => {
  const m = e.data ?? {};
  if (m.cmd !== 'init' || scenes) return;
  try {
    const res = await fetch(new URL(m.scenesUrl ?? './data/scenes.json', import.meta.url));
    if (!res.ok) throw new Error(`scenes.json: HTTP ${res.status}`);
    scenes = await res.json();
    if (!Array.isArray(scenes) || scenes.length === 0) throw new Error('scenes.json is empty');
    setInterval(tick, TICK_MS);
    self.postMessage({ type: 'ready', id: 'world', scenes: scenes.length });
  } catch (err) {
    console.error('[world]', err);
    self.postMessage({ type: 'error', id: 'world', message: String(err?.stack ?? err) });
  }
};

function sceneFor(i) {
  return scenes[i % scenes.length];
}

function tick() {
  if (t0 === null) return;
  const cur = barAt(t0, now());

  while (cur >= nextView * BARS_PER_SCENE - LOOKAHEAD_BARS) {
    const startBar = nextView * BARS_PER_SCENE;
    const s = sceneFor(nextView);
    for (const id of AGENT_IDS) {
      senses[id].postMessage({ type: 'view', bar: startBar, vec: s.views[id] });
    }
    nextView++;
  }

  while (cur >= nextAnnounce * BARS_PER_SCENE) {
    const startBar = nextAnnounce * BARS_PER_SCENE;
    const s = sceneFor(nextAnnounce);
    telemetry.send({
      type: 'scene',
      index: nextAnnounce,
      bar: startBar,
      id: s.id,
      truth: s.truth,
      thumb: s.thumb ?? null,
      caption: s.caption ?? '',
    });
    nextAnnounce++;
  }
}

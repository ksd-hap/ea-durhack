// world.worker.js — the scene stream and the right answers. [Role 2]
//
// The world is the only agent-facing component that reads scenes.json. It sends each
// agent ONLY that agent's own view, on that agent's own sense channel (its "eyes"). The
// scene id, truth, caption and thumbnail go to telemetry only, for the Stage's metrics.
//
// Timing: at hub start, t0 (= now + START_LEAD_MS = 5 s, chosen by the hub) is bar 0. Scene i starts
// at bar 8i. Views are sent LOOKAHEAD_BARS (3) before the scene starts: agents plan one bar
// ahead (bar 8i is planned at the start of 8i-1), and their beliefs about the new scene must
// cross the network before that (broadcast at the start of 8i-2). Views are keyed by bar, so
// arriving early is harmless.

import { BARS_PER_SCENE, barAt } from './core/time.js';
import { createTelemetrySender } from './telemetry-out.js';
import { CHANNEL, openChannel } from './channels.js';

const AGENT_IDS = ['eyeA', 'poetA', 'eyeB', 'poetB'];
const LOOKAHEAD_BARS = 3; // 1 bar planning lookahead + 1 bar for beliefs to cross the network + margin
const TICK_MS = 50;

let scenes = null;
let t0 = null;
let nextView = 0; // next scene index whose views are not yet sent
let nextAnnounce = 0; // next scene index not yet announced on telemetry
let lastRefreshBar = null; // last bar on which the current views were re-sent

const now = () => performance.timeOrigin + performance.now();
let senses = null;
let telemetry = null;
let hub = null;

function onHub(e) {
  const h = e.data ?? {};
  if (h.type === 'start') {
    // Repeated until acknowledged, so idempotent: only a new t0 restarts the stream.
    if (h.t0 !== t0) {
      t0 = h.t0;
      nextView = 0;
      nextAnnounce = 0;
      lastRefreshBar = null;
    }
    telemetry.send({ type: 'started', from: 'world', t0 });
  } else if (h.type === 'end') {
    hub.close();
    hub = null;
  }
}

// Main thread sends only {cmd:'init', session, scenesUrl?}. Channels open here, once the
// session (which run's channels to use) is known.
self.onmessage = async (e) => {
  const m = e.data ?? {};
  if (m.cmd !== 'init' || scenes) return;
  try {
    const res = await fetch(new URL(m.scenesUrl ?? './data/scenes.json', import.meta.url));
    if (!res.ok) throw new Error(`scenes.json: HTTP ${res.status}`);
    scenes = await res.json();
    if (!Array.isArray(scenes) || scenes.length === 0) throw new Error('scenes.json is empty');
    senses = Object.fromEntries(AGENT_IDS.map((id) => [id, openChannel(CHANNEL.sense(id), m.session)]));
    telemetry = createTelemetrySender(m.session);
    hub = openChannel(CHANNEL.hub, m.session);
    hub.onmessage = onHub;
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

  const sendViews = (i) => {
    const s = sceneFor(i);
    for (const id of AGENT_IDS) {
      senses[id].postMessage({ type: 'view', bar: i * BARS_PER_SCENE, vec: s.views[id] });
    }
  };

  let sentNew = false;
  while (cur >= nextView * BARS_PER_SCENE - LOOKAHEAD_BARS) {
    sendViews(nextView);
    nextView++;
    sentNew = true;
  }

  // Eyes keep seeing: once per bar, re-send the latest scene's views. A view for the same
  // bar gives the agent the same context, so this is harmless, and it means one lost
  // message (e.g. on a channel that was still being set up) can't leave an agent on the
  // default mood for a whole scene.
  if (!sentNew && nextView > 0 && cur !== lastRefreshBar) sendViews(nextView - 1);
  lastRefreshBar = cur;

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

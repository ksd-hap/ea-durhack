// runtime.js — main-thread mechanics for the hub (Ilúvatar) and the experimenter. [Role 2]
// Role 4's stage.js imports this; it holds the UI. Nothing here sends musical information to
// agents: only start time (rehearsal), the random-rotation control (rehearsal), loss, and
// fault-injection switches.
//
//   const rt = await createRuntime({ seed: 0 });
//   rt.onTelemetry(msg => ...);     // every ea-telemetry message (notes, ctx, ghost, status, rx, scene)
//   const t0 = rt.start();          // hub: bar 0 starts at t0 = now + START_LEAD_MS (5 s)
//   await rt.started;               // resolves once all 4 agents + world acknowledged start
//   rt.setRandomRotation(true);     // rehearsal only; returns false once the hub is closed
//   rt.endRehearsal();              // closes ea-hub for good
//   rt.setLoss(0.5); rt.cut(); rt.restore();
//   rt.setRogue('poetB', true); rt.setBaseline(true);

import { AGENT_IDS } from './core/agent.js';
import { START_LEAD_MS, BAR_MS } from './core/time.js';
import { CHANNEL, openChannel, newSession } from './channels.js';

const now = () => performance.timeOrigin + performance.now();

function spawn(url, initMsg, label) {
  const w = new Worker(url, { type: 'module' });
  const ready = new Promise((resolve, reject) => {
    w.addEventListener('message', (e) => {
      if (e.data?.type === 'ready') resolve(e.data);
      if (e.data?.type === 'error') reject(new Error(`${label}: ${e.data.message}`));
    });
    w.addEventListener('error', (e) => reject(new Error(`${label}: ${e.message}`)));
  });
  w.postMessage(initMsg);
  return { worker: w, ready };
}

export async function createRuntime({ seed = 0, leadMs = START_LEAD_MS, session = newSession() } = {}) {
  if (leadMs <= BAR_MS) console.warn(`runtime: leadMs ${leadMs} is under one bar; bar 0 may play the default mood`);
  // Every channel is private to this run's session, so other tabs/windows can't cross-talk.
  const telemetry = openChannel(CHANNEL.telemetry, session);
  const netem = openChannel(CHANNEL.netem, session);
  let hub = openChannel(CHANNEL.hub, session);
  const listeners = new Set();
  telemetry.onmessage = (e) => {
    for (const fn of listeners) fn(e.data);
  };

  const agents = {};
  const spawned = AGENT_IDS.map((id) => {
    const s = spawn(new URL('./agent.worker.js', import.meta.url), { cmd: 'init', id, seed, session }, id);
    agents[id] = s.worker;
    return s.ready;
  });
  const world = spawn(new URL('./world.worker.js', import.meta.url), { cmd: 'init', session }, 'world');
  await Promise.all([...spawned, world.ready]);

  let t0 = null;
  let loss = 0;
  const setLoss = (p) => {
    loss = Math.min(1, Math.max(0, Number(p) || 0));
    netem.postMessage({ type: 'loss', p: loss });
  };
  setLoss(0);

  const rt = {
    agentIds: [...AGENT_IDS],
    session,
    get t0() {
      return t0;
    },
    get loss() {
      return loss;
    },
    get hubOpen() {
      return hub !== null;
    },
    onTelemetry(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /**
     * Hub start. A single broadcast can be lost (a worker's channel may still be registering),
     * so we repeat it every 200 ms until every agent and the world acknowledge with
     * {type:'started', t0} on telemetry, or until bar 0 begins. Returns t0; rt.started
     * resolves with t0 once all have acknowledged, or rejects naming the ones that didn't.
     */
    start() {
      if (!hub) throw new Error('start: the hub is closed (reload to start again)');
      const myT0 = (t0 = now() + leadMs);
      const waiting = new Set([...AGENT_IDS, 'world']);
      let timer = null;
      let off = null;
      rt.started = new Promise((resolve, reject) => {
        const finish = (err) => {
          clearInterval(timer);
          off();
          if (err) reject(err);
          else resolve(myT0);
        };
        off = rt.onTelemetry((m) => {
          if (m?.type === 'started' && m.t0 === myT0 && waiting.delete(m.from) && waiting.size === 0) finish();
        });
        const send = () => {
          if (!hub || t0 !== myT0) return finish(new Error('start superseded or hub closed'));
          if (now() >= myT0) {
            console.error(`runtime: no start acknowledgement from ${[...waiting].join(', ')}`);
            return finish(new Error(`not started: ${[...waiting].join(', ')}`));
          }
          hub.postMessage({ type: 'start', t0: myT0 });
        };
        send();
        timer = setInterval(send, 200);
      });
      rt.started.catch(() => {}); // callers may ignore it; never an unhandled rejection
      return myT0;
    },
    started: null,
    setRandomRotation(on) {
      if (!hub) return false;
      hub.postMessage({ type: 'useRandomRotation', on: !!on });
      return true;
    },
    endRehearsal() {
      if (!hub) return;
      hub.postMessage({ type: 'end' });
      hub.close();
      hub = null;
    },
    setLoss,
    cut() {
      setLoss(1);
      rt.endRehearsal();
    },
    restore() {
      setLoss(0);
      for (const id of AGENT_IDS) agents[id].postMessage({ cmd: 'resetFlags' });
    },
    setRogue(id, on) {
      agents[id].postMessage({ cmd: 'setRogue', on: !!on });
    },
    setBaseline(on) {
      for (const id of AGENT_IDS) agents[id].postMessage({ cmd: 'setBaseline', on: !!on });
    },
    terminate() {
      for (const w of Object.values(agents)) w.terminate();
      world.worker.terminate();
      telemetry.close();
      netem.close();
      hub?.close();
    },
  };
  return rt;
}

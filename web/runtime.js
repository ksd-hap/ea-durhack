// runtime.js — main-thread mechanics for the hub (Ilúvatar) and the experimenter. [Role 2]
// Role 4's stage.js imports this; it holds the UI. Nothing here sends musical information to
// agents: only start time (rehearsal), the random-rotation control (rehearsal), loss, and
// fault-injection switches.
//
//   const rt = await createRuntime({ seed: 0 });
//   rt.onTelemetry(msg => ...);     // every ea-telemetry message (notes, ctx, ghost, status, rx, scene)
//   const t0 = rt.start();          // hub: bar 0 starts at t0 = now + 2000 ms
//   rt.setRandomRotation(true);     // rehearsal only; returns false once the hub is closed
//   rt.endRehearsal();              // closes ea-hub for good
//   rt.setLoss(0.5); rt.cut(); rt.restore();
//   rt.setRogue('poetB', true); rt.setBaseline(true);

import { AGENT_IDS } from './core/agent.js';

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

export async function createRuntime({ seed = 0, leadMs = 2000 } = {}) {
  const telemetry = new BroadcastChannel('ea-telemetry');
  const netem = new BroadcastChannel('ea-netem');
  let hub = new BroadcastChannel('ea-hub');
  const listeners = new Set();
  telemetry.onmessage = (e) => {
    for (const fn of listeners) fn(e.data);
  };

  const agents = {};
  const spawned = AGENT_IDS.map((id) => {
    const s = spawn(new URL('./agent.worker.js', import.meta.url), { cmd: 'init', id, seed }, id);
    agents[id] = s.worker;
    return s.ready;
  });
  const world = spawn(new URL('./world.worker.js', import.meta.url), { cmd: 'init' }, 'world');
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
    start() {
      if (!hub) throw new Error('start: the hub is closed (reload to start again)');
      t0 = now() + leadMs;
      hub.postMessage({ type: 'start', t0 });
      return t0;
    },
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

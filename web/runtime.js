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
//
// Agent hosts:
//   agentHost: 'workers' (default)  all four agent Workers live in this page (the plan's design).
//   agentHost: 'windows'            each agent runs in its own window (web/agent.html?id=...),
//                                   found over 'ea-control'. This page keeps only the world.
//     rt.openAgentWindow(id)        open one agent window, tiled (call from a click: popup rules)
//     rt.presence()                 -> { eyeA: true, ... } windows seen in the last 3 s
//     rt.onPresence(fn)             called with presence() whenever it changes
//     await rt.agentsReady          resolves once all four windows are present
//   Open the windows BEFORE Start: a window opened after Start never receives t0.

import { AGENT_IDS } from './core/agent.js';
import { START_LEAD_MS, BAR_MS } from './core/time.js';
import { CHANNEL, openChannel, newSession, useRelay } from './channels.js';
import { now } from './clock.js';

// Experimenter fault-injection switches: the ONLY things ever sent to an agent host.
const AGENT_CMDS = new Set(['setRogue', 'setBaseline', 'resetFlags']);
const PRESENCE_TTL_MS = 3000;
const PING_MS = 1000;
const REJOIN_MS = 1000; // how often the open hub repeats t0 for agents that (re)joined late

function workerHost(seed, session) {
  const workers = {};
  const ready = Promise.all(
    AGENT_IDS.map((id) => {
      const s = spawn(new URL('./agent.worker.js', import.meta.url), { cmd: 'init', id, seed, session }, id);
      workers[id] = s.worker;
      return s.ready;
    }),
  );
  return {
    ready,
    presence: () => Object.fromEntries(AGENT_IDS.map((id) => [id, true])),
    onPresence: () => () => {},
    send(id, msg) {
      workers[id].postMessage(msg);
    },
    close() {
      for (const w of Object.values(workers)) w.terminate();
    },
  };
}

// Windows mode. Agent windows join THIS run because their URL carries this run's session
// (rt.openAgentWindow adds it). A window left over from an earlier run is on another session
// and can't hear us, so it can't double-play.
function windowHost(session) {
  const ctl = openChannel(CHANNEL.control, session);
  const lastSeen = {};
  const fns = new Set();
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const presence = () => Object.fromEntries(AGENT_IDS.map((id) => [id, now() - (lastSeen[id] ?? -Infinity) < PRESENCE_TTL_MS]));
  let last = JSON.stringify(presence());
  const check = () => {
    const p = presence();
    const s = JSON.stringify(p);
    if (s !== last) {
      last = s;
      for (const fn of fns) fn(p);
    }
    if (AGENT_IDS.every((id) => p[id])) resolveReady();
  };
  ctl.onmessage = (e) => {
    const m = e.data ?? {};
    if (m.type === 'present' && AGENT_IDS.includes(m.id)) lastSeen[m.id] = now();
    if (m.type === 'gone' && AGENT_IDS.includes(m.id)) delete lastSeen[m.id];
    check();
  };
  const ping = () => {
    ctl.postMessage({ type: 'ping' });
    check();
  };
  ping();
  const timer = setInterval(ping, PING_MS);
  return {
    ready,
    presence,
    onPresence(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    send(id, msg) {
      ctl.postMessage({ type: 'cmd', target: id, ...msg });
    },
    close() {
      clearInterval(timer);
      ctl.close();
    },
  };
}

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

export async function createRuntime({ seed = 0, leadMs = START_LEAD_MS, agentHost = 'workers', session = newSession(), relay = null } = {}) {
  if (!['workers', 'windows', 'phones'].includes(agentHost)) throw new Error(`agentHost: ${agentHost}`);
  // Phones: every channel (and the world) goes through the laptop's relay, the clock is the
  // relay's, and the session is announced so phones can join this run without typing it.
  if (agentHost === 'phones' && !relay) {
    const { defaultRelayUrl } = await import('./relay-client.js');
    relay = defaultRelayUrl();
  }
  let relayClient = null;
  if (relay) {
    const { connectRelay } = await import('./relay-client.js');
    relayClient = connectRelay(relay, { label: `stage ${session}` });
    useRelay(relayClient);
    await relayClient.ready;
    relayClient.announceSession(session);
    setInterval(() => relayClient.announceSession(session), 5000); // survive relay restarts
  }
  if (leadMs <= BAR_MS) console.warn(`runtime: leadMs ${leadMs} is under one bar; bar 0 may play the default mood`);
  // Every channel is private to this run's session, so other tabs/windows can't cross-talk.
  const telemetry = openChannel(CHANNEL.telemetry, session);
  const netem = openChannel(CHANNEL.netem, session);
  let hub = openChannel(CHANNEL.hub, session);
  const listeners = new Set();
  telemetry.onmessage = (e) => {
    for (const fn of listeners) fn(e.data);
  };

  const host = agentHost === 'workers' ? workerHost(seed, session) : windowHost(session); // windows + phones: agents elsewhere
  const toAgent = (id, msg) => {
    if (!AGENT_CMDS.has(msg.cmd)) throw new Error(`runtime: ${msg.cmd} is not a fault-injection switch`);
    host.send(id, msg);
  };
  const world = spawn(new URL('./world.worker.js', import.meta.url), { cmd: 'init', session, relay }, 'world');
  // Workers mode: wait for the agents too. Windows mode: they arrive when opened (rt.agentsReady).
  await Promise.all(agentHost === 'workers' ? [host.ready, world.ready] : [world.ready]);

  let t0 = null;
  let rejoinTimer = null;
  let loss = 0;
  const setLoss = (p) => {
    loss = Math.min(1, Math.max(0, Number(p) || 0));
    netem.postMessage({ type: 'loss', p: loss });
  };
  setLoss(0);

  const rt = {
    agentIds: [...AGENT_IDS],
    session,
    agentHost,
    agentsReady: host.ready,
    presence: host.presence,
    onPresence: host.onPresence,
    /** Windows mode: open one agent's window for THIS run, tiled 2x2. Call from a click handler.
     *  Reuses the window name, so a stale window from an earlier run is replaced, not duplicated. */
    openAgentWindow(id) {
      const i = AGENT_IDS.indexOf(id);
      if (i < 0) throw new Error(`unknown agent ${id}`);
      const w = 440;
      const h = 300;
      const left = Math.max(0, (screen.availWidth || 1280) - 2 * w) + (i % 2) * w;
      const top = Math.floor(i / 2) * (h + 40);
      const url = new URL(`./agent.html?id=${id}&seed=${seed}&session=${session}`, import.meta.url);
      return window.open(url, `ea-agent-${id}`, `popup,width=${w},height=${h},left=${left},top=${top}`);
    },
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
      // Late rejoin: a phone that reloads mid-run starts a fresh agent that never heard t0. While
      // the hub is open (rehearsal, before the cut) keep repeating the same start once a second;
      // agents ignore a repeat of the t0 they already have, and a new one plans from the current
      // bar. After End rehearsal / Cut the hub is closed, so nothing can rejoin (by design).
      clearInterval(rejoinTimer);
      rejoinTimer = setInterval(() => {
        if (!hub || t0 !== myT0) return clearInterval(rejoinTimer);
        if (now() >= myT0) hub.postMessage({ type: 'start', t0: myT0 });
      }, REJOIN_MS);
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
      clearInterval(rejoinTimer);
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
      for (const id of AGENT_IDS) toAgent(id, { cmd: 'resetFlags' });
    },
    setRogue(id, on) {
      toAgent(id, { cmd: 'setRogue', on: !!on });
      // Switching corruption OFF redeems the agent: clear every agent's sticky flags, or the
      // others keep distrusting it (and covering its job) for the rest of the run. Flags still
      // survive the cut as long as the saboteur stays corrupted.
      if (!on) rt.clearFlags();
    },
    /** Display only: share the Stage's current story line with the phones ({key, title, line}).
     *  Sent on telemetry, which agents never read (isolation rule 1), so it can't steer the music. */
    narrate(story) {
      telemetry.postMessage({ type: 'story', key: story.key, title: story.title, line: story.line });
    },
    /** Experimenter: forget every rogue verdict (Restore does this too, along with loss 0). */
    clearFlags() {
      for (const aid of AGENT_IDS) toAgent(aid, { cmd: 'resetFlags' });
    },
    setBaseline(on) {
      for (const id of AGENT_IDS) toAgent(id, { cmd: 'setBaseline', on: !!on });
    },
    terminate() {
      clearInterval(rejoinTimer);
      host.close();
      world.worker.terminate();
      telemetry.close();
      netem.close();
      hub?.close();
    },
  };
  return rt;
}

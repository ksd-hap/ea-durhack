// agent.worker.js — thin wrapper: channels <-> agent core. [Role 2]
//
// ============================== ISOLATION RULE ==============================
// The main thread may send this worker ONLY these messages:
//   {cmd:'init', id, seed, session}  which agent to be, and which run's channels to join
//   {cmd:'setRogue', on}        experimenter fault injection: become Melkor
//   {cmd:'setBaseline', on}     experimenter switch: conductor-baseline comparison mode
//   {cmd:'resetFlags'}          experimenter pressed Restore: clear sticky rogue flags
// These are fault-injection switches, NEVER musical information. Everything musical
// reaches an agent only through its own sense channel (ea-sense-<id>) or the lossy
// network (ea-net). Agents write telemetry but never read it, and never see scene ids
// or the right answers. tools/check_isolation.sh enforces this before every merge.
// ============================================================================

import { createAgent } from './core/agent.js';
import { barAt } from './core/time.js';
import { createTransport } from './transport.js';
import { createTelemetrySender } from './telemetry-out.js';
import { CHANNEL, openChannel } from './channels.js';

const TICK_MS = 50;

let id = null;
let agent = null;
let transport = null;
let telemetry = null;
let hub = null;
let sense = null;
let t0 = null;
let lastPlanned = null;
let timer = null;

const now = () => performance.timeOrigin + performance.now();

self.onmessage = async (e) => {
  const m = e.data ?? {};
  try {
    switch (m.cmd) {
      case 'init':
        await init(m);
        break;
      case 'setRogue':
        agent?.setRogue(!!m.on);
        break;
      case 'setBaseline':
        agent?.setBaseline(!!m.on);
        break;
      case 'resetFlags':
        agent?.resetFlags();
        break;
      default:
        console.warn(`[${id}] ignored main-thread message`, m);
    }
  } catch (err) {
    console.error(`[${id}]`, err);
    self.postMessage({ type: 'error', id, message: String(err?.stack ?? err) });
  }
};

async function init({ id: myId, seed = 0, session }) {
  if (agent) return;
  id = myId;
  const res = await fetch(new URL('./data/agents.json', import.meta.url));
  if (!res.ok) throw new Error(`agents.json: HTTP ${res.status}`);
  const data = await res.json();
  agent = createAgent({
    id,
    params: data.agents[id],
    anchors: data.anchors,
    thresholds: data.thresholds,
    fusion: data.fusion ?? null,
    seed,
  });
  telemetry = createTelemetrySender(session);
  transport = createTransport({
    id,
    seed,
    session,
    onDeliver: (msg) => agent.onPeer(msg),
    emit: (msg) => telemetry.send(msg),
  });

  sense = openChannel(CHANNEL.sense(id), session);
  sense.onmessage = (ev) => {
    const v = ev.data;
    if (v && v.type === 'view') agent.onView(v.bar, v.vec);
  };

  hub = openChannel(CHANNEL.hub, session);
  hub.onmessage = (ev) => {
    const h = ev.data ?? {};
    if (h.type === 'start') {
      // The hub repeats 'start' until we acknowledge, so it must be idempotent:
      // only a NEW t0 resets the bar loop (a repeat must not re-plan a bar).
      if (h.t0 !== t0) {
        t0 = h.t0;
        lastPlanned = null;
      }
      telemetry.send({ type: 'started', from: id, t0 });
    } else if (h.type === 'useRandomRotation') {
      agent.setRandomRotation(!!h.on);
    } else if (h.type === 'end') {
      // Rehearsal over: the hub is gone for good. We keep t0 and carry on alone.
      hub.close();
      hub = null;
    }
  };

  timer = setInterval(tick, TICK_MS);
  self.postMessage({ type: 'ready', id });
}

// Absolute-time loop: while bar n sounds, plan bar n+1 exactly once.
function tick() {
  if (t0 === null) return;
  const next = barAt(t0, now()) + 1;
  if (next < 0) return; // bar 0 is planned during bar -1
  if (lastPlanned !== null && next <= lastPlanned) return;
  lastPlanned = next; // if the tab stalled we skip missed bars rather than burst them
  const { notes, outbox, telemetry: tel } = agent.planBar(next, { t0 });
  for (const n of notes) telemetry.send({ type: 'note', ...n });
  for (const t of tel) telemetry.send(t);
  for (const m of outbox) transport.send(m);
}

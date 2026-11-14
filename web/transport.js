// transport.js — the lossy agent-to-agent network. [Role 2]
//
// Wraps the session's 'ea-net' channel. On RECEIVE, each message is dropped with probability p
// using a seeded generator private to this agent. p comes from 'ea-netem', which only this
// layer reads; agent logic never sees it. BroadcastChannel never delivers a message back to
// the sender's own channel object, which is what we want.
//
// Every second emits {type:'rx', from, count, dropped, total, loss} to telemetry, where
// count/dropped are for the last interval and total is cumulative delivered.

import { mulberry32, seedFor } from './core/rng.js';
import { CHANNEL, openChannel } from './channels.js';

export function createTransport({ id, seed = 0, session, onDeliver, emit, rxIntervalMs = 1000 }) {
  const rng = mulberry32(seedFor(`net:${id}`, seed));
  let p = 0;
  let delivered = 0;
  let dropped = 0;
  let total = 0;

  const net = openChannel(CHANNEL.net, session);
  const netem = openChannel(CHANNEL.netem, session);

  netem.onmessage = (e) => {
    const m = e.data;
    if (m && m.type === 'loss') {
      const v = Number(m.p);
      p = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : p;
    }
  };

  net.onmessage = (e) => {
    const msg = e.data;
    if (!msg || msg.from === id) return;
    if (rng() < p) {
      dropped++;
      return;
    }
    delivered++;
    total++;
    onDeliver(msg);
  };

  const timer = setInterval(() => {
    emit({ type: 'rx', from: id, count: delivered, dropped, total, loss: p });
    delivered = 0;
    dropped = 0;
  }, rxIntervalMs);

  return {
    send(msg) {
      net.postMessage(msg);
    },
    close() {
      clearInterval(timer);
      net.close();
      netem.close();
    },
  };
}

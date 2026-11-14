// relay-client.js — channels across devices, through tools/phone-server.mjs. [Role 2]
//
// One WebSocket per JavaScript context (page or worker), multiplexing every channel the context
// opens. Channel objects mimic BroadcastChannel: postMessage(data), onmessage = fn,
// addEventListener('message', fn), close(). A message reaches every OTHER channel object with
// the same name, on this device (delivered locally) or another (forwarded by the relay), and
// never the object that sent it. Agent code is unchanged: channels.js returns these instead of
// BroadcastChannels when a relay is in use.
//
// The client also keeps this context's clock in step with the laptop (clock.js) and reconnects
// on its own if the connection drops (phones lose Wi-Fi).

import { setOffset, clockInfo } from './clock.js';

const relays = new Map(); // url -> relay (one per context)

export function connectRelay(url, { label = '' } = {}) {
  if (relays.has(url)) return relays.get(url);
  const objects = new Map(); // channel name -> Set(channel object)
  const outbox = [];
  const statusFns = new Set();
  let ws = null;
  let open = false;
  let pingId = 0;
  const samples = [];
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  let backoff = 250;
  let syncTimer = null;
  let stopped = false;

  const status = (s) => {
    for (const fn of statusFns) fn({ ...s, ...clockInfo(), open });
  };
  const sendRaw = (obj) => {
    const text = JSON.stringify(obj);
    if (open) ws.send(text);
    else outbox.push(text);
  };

  function sync(count = 8) {
    for (let i = 0; i < count; i++) {
      setTimeout(() => open && ws.send(JSON.stringify({ op: 'time', id: ++pingId, t1: performance.timeOrigin + performance.now() })), i * 60);
    }
  }

  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      open = true;
      backoff = 250;
      if (label) ws.send(JSON.stringify({ op: 'hello', label }));
      for (const ch of objects.keys()) ws.send(JSON.stringify({ op: 'sub', ch }));
      while (outbox.length) ws.send(outbox.shift());
      samples.length = 0;
      sync(10);
      clearInterval(syncTimer);
      syncTimer = setInterval(() => sync(4), 10000);
      status({ event: 'open' });
    };
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.op === 'msg') {
        for (const obj of objects.get(m.ch) ?? []) obj._deliver(m.data);
      } else if (m.op === 'time') {
        const t4 = performance.timeOrigin + performance.now();
        const rtt = t4 - m.t1;
        samples.push({ rtt, offset: m.ts - (m.t1 + t4) / 2 });
        if (samples.length > 30) samples.shift();
        const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        setOffset(best.offset, best.rtt);
        if (samples.length >= 5) resolveReady();
        status({ event: 'time' });
      } else if (m.op === 'session') {
        for (const fn of sessionWaiters.splice(0)) fn(m.session);
      }
    };
    ws.onclose = () => {
      open = false;
      clearInterval(syncTimer);
      status({ event: 'closed' });
      if (!stopped) setTimeout(connect, (backoff = Math.min(backoff * 2, 4000)));
    };
    ws.onerror = () => {};
  }
  const sessionWaiters = [];
  connect();

  function openChannel(name) {
    const listeners = new Set();
    const obj = {
      name,
      onmessage: null,
      postMessage(data) {
        // Local delivery to the other objects on this device, then the relay for other devices.
        for (const other of objects.get(name) ?? []) if (other !== obj) other._deliver(data);
        sendRaw({ op: 'pub', ch: name, data });
      },
      addEventListener(type, fn) {
        if (type === 'message') listeners.add(fn);
      },
      removeEventListener(type, fn) {
        listeners.delete(fn);
      },
      close() {
        objects.get(name)?.delete(obj);
        if (!objects.get(name)?.size) {
          objects.delete(name);
          sendRaw({ op: 'unsub', ch: name });
        }
      },
      _deliver(data) {
        const ev = { data };
        queueMicrotask(() => {
          obj.onmessage?.(ev);
          for (const fn of listeners) fn(ev);
        });
      },
    };
    if (!objects.has(name)) {
      objects.set(name, new Set());
      sendRaw({ op: 'sub', ch: name });
    }
    objects.get(name).add(obj);
    return obj;
  }

  const relay = {
    url,
    ready, // resolves once the clock has a few samples
    openChannel,
    announceSession(session) {
      sendRaw({ op: 'announce', session });
    },
    askSession() {
      return new Promise((resolve) => {
        sessionWaiters.push(resolve);
        sendRaw({ op: 'session?' });
      });
    },
    onStatus(fn) {
      statusFns.add(fn);
      return () => statusFns.delete(fn);
    },
    get open() {
      return open;
    },
    close() {
      stopped = true;
      clearInterval(syncTimer);
      ws?.close();
    },
  };
  relays.set(url, relay);
  return relay;
}

/** ws://<host>/relay for the page's own server (pages are served by tools/phone-server.mjs). */
export function defaultRelayUrl(loc = globalThis.location) {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/relay`;
}

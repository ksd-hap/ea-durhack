// channels.js — the ONLY place BroadcastChannels are created. [Role 2]
//
// Every channel name carries the run's session id: 'ea-net' becomes 'ea-net:k3f9x2'. The
// Stage's runtime picks a fresh random session per run and hands it to the world and the
// agents. So a second Stage tab, or an agent window left over from an earlier run, is on a
// different session and can neither hear nor steer this one. (Without this, every tab on the
// same origin shared one set of channels and could cross-talk.)
//
// Roles 3 and 4: never create channels yourselves. Use the runtime (rt.onTelemetry, rt.cut...).
// tools/check_isolation.sh fails on any `new BroadcastChannel(` outside this file.

export const CHANNEL = {
  net: 'ea-net', // agent <-> agent, lossy, cut by the experimenter
  netem: 'ea-netem', // experimenter -> transport layer (loss p)
  hub: 'ea-hub', // hub -> agents + world, rehearsal only
  telemetry: 'ea-telemetry', // agents + world -> Stage, one way
  control: 'ea-control', // Stage <-> agent windows (windows mode)
  sense: (id) => `ea-sense-${id}`, // world -> one agent: its own view
};

const SESSION_RE = /^[a-z0-9]{4,32}$/;

export function newSession() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

/** Open a channel scoped to `session`. `base` is a CHANNEL name (sense: CHANNEL.sense(id)). */
export function openChannel(base, session) {
  if (!SESSION_RE.test(String(session))) throw new Error(`openChannel(${base}): invalid session "${session}"`);
  return new BroadcastChannel(`${base}:${session}`);
}

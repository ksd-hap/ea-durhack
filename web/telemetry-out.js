// Send-only handle on the one-way telemetry channel (agents/world -> Stage). [Role 2]
// Agent-side code must reach 'ea-telemetry' ONLY through this file, and this file never
// listens. tools/check_isolation.sh enforces both rules.

const TELEMETRY_CHANNEL = 'ea-telemetry';

export function createTelemetrySender() {
  const ch = new BroadcastChannel(TELEMETRY_CHANNEL);
  return {
    send(msg) {
      ch.postMessage(msg);
    },
    close() {
      ch.close();
    },
  };
}

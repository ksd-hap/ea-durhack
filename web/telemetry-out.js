// Send-only handle on the one-way telemetry channel (agents/world -> Stage). [Role 2]
// Agent-side code must reach the telemetry channel ONLY through this file, and this file
// never listens. tools/check_isolation.sh enforces both rules.

import { CHANNEL, openChannel } from './channels.js';

export function createTelemetrySender(session) {
  const ch = openChannel(CHANNEL.telemetry, session);
  return {
    send(msg) {
      ch.postMessage(msg);
    },
    close() {
      ch.close();
    },
  };
}

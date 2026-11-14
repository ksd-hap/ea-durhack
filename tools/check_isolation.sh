#!/usr/bin/env bash
# Isolation check [Role 2]. Guards the claim "agents never peek at the answer and there is
# no hidden hub". Run before every merge:  bash tools/check_isolation.sh
set -u
cd "$(dirname "$0")/.."
fail=0
bad() { echo "ISOLATION FAIL: $*"; fail=1; }
# Drop matches on pure comment lines. Every grep uses -H so lines look like file:line:text.
code() { grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)'; }

AGENT_FILES="web/agent.worker.js web/transport.js web/core/*.js"

# 1. Agent-side code never mentions ground truth, scene files or the telemetry channel directly.
for pat in 'truth' 'scenes' 'ea-telemetry' 'ea-sense-world' 'CHANNEL.telemetry' 'CHANNEL.control' 'metrics.js'; do
  hits=$(grep -HnF -- "$pat" $AGENT_FILES 2>/dev/null | code)
  [ -n "$hits" ] && bad "agent code references '$pat':"$'\n'"$hits"
done

# 2. The telemetry sender is send-only.
grep -HnE 'onmessage|addEventListener' web/telemetry-out.js | code | grep . && bad "telemetry-out.js must never listen"

# 3. The pure core has no I/O, clocks, timers or unseeded randomness.
hits=$(grep -HnE 'setTimeout|setInterval|BroadcastChannel|openChannel|fetch\(|performance\.|Date\.now|Math\.random|crypto\.|postMessage|self\.' web/core/*.js | code)
[ -n "$hits" ] && bad "web/core must be pure:"$'\n'"$hits"

# 4. The world never listens to the agent network.
grep -HnE "ea-net[^e]|ea-net'|CHANNEL\.net\b" web/world.worker.js | code | grep . && bad "world.worker.js must not touch ea-net"

# 5. The main thread only sends agents fault-injection commands.
hits=$(grep -HnoE "cmd: *'[a-zA-Z]+'" web/*.js web/dev/*.js 2>/dev/null | grep -vE "'(init|setRogue|setBaseline|resetFlags)'")
[ -n "$hits" ] && bad "unexpected main->agent command:"$'\n'"$hits"

# 6. Channels are created ONLY in web/channels.js, so every name carries the run's session
#    (otherwise other tabs/windows on the same origin can cross-talk). Applies to all roles.
hits=$(grep -rHnE 'new BroadcastChannel\(' web --include='*.js' --include='*.html' | grep -v '^web/channels.js:' | code)
[ -n "$hits" ] && bad "create channels only via openChannel() in web/channels.js:"$'\n'"$hits"

# 7. An agent host page (a window, or a phone) only hosts and relays: it never touches the
#    musical channels or the answers, and relays nothing but the three fault-injection switches.
for host in web/agent-window.js web/phone.js; do
  for pat in 'ea-net' 'ea-hub' 'ea-sense' 'CHANNEL.net' 'CHANNEL.hub' 'CHANNEL.sense' 'truth' 'scenes'; do
    hits=$(grep -HnF -- "$pat" "$host" 2>/dev/null | code)
    [ -n "$hits" ] && bad "$host references '$pat':"$'\n'"$hits"
  done
  grep -qF "RELAYED = new Set(['setRogue', 'setBaseline', 'resetFlags'])" "$host" \
    || bad "$host must relay exactly setRogue, setBaseline, resetFlags"
done

# 8. Network sockets only in web/relay-client.js (the cross-device form of rule 6), and the
#    relay server never inspects or alters payloads (it has no musical logic to leak).
hits=$(grep -rHnE 'new WebSocket\(' web --include='*.js' --include='*.html' | grep -v '^web/relay-client.js:' | code)
[ -n "$hits" ] && bad "open sockets only in web/relay-client.js:"$'
'"$hits"
grep -HnE 'truth|scenes\.json|mode|density|pitch' tools/phone-server.mjs | code | grep . && bad "phone-server.mjs must not look inside messages"

if [ $fail -eq 0 ]; then echo "isolation check: OK"; fi
exit $fail

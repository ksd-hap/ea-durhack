#!/usr/bin/env bash
# Isolation check [Role 2]. Guards the claim "agents never peek at the answer and there is
# no hidden hub". Run before every merge:  bash tools/check_isolation.sh
set -u
cd "$(dirname "$0")/.."
fail=0
bad() { echo "ISOLATION FAIL: $*"; fail=1; }
# Drop matches on pure comment lines (file:line:   // ...).
code() { grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)'; }

AGENT_FILES="web/agent.worker.js web/transport.js web/core/*.js"

# 1. Agent-side code never mentions ground truth, scene files or the telemetry channel directly.
for pat in 'truth' 'scenes' 'ea-telemetry' 'ea-sense-world'; do
  hits=$(grep -Hn -- "$pat" $AGENT_FILES 2>/dev/null | code)
  [ -n "$hits" ] && bad "agent code references '$pat':"$'\n'"$hits"
done

# 2. The telemetry sender is send-only.
grep -HnE 'onmessage|addEventListener' web/telemetry-out.js | code | grep . && bad "telemetry-out.js must never listen"

# 3. The pure core has no I/O, clocks, timers or unseeded randomness.
hits=$(grep -HnE 'setTimeout|setInterval|BroadcastChannel|fetch\(|performance\.|Date\.now|Math\.random|postMessage|self\.' web/core/*.js | code)
[ -n "$hits" ] && bad "web/core must be pure:"$'\n'"$hits"

# 4. The world never listens to the agent network.
grep -HnE "ea-net[^e]|ea-net'" web/world.worker.js | code | grep . && bad "world.worker.js must not touch ea-net"

# 5. The main thread only sends agents fault-injection commands.
hits=$(grep -noE "cmd: *'[a-zA-Z]+'" web/*.js web/dev/*.js 2>/dev/null | grep -vE "'(init|setRogue|setBaseline|resetFlags)'")
[ -n "$hits" ] && bad "unexpected main->agent command:"$'\n'"$hits"

# 6. An agent window only hosts and relays: it never touches the musical channels or the
#    answers, and relays nothing but the three fault-injection switches.
for pat in 'ea-net' 'ea-hub' 'ea-sense' 'ea-netem' 'truth' 'scenes'; do
  hits=$(grep -Hn -- "$pat" web/agent-window.js 2>/dev/null | code)
  [ -n "$hits" ] && bad "agent-window.js references '$pat':"$'
'"$hits"
done
grep -q "RELAYED = new Set(\['setRogue', 'setBaseline', 'resetFlags'\])" web/agent-window.js   || bad "agent-window.js must relay exactly setRogue, setBaseline, resetFlags"

if [ $fail -eq 0 ]; then echo "isolation check: OK"; fi
exit $fail

#!/usr/bin/env bash
# The edge suite (e2e/edge-fences-ui.mjs): a fresh build, its own Lura, two
# browsers, scenarios A–I.
#
#   e2e/edge.sh                          # all of it, on :8097
#   E2E_SCENARIOS=A,B e2e/edge.sh        # a subset (the setup always runs)
#   E2E_SHOTS=0 e2e/edge.sh              # skip the screenshot tour
#   E2E_OUT=/tmp/edge-run1 e2e/edge.sh   # where screenshots and results.json go
#
# The cool-off is cut to 4 s on purpose: a long cool-off hides a fence that
# flaps on GPS jitter (the same arrive cannot fire twice in 30 min whatever the
# engine does), and this suite is there to see the flapping if it happens.
# Everything else is run.sh: Keycloak check, web build, server, teardown.
set -euo pipefail
cd "$(dirname "$0")"
export E2E_SUITE=edge-fences-ui
export E2E_PORT="${E2E_PORT:-8097}"
export E2E_PHASES=maplibre
export E2E_COOLOFF="${E2E_COOLOFF:-4s}"
export E2E_COOLOFF_MS="${E2E_COOLOFF_MS:-4000}"
# Scenario G checks that quiet hours hold back push: Lura's webhook channel
# posts to a sink the suite listens on, on a free port the OS picks.
E2E_WEBHOOK_PORT="${E2E_WEBHOOK_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')}"
export E2E_WEBHOOK_PORT
export LURA_WEBHOOK_URL="http://127.0.0.1:$E2E_WEBHOOK_PORT/hook"
exec ./run.sh

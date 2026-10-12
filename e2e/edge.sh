#!/usr/bin/env bash
# The edge suites, each on its own port with its own fresh Lura (run.sh does the
# Keycloak check, the web build, the server and the teardown):
#
#   sync       e2e/edge-sync.mjs on :8096 — consistency, latency, reconnects,
#              reloads, token expiry, out-of-order fixes, pause, stale peers,
#              crossed invitations and two tabs.
#   fences-ui  e2e/edge-fences-ui.mjs on :8097 — fences, notifications and every
#              screen, scenarios A–I, plus a screenshot tour.
#
#   e2e/edge.sh                     # both, one after the other
#   e2e/edge.sh sync                # one of them
#   E2E_ONLY=1,2 e2e/edge.sh sync   # sync: just those scenarios (setup always runs)
#   E2E_SCENARIOS=A,B e2e/edge.sh fences-ui   # fences-ui: a subset
#   E2E_SHOTS=0 e2e/edge.sh fences-ui         # skip the screenshot tour
#   E2E_STORE=postgres e2e/edge.sh            # against a throwaway PostGIS (see run.sh)
#   E2E_OUT=/tmp/edge-run1 e2e/edge.sh sync   # where screenshots and results.json go
#
# sync signs in through the `lura-app-edge` Keycloak client — lura-app with 60 s
# access tokens — which run.sh creates from e2e/keycloak-edge-client.json and
# opens to the run's port.
#
# fences-ui cuts the cool-off to 4 s on purpose: a long cool-off hides a fence
# that flaps on GPS jitter (the same arrive cannot fire twice in 30 min whatever
# the engine does), and that suite is there to see the flapping if it happens.
# Its scenario G checks that quiet hours hold back push: Lura's webhook channel
# posts to a sink the suite listens on, on a free port the OS picks.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

run_sync() {
  (
    export E2E_SUITE=edge-sync
    export E2E_PORT="${E2E_PORT:-8096}"
    exec "$HERE/run.sh"
  )
}

run_fences_ui() {
  (
    export E2E_SUITE=edge-fences-ui
    export E2E_PORT="${E2E_PORT:-8097}"
    export E2E_COOLOFF="${E2E_COOLOFF:-4s}"
    export E2E_COOLOFF_MS="${E2E_COOLOFF_MS:-4000}"
    E2E_WEBHOOK_PORT="${E2E_WEBHOOK_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')}"
    export E2E_WEBHOOK_PORT
    export LURA_WEBHOOK_URL="http://127.0.0.1:$E2E_WEBHOOK_PORT/hook"
    exec "$HERE/run.sh"
  )
}

case "${1:-all}" in
  sync) run_sync ;;
  fences-ui) run_fences_ui ;;
  all)
    if [ -n "${E2E_OUT:-}" ]; then
      echo "e2e: E2E_OUT names one run; pick a suite (sync | fences-ui) to use it" >&2
      exit 2
    fi
    status=0
    run_sync || status=1
    run_fences_ui || status=1
    exit $status
    ;;
  *) echo "usage: e2e/edge.sh [sync | fences-ui | all]" >&2; exit 2 ;;
esac

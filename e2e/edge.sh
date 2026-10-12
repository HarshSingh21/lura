#!/usr/bin/env bash
# The edge-case sync suite (e2e/edge-sync.mjs) on its own port with its own
# fresh Lura: consistency, latency, reconnects, reloads, token expiry,
# out-of-order fixes, pause, stale peers, crossed invitations and two tabs.
#
#   e2e/edge.sh
#   E2E_OUT=/tmp/edge-run1 e2e/edge.sh
#   E2E_ONLY=1,2 e2e/edge.sh          # just those scenarios (setup always runs)
#   E2E_SKIP_BUILD=1 E2E_WEB_DIR=/tmp/edge-web e2e/edge.sh   # reuse a build
#
# It signs in through the `lura-app-edge` Keycloak client — lura-app with 60 s
# access tokens — which run.sh creates from e2e/keycloak-edge-client.json when
# it is missing. That client only redirects to localhost:8096, so the port is
# fixed unless you add yours to the JSON (and to the live client).
set -euo pipefail
export E2E_SUITE=edge-sync
export E2E_PORT="${E2E_PORT:-8096}"
exec "$(cd "$(dirname "$0")" && pwd)/run.sh"

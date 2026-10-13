#!/usr/bin/env bash
# The trigger use cases (e2e/uc-triggers.mjs) on their own Lura, :8094 by
# default — run.sh does the Keycloak check, the web build, the server and the
# teardown:
#
#   UC8   dwell: one reminder after staying, none after leaving early
#   UC9   leave: one per departure, none from GPS jitter at the edge
#   UC11  quiet hours and mute: stored, carded and in History, but silent; push held
#   plus  overlapping fences, and one fence with two notes
#
#   e2e/uc-triggers.sh
#   E2E_STORE=postgres e2e/uc-triggers.sh            # against a throwaway PostGIS (see run.sh)
#   E2E_CASES=UC8,UC9 e2e/uc-triggers.sh             # a subset (setup always runs)
#   E2E_OUT=/tmp/uc-triggers-1 e2e/uc-triggers.sh    # where screenshots and results.json go
#
# The cool-off is cut to 5 s on purpose, as in the fences edge suite: with the
# product's 30 min a fence flapping on GPS jitter could never show itself, so
# the leave hysteresis — not the cool-off — is what this suite holds to "one
# leave". Dwell timing is the product's own (whole minutes, checked every 10 s):
# a dwell of one minute takes one minute of wall time whatever lurasim's -scale.
# Push is checked through Lura's webhook channel posting to a sink the suite
# listens on, on a free port the OS picks.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export E2E_SUITE=uc-triggers
export E2E_PORT="${E2E_PORT:-8094}"
export E2E_COOLOFF="${E2E_COOLOFF:-5s}"
export E2E_COOLOFF_MS="${E2E_COOLOFF_MS:-5000}"
E2E_WEBHOOK_PORT="${E2E_WEBHOOK_PORT:-$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')}"
export E2E_WEBHOOK_PORT
export LURA_WEBHOOK_URL="http://127.0.0.1:$E2E_WEBHOOK_PORT/hook"
exec "$HERE/run.sh"

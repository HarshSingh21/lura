#!/usr/bin/env bash
# End-to-end run: Keycloak users, a fresh build, a fresh server, two browsers.
#
#   e2e/run.sh                 # MapLibre on localhost, then Mappls on lura.com if a key is set
#   E2E_PHASES=maplibre e2e/run.sh
#   E2E_PORT=8091 e2e/run.sh       # its own server, so several runs can go at once
#   E2E_STEPS=6,8 E2E_SEED=1 e2e/run.sh   # only those steps; step 4's fences come from the API
#   E2E_KEEP_RUNNING=1 e2e/run.sh   # leave Lura on :8080 serving the build afterwards
#   E2E_SUITE=edge-fences-ui e2e/run.sh   # another suite in e2e/ (see e2e/edge.sh)
#
# Requirements: Docker with the `lura-keycloak` container running (see
# deploy/keycloak/README.md), Go, Node 20+, Google Chrome. For the Mappls phase,
# LURA_MAPPLS_WEB_KEY in the environment (never in this repository) and a key
# whitelisted for lura.com: Chrome is pointed at 127.0.0.1 for that name, so no
# hosts-file edit is needed.
#
# Screenshots, server logs and results.json land in $E2E_OUT (a temp dir by
# default); nothing is written inside the repository.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${E2E_OUT:-$(mktemp -d -t lura-e2e)}"
PORT="${E2E_PORT:-8080}"
KC_CONTAINER="${KC_CONTAINER:-lura-keycloak}"
KC_URL="${KC_URL:-http://localhost:8085}"
PHASES="${E2E_PHASES:-maplibre mappls}"
mkdir -p "$OUT"
echo "e2e: output in $OUT"

log() { printf '\n== %s\n' "$*"; }

# ---------------------------------------------------------------- keycloak
# The realm is imported once, when the container first starts, so the release's
# two test people may be missing from a container that predates them. kcadm is
# idempotent enough here: "exists" is not an error.
ensure_keycloak() {
  log "keycloak: checking realm and test users"
  curl -fsS "$KC_URL/realms/lura/.well-known/openid-configuration" >/dev/null
  local kc=(docker exec "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh)
  "${kc[@]}" config credentials --server http://localhost:8085 --realm master \
    --user "${KEYCLOAK_ADMIN:-admin}" --password "${KEYCLOAK_ADMIN_PASSWORD:-admin}" >/dev/null 2>&1 \
    || "${kc[@]}" config credentials --server http://localhost:8080 --realm master \
      --user "${KEYCLOAK_ADMIN:-admin}" --password "${KEYCLOAK_ADMIN_PASSWORD:-admin}" >/dev/null
  local spec user first last pass
  for spec in "harsh@lura.local Harsh Singh lura-harsh" "nishtha@lura.local Nishtha Dev lura-nishtha"; do
    read -r user first last pass <<<"$spec"
    if [ "$("${kc[@]}" get users -r lura -q "username=$user" -q exact=true --fields id 2>/dev/null | grep -c '"id"')" = "0" ]; then
      "${kc[@]}" create users -r lura -s "username=$user" -s "email=$user" -s "firstName=$first" \
        -s "lastName=$last" -s enabled=true -s emailVerified=true >/dev/null
      echo "keycloak: created $user"
    fi
    "${kc[@]}" set-password -r lura --username "$user" --new-password "$pass" >/dev/null
    "${kc[@]}" add-roles -r lura --uusername "$user" --rolename user >/dev/null 2>&1 || true
  done
}

# ---------------------------------------------------------------- build
build() {
  if [ "${E2E_SKIP_BUILD:-0}" != "1" ]; then
    log "build: web client"
    (cd "$ROOT/client" && npm run build:web >"$OUT/build-web.log" 2>&1) || { tail -40 "$OUT/build-web.log"; exit 1; }
  fi
  log "build: server and simulator"
  (cd "$ROOT" && go build -o "$OUT/lura" ./cmd/lura && go build -o "$OUT/lurasim" ./cmd/lurasim)
  if [ ! -d "$ROOT/e2e/node_modules/playwright-core" ]; then
    (cd "$ROOT/e2e" && npm install --no-audit --no-fund >/dev/null)
  fi
}

# ---------------------------------------------------------------- server
SERVER_PID=""
stop_port() {
  local pids
  pids="$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "e2e: stopping the process on :$PORT ($pids)"
    kill $pids 2>/dev/null || true
    for _ in $(seq 1 50); do lsof -nP -iTCP:$PORT -sTCP:LISTEN -t >/dev/null 2>&1 || return 0; sleep 0.1; done
    kill -9 $pids 2>/dev/null || true
  fi
}

# server_env prints the environment for one provider. The geofence cool-off is
# shortened so the pause/resume step can watch the same fence fire twice in one
# run; everything else is the product default.
server_env() {
  local provider="$1"
  echo "LURA_HTTP_ADDR=:$PORT"
  echo "LURA_OIDC_ISSUER=$KC_URL/realms/lura"
  echo "LURA_OIDC_AUDIENCE=lura-api"
  echo "LURA_WEB_DIR=$ROOT/client/dist"
  echo "LURA_ALLOWED_ORIGINS=http://localhost:$PORT,http://lura.com:$PORT"
  echo "LURA_COOLOFF=${E2E_COOLOFF:-15s}"
  echo "LURA_LOG_LEVEL=debug"
  # A suite that checks push delivery runs its own webhook sink.
  if [ -n "${LURA_WEBHOOK_URL:-}" ]; then echo "LURA_WEBHOOK_URL=$LURA_WEBHOOK_URL"; fi
  if [ "$provider" = "mappls" ]; then
    echo "LURA_MAP_PROVIDER=mappls"
    echo "LURA_MAPPLS_WEB_KEY=${LURA_MAPPLS_WEB_KEY:-}"
  fi
}

start_server() {
  local provider="$1" logfile="$2"
  stop_port
  # shellcheck disable=SC2046
  env $(server_env "$provider" | tr '\n' ' ') "$OUT/lura" >"$logfile" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 100); do
    if curl -fsS "http://localhost:$PORT/readyz" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "e2e: server did not become ready"; tail -40 "$logfile"; exit 1
}

stop_server() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; fi
  SERVER_PID=""
}
trap stop_server EXIT

# ---------------------------------------------------------------- run
ensure_keycloak
build

status=0
for phase in $PHASES; do
  base="http://localhost:$PORT"
  if [ "$phase" = "mappls" ]; then
    if [ -z "${LURA_MAPPLS_WEB_KEY:-}" ]; then
      echo "e2e: LURA_MAPPLS_WEB_KEY not set, skipping the Mappls phase"
      continue
    fi
    base="http://lura.com:$PORT"
  fi
  log "phase $phase: $base"
  mkdir -p "$OUT/$phase"
  start_server "$phase" "$OUT/$phase/server.log"
  if ! E2E_BASE="$base" E2E_API="http://localhost:$PORT" E2E_PORT="$PORT" E2E_PROVIDER="$phase" E2E_OUT="$OUT/$phase" E2E_LURASIM="$OUT/lurasim" \
    node "$ROOT/e2e/${E2E_SUITE:-scenario}.mjs"; then
    status=1
  fi
  stop_server
done

if [ "${E2E_KEEP_RUNNING:-0}" = "1" ]; then
  provider="maplibre"
  [ -n "${LURA_MAPPLS_WEB_KEY:-}" ] && provider="mappls"
  log "leaving Lura running on :$PORT ($provider)"
  stop_port
  # shellcheck disable=SC2046
  nohup env $(server_env "$provider" | grep -v LURA_COOLOFF | grep -v LURA_LOG_LEVEL | tr '\n' ' ') \
    "$OUT/lura" >"$OUT/server-final.log" 2>&1 &
  disown || true
fi

log "results: $OUT"
exit $status

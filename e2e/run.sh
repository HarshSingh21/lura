#!/usr/bin/env bash
# End-to-end run: Keycloak users, a fresh build, a fresh server, two browsers.
#
#   e2e/run.sh                 # MapLibre on localhost, then Mappls on lura.com if a key is set
#   E2E_PHASES=maplibre e2e/run.sh
#   E2E_PORT=8091 e2e/run.sh       # its own server, so several runs can go at once
#   E2E_STEPS=6,8 E2E_SEED=1 e2e/run.sh   # only those steps; step 4's fences come from the API
#   E2E_KEEP_RUNNING=1 e2e/run.sh   # leave Lura on :$E2E_PORT (default 8080) serving the build afterwards
#   E2E_SUITE=edge-sync E2E_PORT=8096 e2e/run.sh   # the edge-case suite (e2e/edge.sh)
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
SUITE="${E2E_SUITE:-scenario}"
case "$SUITE" in
  scenario) ;;
  edge-sync) PHASES="maplibre" ;; # the edge cases are about sync, not basemaps
  *) echo "e2e: unknown E2E_SUITE=$SUITE (scenario | edge-sync)"; exit 2 ;;
esac
# The web build the server serves. The edge suite builds its own, against its
# own Keycloak client, so it never overwrites client/dist under another run.
WEB_DIR="$ROOT/client/dist"
[ "$SUITE" = "edge-sync" ] && WEB_DIR="${E2E_WEB_DIR:-$OUT/web}"
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
  ensure_redirects lura-app
  if [ "$SUITE" = "edge-sync" ]; then ensure_edge_client; fi
}

# ensure_redirects lets a client (lura-app, or the edge suite's lura-app-edge)
# sign in and out on this run's port, on both names the phases use, by adding (never replacing) its redirect URIs,
# web origins and post-logout URIs. A realm imported for :8080 has no others, so
# without this any other E2E_PORT fails at Keycloak's "Invalid redirect_uri".
ensure_redirects() {
  local client="$1" kc=(docker exec "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh) id current wanted
  id="$("${kc[@]}" get clients -r lura -q "clientId=$client" --fields id 2>/dev/null |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);process.stdout.write(c[0]?c[0].id:"")})')"
  if [ -z "$id" ]; then
    echo "e2e: the lura realm has no $client client" >&2
    exit 1
  fi
  # Whole client: kcadm's --fields drops attribute keys that contain dots.
  current="$("${kc[@]}" get "clients/$id" -r lura)"
  # Prints the merged client, or nothing when every URI is already there.
  wanted="$(PORT="$PORT" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const c = JSON.parse(s);
      const hosts = [`http://localhost:${process.env.PORT}`, `http://lura.com:${process.env.PORT}`];
      const add = (list, items) => [...list, ...items.filter((i) => !list.includes(i))];
      const redirectUris = add(c.redirectUris ?? [], hosts.map((h) => `${h}/*`));
      const webOrigins = add(c.webOrigins ?? [], hosts);
      const logout = (c.attributes?.["post.logout.redirect.uris"] ?? "").split("##").filter(Boolean);
      const postLogout = add(logout, hosts.map((h) => `${h}/*`));
      const changed =
        redirectUris.length !== (c.redirectUris ?? []).length ||
        webOrigins.length !== (c.webOrigins ?? []).length ||
        postLogout.length !== logout.length;
      if (changed) {
        process.stdout.write(JSON.stringify({
          redirectUris,
          webOrigins,
          attributes: { "post.logout.redirect.uris": postLogout.join("##") },
        }));
      }
    });' <<<"$current")"
  if [ -n "$wanted" ]; then
    # stdin reaches kcadm only with docker exec -i.
    docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh update "clients/$id" -r lura -f - <<<"$wanted" >/dev/null
    echo "keycloak: $client now accepts :$PORT on localhost and lura.com"
  fi
}

# ensure_edge_client creates lura-app-edge: lura-app's twin with 60 s access
# tokens, so the token-expiry case can watch the app outlive several token
# lifetimes without touching the realm or lura-app. Defined in
# e2e/keycloak-edge-client.json; idempotent, and safe to delete from Keycloak at
# any time (the next edge run recreates it). Its redirects follow the run's port
# like lura-app's do.
ensure_edge_client() {
  local kc=(docker exec "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh)
  if [ "$("${kc[@]}" get clients -r lura -q clientId=lura-app-edge --fields id 2>/dev/null | grep -c '"id"')" = "0" ]; then
    docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh create clients -r lura -f - \
      <"$ROOT/e2e/keycloak-edge-client.json" >/dev/null
    echo "keycloak: created client lura-app-edge"
  fi
  ensure_redirects lura-app-edge
}

# ---------------------------------------------------------------- build
build() {
  if [ "$SUITE" = "edge-sync" ] && { [ "${E2E_SKIP_BUILD:-0}" != "1" ] || [ ! -f "$WEB_DIR/index.html" ]; }; then
    log "build: web client for lura-app-edge → $WEB_DIR"
    (cd "$ROOT/client" && node scripts/copy-maplibre-worker.mjs >/dev/null &&
      EXPO_PUBLIC_KEYCLOAK_CLIENT_ID=lura-app-edge npx expo export --platform web --output-dir "$WEB_DIR" \
        >"$OUT/build-web.log" 2>&1) || { tail -40 "$OUT/build-web.log"; exit 1; }
    grep -rlq lura-app-edge "$WEB_DIR/_expo" || { echo "e2e: the web build does not use lura-app-edge"; exit 1; }
  elif [ "${E2E_SKIP_BUILD:-0}" != "1" ]; then
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
  echo "LURA_WEB_DIR=$WEB_DIR"
  echo "LURA_ALLOWED_ORIGINS=http://localhost:$PORT,http://lura.com:$PORT"
  echo "LURA_COOLOFF=${E2E_COOLOFF:-15s}"
  echo "LURA_LOG_LEVEL=debug"
  if [ "$SUITE" = "edge-sync" ]; then
    # Short, so the stale-fix case can post a fix older than it.
    echo "LURA_FRESH_WINDOW=${E2E_FRESH_WINDOW:-2m}"
  fi
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
    node "$ROOT/e2e/$SUITE.mjs"; then
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

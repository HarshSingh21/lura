#!/usr/bin/env bash
# End-to-end run: Keycloak users, a fresh build, a fresh server, two browsers.
#
#   e2e/run.sh                 # MapLibre on localhost, then Mappls on lura.com if a key is set
#   E2E_PHASES=maplibre e2e/run.sh
#   E2E_PORT=8091 e2e/run.sh       # its own server, so several runs can go at once
#   E2E_STEPS=6,8 E2E_SEED=1 e2e/run.sh   # only those steps; step 4's fences come from the API
#   E2E_KEEP_RUNNING=1 e2e/run.sh   # leave Lura on :$E2E_PORT (default 8080) serving the build afterwards
#   E2E_SUITE=edge-sync E2E_PORT=8096 e2e/run.sh        # the sync edge cases (or: e2e/edge.sh sync)
#   E2E_SUITE=edge-fences-ui E2E_PORT=8097 e2e/run.sh   # fences, notifications, screens (e2e/edge.sh fences-ui)
#   E2E_SUITE=uc-session E2E_STORE=postgres E2E_PORT=8097 caffeinate -ims e2e/run.sh
#                                # long sessions: 25 min on lura-app's 15 min tokens, 6 min on
#                                # lura-app-edge's 60 s tokens, a laptop sleep in each (phases
#                                # "app" and "edge"; E2E_PHASES=edge runs one)
#   E2E_STORE=postgres E2E_PORT=8091 e2e/run.sh   # against a throwaway PostGIS instead of memory
#   E2E_STORE=postgres E2E_KEEP_DB=1 e2e/run.sh   # ... and leave the database container afterwards
#   E2E_SKIP_BUILD=1 E2E_WEB_DIR=/tmp/web e2e/run.sh   # serve a web build made earlier
#
# Postgres (E2E_STORE=postgres): the run starts its own PostGIS container,
# lura-e2e-pg-$E2E_PORT (ghcr.io/baosystems/postgis:17-3.5, or $E2E_PG_IMAGE),
# on 127.0.0.1:5$E2E_PORT (58091 for 8091), waits until PostGIS answers, and
# gives each phase a fresh database of its own (lura_maplibre, lura_mappls) that
# Lura migrates on boot. The container is removed at the end unless
# E2E_KEEP_DB=1; one left over from an earlier run on the same port is replaced.
#
# Restarting Lura mid-run: each phase writes $E2E_OUT/<phase>/restart.sh and
# hands its path to the suite as E2E_RESTART. Running it stops this phase's
# Lura (gracefully, as a deploy would), optionally waits E2E_DOWN_MS, starts it
# again with the same environment — and, with Postgres, the same database — and
# returns once /readyz answers. Suites call it through restartServer() in
# e2e/lib/server.mjs; E2E_STORE tells them whether data survives it.
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
  edge-sync | edge-fences-ui) PHASES="maplibre" ;; # edge cases, not basemaps
  # One phase per Keycloak client, MapLibre in both: "app" signs in through
  # lura-app (15 min tokens), "edge" through lura-app-edge (60 s tokens).
  uc-session) PHASES="${E2E_PHASES:-app edge}" ;;
  *) echo "e2e: unknown E2E_SUITE=$SUITE (scenario | edge-sync | edge-fences-ui | uc-session)"; exit 2 ;;
esac
STORE="${E2E_STORE:-memory}"
case "$STORE" in
  memory | postgres) ;;
  *) echo "e2e: unknown E2E_STORE=$STORE (memory | postgres)"; exit 2 ;;
esac
# The web build the server serves: every run builds its own (the edge-sync one
# against its own Keycloak client), so runs on different ports never overwrite
# each other's bundle mid-run.
WEB_DIR="${E2E_WEB_DIR:-$OUT/web}"
PG_CONTAINER="lura-e2e-pg-$PORT"
PG_PORT="5$PORT"
PG_IMAGE="${E2E_PG_IMAGE:-ghcr.io/baosystems/postgis:17-3.5}"
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
  if [ "$SUITE" = "edge-sync" ] || [ "$SUITE" = "uc-session" ]; then ensure_edge_client; fi
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
# build_web DIR [CLIENT_ID] exports the web client into DIR, signing in through
# CLIENT_ID (lura-app when empty).
build_web() {
  local dir="$1" client_id="${2:-}"
  if [ "${E2E_SKIP_BUILD:-0}" != "1" ] || [ ! -f "$dir/index.html" ]; then
    log "build: web client${client_id:+ for $client_id} → $dir"
    (cd "$ROOT/client" && node scripts/copy-maplibre-worker.mjs >/dev/null &&
      env ${client_id:+EXPO_PUBLIC_KEYCLOAK_CLIENT_ID=$client_id} npx expo export --platform web --output-dir "$dir" \
        >"$OUT/build-web${client_id:+-$client_id}.log" 2>&1) || { tail -40 "$OUT/build-web${client_id:+-$client_id}.log"; exit 1; }
    if [ -n "$client_id" ]; then
      grep -rlq "$client_id" "$dir/_expo" || { echo "e2e: the web build in $dir does not use $client_id"; exit 1; }
    fi
  fi
}

# web_dir_for PHASE is the build a phase serves: uc-session's "edge" phase has
# one of its own, signed in through lura-app-edge.
web_dir_for() {
  if [ "$SUITE" = "uc-session" ] && [ "$1" = "edge" ]; then echo "$OUT/web-edge"; else echo "$WEB_DIR"; fi
}

build() {
  case "$SUITE" in
    edge-sync) build_web "$WEB_DIR" lura-app-edge ;;
    uc-session)
      case " $PHASES " in *" app "*) build_web "$WEB_DIR" ;; esac
      case " $PHASES " in *" edge "*) build_web "$(web_dir_for edge)" lura-app-edge ;; esac
      ;;
    *) build_web "$WEB_DIR" ;;
  esac
  log "build: server and simulator"
  (cd "$ROOT" && go build -o "$OUT/lura" ./cmd/lura && go build -o "$OUT/lurasim" ./cmd/lurasim)
  if [ ! -d "$ROOT/e2e/node_modules/playwright-core" ]; then
    (cd "$ROOT/e2e" && npm install --no-audit --no-fund >/dev/null)
  fi
}

# ---------------------------------------------------------------- database
pg() { docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U lura -d postgres -tAq "$@"; }

# start_db starts this port's PostGIS container and waits until it serves TCP
# with the extension available. pg_isready over the socket says yes during the
# image's init pass, which then restarts the server; over TCP it does not.
start_db() {
  log "postgres: $PG_CONTAINER on 127.0.0.1:$PG_PORT ($PG_IMAGE)"
  docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$PG_CONTAINER" --label lura-e2e=1 \
    -e POSTGRES_USER=lura -e POSTGRES_PASSWORD=lura -e POSTGRES_DB=lura \
    -p "127.0.0.1:$PG_PORT:5432" "$PG_IMAGE" >/dev/null
  for _ in $(seq 1 120); do
    if docker exec "$PG_CONTAINER" pg_isready -h 127.0.0.1 -U lura -d lura >/dev/null 2>&1 &&
      [ "$(pg -c "SELECT count(*) FROM pg_available_extensions WHERE name = 'postgis'" 2>/dev/null)" = "1" ]; then
      return 0
    fi
    sleep 0.5
  done
  echo "e2e: postgres did not become ready"; docker logs --tail 40 "$PG_CONTAINER"; exit 1
}

# fresh_db gives a phase an empty database of its own.
fresh_db() {
  local db="$1"
  pg -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null
  pg -c "CREATE DATABASE $db OWNER lura" >/dev/null
}

stop_db() {
  [ "$STORE" = "postgres" ] || return 0
  # A server left running (E2E_KEEP_RUNNING) needs its database too.
  if [ "${E2E_KEEP_DB:-0}" = "1" ] || [ "${E2E_KEEP_RUNNING:-0}" = "1" ]; then
    log "postgres: keeping $PG_CONTAINER (127.0.0.1:$PG_PORT; docker rm -f $PG_CONTAINER when done)"
  else
    docker rm -f "$PG_CONTAINER" >/dev/null 2>&1 || true
  fi
}

# ---------------------------------------------------------------- server
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

# server_env prints the environment for one provider (and, with Postgres, the
# database it uses). The geofence cool-off is shortened so the pause/resume step
# can watch the same fence fire twice in one run; everything else is the
# product default.
server_env() {
  local provider="$1" db="${2:-}"
  echo "LURA_HTTP_ADDR=:$PORT"
  echo "LURA_OIDC_ISSUER=$KC_URL/realms/lura"
  echo "LURA_OIDC_AUDIENCE=lura-api"
  echo "LURA_WEB_DIR=$(web_dir_for "$provider")"
  echo "LURA_ALLOWED_ORIGINS=http://localhost:$PORT,http://lura.com:$PORT"
  echo "LURA_COOLOFF=${E2E_COOLOFF:-15s}"
  echo "LURA_LOG_LEVEL=debug"
  if [ "$STORE" = "postgres" ]; then
    echo "LURA_STORE=postgres"
    echo "LURA_DATABASE_URL=postgres://lura:lura@127.0.0.1:$PG_PORT/$db?sslmode=disable"
  fi
  if [ "$SUITE" = "edge-sync" ]; then
    # Short, so the stale-fix case can post a fix older than it.
    echo "LURA_FRESH_WINDOW=${E2E_FRESH_WINDOW:-2m}"
  fi
  # A suite that checks push delivery runs its own webhook sink.
  if [ -n "${LURA_WEBHOOK_URL:-}" ]; then echo "LURA_WEBHOOK_URL=$LURA_WEBHOOK_URL"; fi
  if [ "$provider" = "mappls" ]; then
    echo "LURA_MAP_PROVIDER=mappls"
    echo "LURA_MAPPLS_WEB_KEY=${LURA_MAPPLS_WEB_KEY:-}"
  fi
}

# write_restart writes the phase's restart.sh: the one place that starts Lura,
# used for the first start too, so a restart is exactly the same launch. It
# keeps the pid in server.pid and appends to server.log.
write_restart() {
  local dir="$1" provider="$2" db="$3" script="$1/restart.sh"
  {
    echo '#!/usr/bin/env bash'
    echo '# Written by e2e/run.sh: (re)start this phase'"'"'s Lura with the same environment.'
    echo 'set -euo pipefail'
    printf 'DIR=%q PORT=%q BIN=%q\n' "$dir" "$PORT" "$OUT/lura"
    printf 'ENVS=('; server_env "$provider" "$db" | while IFS= read -r line; do printf '%q ' "$line"; done; echo ')'
    cat <<'SCRIPT'
if [ -f "$DIR/server.pid" ]; then
  pid="$(cat "$DIR/server.pid")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$DIR/server.pid"
fi
for _ in $(seq 1 50); do lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1 || break; sleep 0.1; done
[ "${E2E_DOWN_MS:-0}" -gt 0 ] && sleep "$(awk "BEGIN { print ${E2E_DOWN_MS} / 1000 }")"
[ "${1:-}" = "stop" ] && exit 0
echo "== e2e: (re)starting Lura at $(date -u +%H:%M:%S) UTC" >>"$DIR/server.log"
nohup env "${ENVS[@]}" "$BIN" >>"$DIR/server.log" 2>&1 &
echo $! >"$DIR/server.pid"
for _ in $(seq 1 150); do
  if curl -fsS "http://localhost:$PORT/readyz" >/dev/null 2>&1; then exit 0; fi
  kill -0 "$(cat "$DIR/server.pid")" 2>/dev/null || break
  sleep 0.2
done
echo "e2e: server did not become ready" >&2; tail -40 "$DIR/server.log" >&2; exit 1
SCRIPT
  } >"$script"
  chmod +x "$script"
  RESTART="$script"
}

PHASE_DIR=""
start_server() {
  local provider="$1" dir="$2" db=""
  stop_port
  if [ "$STORE" = "postgres" ]; then
    db="lura_$provider"
    fresh_db "$db"
  fi
  : >"$dir/server.log"
  write_restart "$dir" "$provider" "$db"
  PHASE_DIR="$dir"
  "$RESTART"
}

stop_server() {
  if [ -n "$PHASE_DIR" ] && [ -x "$PHASE_DIR/restart.sh" ]; then "$PHASE_DIR/restart.sh" stop || true; fi
  PHASE_DIR=""
}
trap 'stop_server; stop_db' EXIT

# ---------------------------------------------------------------- run
ensure_keycloak
build
[ "$STORE" = "postgres" ] && start_db

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
  start_server "$phase" "$OUT/$phase"
  if ! E2E_BASE="$base" E2E_API="http://localhost:$PORT" E2E_PORT="$PORT" E2E_PROVIDER="$phase" E2E_OUT="$OUT/$phase" E2E_LURASIM="$OUT/lurasim" \
    E2E_STORE="$STORE" E2E_RESTART="$RESTART" E2E_PHASE="$phase" node "$ROOT/e2e/$SUITE.mjs"; then
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
  nohup env $(server_env "$provider" "lura_$provider" | grep -v LURA_COOLOFF | grep -v LURA_LOG_LEVEL | tr '\n' ' ') \
    "$OUT/lura" >"$OUT/server-final.log" 2>&1 &
  disown || true
fi

log "results: $OUT"
exit $status

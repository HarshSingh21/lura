# Lura — one image containing the Go monolith and the built web client.
#
# The web bundle is baked in and served by the Go binary (LURA_WEB_DIR), so a
# Phase 1 deployment is a single container on a single origin: no separate static
# host, no CORS to configure, one thing to run. The mobile app talks to the same
# API over the network.

# ---------------------------------------------------------------- web client
FROM node:22-alpine AS web
WORKDIR /client

# Dependencies first: this layer only changes when the lockfile does.
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY client/ ./
# `expo export` produces a static SPA in dist/. The API base URL is resolved at
# runtime from window.location, so the same bundle works on any host.
RUN npx expo export --platform web --output-dir dist

# ---------------------------------------------------------------- server
FROM golang:1.26-alpine AS build
WORKDIR /src

# Module cache layer.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
ARG VERSION=0.1.0-phase1
# CGO off for a static binary; trimpath and -s -w keep the image small, and the
# version is stamped so /version and every span match the build.
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags "-s -w -X main.version=${VERSION}" \
    -o /out/lura ./cmd/lura \
 && CGO_ENABLED=0 GOOS=linux go build \
    -trimpath -ldflags "-s -w" \
    -o /out/lurasim ./cmd/lurasim

# A tiny healthcheck binary: the runtime image has no curl or wget, and probing
# with the app's own code is more honest than shelling out anyway.
RUN printf '%s\n' \
    'package main' \
    '' \
    'import (' \
    '	"net/http"' \
    '	"os"' \
    '	"time"' \
    ')' \
    '' \
    '// Probes /readyz, which reports on dependencies rather than just liveness.' \
    'func main() {' \
    '	client := &http.Client{Timeout: 3 * time.Second}' \
    '	resp, err := client.Get("http://127.0.0.1:8080/readyz")' \
    '	if err != nil {' \
    '		os.Exit(1)' \
    '	}' \
    '	defer resp.Body.Close()' \
    '	if resp.StatusCode != http.StatusOK {' \
    '		os.Exit(1)' \
    '	}' \
    '}' \
    > /tmp/healthcheck.go \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w" -o /out/lura-healthcheck /tmp/healthcheck.go

# ---------------------------------------------------------------- runtime
FROM alpine:3.21
# ca-certificates for outbound TLS (ntfy, tiles) and tzdata because quiet hours
# are evaluated in the user's timezone — without it every zone falls back to UTC.
RUN apk add --no-cache ca-certificates tzdata \
 && adduser -D -H -u 10001 lura

COPY --from=build /out/lura /lura
COPY --from=build /out/lurasim /lurasim
COPY --from=build /out/lura-healthcheck /lura-healthcheck
COPY --from=web /client/dist /web

USER lura
EXPOSE 8080

ENV LURA_HTTP_ADDR=":8080" \
    LURA_WEB_DIR="/web" \
    LURA_LOG_FORMAT="json"

# The binary handles SIGTERM itself (graceful shutdown drains the workers), so it
# is PID 1 without an init shim.
ENTRYPOINT ["/lura"]

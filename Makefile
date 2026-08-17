# Lura — Phase 1
#
# `make run` needs nothing installed; everything else is opt-in.

GO      ?= go
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo 0.1.0-phase1)
LDFLAGS := -s -w -X main.version=$(VERSION)

.DEFAULT_GOAL := help

## help: list the targets
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //' | awk -F': ' '{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

## run: server with the in-memory store and a seeded demo workspace
run:
	LURA_STORE=memory $(GO) run ./cmd/lura

## run-pg: server against PostgreSQL/PostGIS (see deploy/docker-compose.yml)
run-pg:
	LURA_STORE=postgres $(GO) run ./cmd/lura

## sim: drive a virtual device around the seeded places
sim:
	$(GO) run ./cmd/lurasim -interval 500ms -scale 30

## test: unit and integration tests with the race detector
test:
	$(GO) test -race ./...

## test-pg: also run the store conformance suite against a real database
test-pg:
	LURA_TEST_DATABASE_URL=$${LURA_TEST_DATABASE_URL:-postgres://lura:lura@localhost:5432/lura?sslmode=disable} \
		$(GO) test -race ./internal/store/...

## lint: vet the Go code and typecheck the client
lint:
	$(GO) vet ./...
	gofmt -l cmd internal | (! grep .) || (echo "gofmt needed on the files above"; exit 1)
	cd client && npx tsc --noEmit

## build: server binaries into bin/
build:
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/lura ./cmd/lura
	CGO_ENABLED=0 $(GO) build -trimpath -ldflags "$(LDFLAGS)" -o bin/lurasim ./cmd/lurasim

## web: build the Expo web bundle into client/dist
web:
	cd client && npm run build:web

## serve: build the web bundle and serve it from the Go binary on one origin
serve: web
	LURA_STORE=memory $(GO) run ./cmd/lura -web ./client/dist

## client: Expo dev server (press w for web, i/a for a device)
client:
	cd client && npm start

## up: the Phase 1 deployment (PostGIS + ntfy + Lura)
up:
	cd deploy && docker compose up -d --build

## up-obs: the deployment plus the full observability stack
up-obs:
	cd deploy && docker compose --profile obs up -d --build

## down: stop the deployment
down:
	cd deploy && docker compose down

## clean: remove build output
clean:
	rm -rf bin client/dist

.PHONY: help run run-pg sim test test-pg lint build web serve client up up-obs down clean

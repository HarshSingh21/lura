# Open-source inventory

Lura is open source end to end, and so is everything it runs on. This document is
the evidence for that claim: every dependency, its licence, and — where a
tempting alternative is not open source — why it was rejected.

Two rules were applied while choosing:

1. **OSI-approved licences only.** No source-available licences (SSPL, BSL,
   Elastic v2), no proprietary SDKs.
2. **Nothing that requires a hosted third party to work.** Every component can run
   on the operator's own hardware, which is what makes the airgap switch a real
   guarantee rather than a setting.

---

## Runtime — server

| Component | Licence | Role |
|---|---|---|
| Go | BSD-3-Clause | language and runtime |
| `go-chi/chi` | MIT | HTTP router |
| `coder/websocket` | ISC | WebSocket server and client |
| `jackc/pgx` | MIT | PostgreSQL driver and pool |
| PostgreSQL | PostgreSQL licence | database |
| PostGIS | GPL-2.0-or-later | spatial types, `ST_DWithin`, GIST indexes |
| TimescaleDB *(optional)* | Apache-2.0 (community edition is TSL) | hypertable, compression — only the Apache-licensed features are used, and it is optional |
| OpenTelemetry Go SDK + OTLP exporters | Apache-2.0 | traces, metrics, logs |
| `prometheus/client_golang` | Apache-2.0 | `/metrics` endpoint |
| ntfy | Apache-2.0 / GPL-2.0 | push notifications, self-hostable |

## Runtime — client

| Component | Licence | Role |
|---|---|---|
| React, React Native, react-native-web | MIT | UI runtime on three surfaces |
| Expo, Expo Router | MIT | toolchain, routing, native modules |
| MapLibre GL JS | BSD-3-Clause | web map renderer |
| `@maplibre/maplibre-react-native` | BSD-3-Clause | native map renderer |
| `react-native-svg` | MIT | icons and the fallback basemap |
| TanStack Query | MIT | server state |
| Zustand | MIT | local state |
| React Hook Form | MIT | forms |
| Zod | MIT | validation shared with the API contract |
| Space Grotesk, JetBrains Mono | SIL OFL 1.1 / Apache-2.0 | typography, bundled not fetched |

## Infrastructure (compose)

| Component | Licence | Role |
|---|---|---|
| OpenTelemetry Collector (contrib) | Apache-2.0 | telemetry routing |
| OpenSearch + OpenSearch Dashboards | Apache-2.0 | log storage and search |
| Jaeger | Apache-2.0 | trace storage and UI |
| Prometheus | Apache-2.0 | metrics storage |
| Grafana | AGPL-3.0 | dashboards (AGPL — still open source; swap for Perses if that matters to you) |

## Maps and geocoding

| Component | Licence | Role |
|---|---|---|
| OpenStreetMap data | ODbL 1.0 | map data (attribution is rendered on every map) |
| OpenFreeMap | free/open tile hosting | Phase 1 default style |
| Protomaps / PMTiles | BSD-3-Clause | Phase 2 self-hosted tiles |
| Photon | Apache-2.0 | Phase 2 self-hosted geocoding |

---

## Deliberately rejected

| Alternative | Why not |
|---|---|
| Elasticsearch | Elastic v2 / SSPL — not OSI-approved. **OpenSearch** (Apache-2.0) is the fork that stayed open. |
| Mapbox GL JS ≥ 2 | proprietary licence and a required access token. **MapLibre** is the BSD fork. |
| Google Maps / Places | proprietary, per-request billing, and every request is a location leak to a third party. |
| Hosted LLM APIs | note text and place names would leave the operator's infrastructure — the one thing the product promises never happens by default. |
| Firebase / FCM as the only push path | Google-services dependency; Lura's default is self-hosted ntfy, with FCM/APNs as *optional* Phase 2 channels. |
| Redis ≥ 7.4 | RSALv2/SSPL. Phase 2 uses **Valkey** (BSD-3-Clause), the Linux Foundation fork. |
| HashiCorp Vault | BSL since 1.15. Phase 2 uses **OpenBao** (MPL-2.0). |
| Auth0 / Firebase Auth | proprietary and hosted. Phase 2 uses **Zitadel** (Apache-2.0), self-hostable. |
| what3words | proprietary address scheme. **Plus Codes** (Apache-2.0) are the open equivalent. |

---

## Licence obligations we actually meet

- **OpenStreetMap (ODbL)** requires attribution: every map view renders
  "Protomaps · OpenStreetMap · MapLibre", and the native renderer keeps
  MapLibre's attribution ornament enabled.
- **PostGIS (GPL-2.0)** is used as a database extension over a network protocol,
  not linked into this binary.
- **Grafana (AGPL-3.0)** ships only as an unmodified upstream container image.
- **Fonts (OFL)** are redistributed as bundled assets under their own licence,
  unmodified.

Lura itself is Apache-2.0.

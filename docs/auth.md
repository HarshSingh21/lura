# Lura — Authentication

**Version:** 1.0 · **Scope:** who a request is, and how the server knows.

Phase 1 authenticates the control plane with one static bearer token
(`docs/lura_lld_phase1.md` §1, `internal/auth`). That was always a placeholder:
HLD §16 maps Phase 2 to JWTs from an identity provider. This note is the design
of that step and the reasoning behind the realm in
[`deploy/keycloak/lura-realm.json`](../deploy/keycloak/lura-realm.json). The
operational half — start it, enable Google, enrol TOTP — is
[`deploy/keycloak/README.md`](../deploy/keycloak/README.md).

---

## 1. What changed

| | Phase 1 | Now |
|---|---|---|
| Control plane | one shared `LURA_API_TOKEN`, one workspace | OIDC access token per user, per device |
| Who issues it | `-e LURA_API_TOKEN=...` | Keycloak realm `lura` |
| How it is checked | constant-time string compare | RS256 signature against the realm JWKS, plus `iss`, `aud`, `exp` |
| Second factor | none possible | TOTP, per user, self-enrolled |
| Sign-in with Google / X | none possible | brokered by Keycloak; Lura never sees the account |
| `POST /pub` | per-device token | **unchanged** — see §7 |
| Share links | unauthenticated by design | **unchanged** |

The static token was not wrong for Phase 1; it was *one credential*, and one
credential cannot express "Aravind's phone, but not Nistha's", cannot be revoked
for one device, and cannot carry a second factor. Every one of those is a
property of the token, not of the code that checks it — which is why this change
lands behind `auth.Authenticator` and touches nothing else.

---

## 2. The flow

```
 Expo app                     Keycloak (:8085)                 Go API (:8080)
    │                              │                                │
    ├─ 1. authorize + PKCE ───────▶│  browser / ASWebAuthSession
    │      code_challenge=S256     │  password → (TOTP) → (Google, X)
    │                              │
    │◀─ 2. redirect ?code=… ───────┤  lura://  exp://  http://localhost:8081/…
    │                              │
    ├─ 3. code + code_verifier ───▶│
    │◀─ 4. access + refresh + id ──┤  access token: 15 min, aud=lura-api
    │                                                               │
    ├─ 5. Authorization: Bearer <access token> ────────────────────▶│
    │                              │◀─ 6. GET /certs (cached) ──────┤
    │◀─ 7. 200, scoped to sub ─────────────────────────────────────-┤
```

**Authorization Code + PKCE, and nothing else.** The app is a `publicClient`: an
Expo bundle ships to phones and browsers, and a client secret inside it is not a
secret. PKCE (S256, required by the realm) is what makes that safe — an
intercepted authorization code is useless without the verifier that never left
the device. The realm rejects an authorization request with no
`code_challenge_method` outright, so a client cannot quietly downgrade.

**`directAccessGrantsEnabled: false`** is the other half. With the resource owner
password grant off, there is no path where Lura's own UI collects a password.
It cannot leak what it never receives, and the login screen is the same one for a
password, a TOTP code and a Google account — which is why adding a second factor
or a social provider later needs no client change at all.

**Lifetimes.** Access tokens live 900 s; SSO sessions idle out after 30 days and
end at 60. Short access tokens keep revocation meaningful without a lookup on
every request; long sessions match the product — a location companion is signed
into once on a phone and expected to work for months.

---

## 3. What the API validates

Seven checks, all of them cheap, none of them optional — this is the contract the
verifier in `internal/auth` is written against:

1. **Signature**, RS256, against the key whose `kid` matches the token header.
2. **`alg` allowlist.** Only RS256. A validator that trusts the header's `alg`
   accepts `none`, or an HS256 token signed with the public key as the shared
   secret. This is the failure mode worth writing a test for.
3. **`iss`** equal to `http://localhost:8085/realms/lura`, compared as a whole
   string. Prefix matching on issuers is how a neighbouring realm becomes an
   authentication bypass.
4. **`aud` contains `lura-api`.** Keycloak puts it there through the
   `lura-api-audience` protocol mapper on `lura-app`; the bearer-only `lura-api`
   client is what that name refers to. Without the audience check, any token from
   any client in the realm — including a future one written by someone else —
   opens Lura's control plane.
5. **`exp` / `nbf`**, with a small skew allowance because two clocks are two
   clocks.
6. **`typ` is `Bearer`**, so an ID token cannot be presented as an access token.
7. **`sub`** is non-empty; it becomes the principal's user id (§6).

`realm_access.roles` carries `user` and, when granted, `admin`. Roles are read
from the token, never looked up — the point of a signed assertion is that the
resource server does not call the IdP on the request path.

**The JWKS cache is the one piece with real failure modes.** Fetch per request
and a Keycloak hiccup becomes a Lura outage; cache forever and key rotation locks
every user out. The rule: cache by `kid`, refresh on an unknown `kid` with a
rate limit, and keep serving the old keys while the refresh is in flight.

---

## 4. WebSocket

`/ws` already accepts `?access_token=` as well as the header (`internal/auth`,
`BearerToken`) — browsers cannot set headers on a WebSocket handshake. That
mechanism is unchanged; only the value it carries becomes a JWT.

The token is validated at the handshake. A connection then outlives its 15-minute
access token, which is the honest trade: re-authenticating a live stream
mid-flight means either buffering fixes or dropping the map. Access is not
frozen, though — the `acl.<viewer>` re-subscription path from LLD §5 already
drops a viewer's subscription when a share is revoked, on the next fix rather
than at the end of a TTL. What a long-lived socket does *not* notice today is a
logout or a disabled user, and the mitigation is a cap on connection lifetime
rather than a new mechanism.

---

## 5. Where OTP fits

Entirely inside Keycloak, and deliberately so. TOTP is a property of the login
ceremony; by the time a request reaches Lura the ceremony is over and all that
exists is a signed token. The API has no OTP code and needs none.

The realm sets the policy (TOTP, SHA1, 6 digits, 30 s, look-ahead 1, codes not
reusable) and enables the `CONFIGURE_TOTP` required action without making it
mandatory: available to everyone, forced on nobody. A user enrols from the
account console; Keycloak's default browser flow puts the OTP step behind a
*conditional* execution, so the prompt appears for exactly the users who have a
credential configured. Making it mandatory is one flag —
`"defaultAction": true` — and the README says where.

SHA1 is not a weakness here and not a compromise: RFC 6238 TOTP is HMAC-SHA1 in
every authenticator app that exists, and the security of a 30-second six-digit
code comes from its lifetime, not from its hash.

If a future endpoint needs step-up ("re-authenticate before exporting a year of
history"), the information is already in the token: Keycloak emits `acr` and the
realm can define a level-of-authentication map. That is a change in one handler,
not in the flow above.

---

## 6. Identity, and how little of the schema it touches

Every query in `internal/store` is already scoped by `user_id` — that is the
Phase 1 privacy invariant, not a new requirement. The change is only where that
string comes from: `usr_demo` from the seed under a static token, the token's
`sub` under OIDC. No table changes.

A workspace is provisioned lazily, on the first request that carries an unseen
`sub`, rather than by a registration webhook from Keycloak. The two systems then
cannot drift: a realm restored from a backup, or a user created by hand in the
admin console, works without anyone replaying an event. `email` and
`preferred_username` come from the claims and are stored for display only. Nothing keys off the e-mail address, because an address can be
changed at the identity provider and a `sub` cannot — a workspace that keys off
e-mail is a workspace that can be silently taken over by an address change.

Roles map to what Phase 1 already distinguishes:

| Realm role | Means |
|---|---|
| `user` | owns one workspace; granted to every registration through `default-roles-lura` |
| `admin` | operates the server itself; never granted by default |

`admin` exists in the realm before anything reads it, on purpose: a role that
appears at the same moment as the first endpoint that needs it always arrives in
a hurry.

---

## 7. What stays on device credentials

**`POST /pub` keeps its per-device token, and this is not a gap.** A tracker is a
phone in the background, an OwnTracks install, `cmd/lurasim`, or a battery-powered
GPS unit — none of them can open a browser, and no user is present to consent.
OAuth has an answer (the device authorization grant), and it is the wrong one
here: it still needs a human at a second screen to enrol, plus a refresh path on
a device whose whole job is to publish a point every thirty seconds over a link
that may be down for hours.

So the ingest path stays as designed in LLD §2: a per-device token, issued in
**Settings → Devices**, shown once, rotatable, accepted as a bearer, as HTTP Basic
(OwnTracks' own mode) or as a query parameter for trackers that cannot set
headers. The three principal kinds in `internal/auth` — `user`, `device`, `share`
— are what keep that safe: a device credential resolves to `KindDevice` and
`KindDevice` cannot reach the control plane, whatever it presents.

Public share links (`/s/{token}`) are also unchanged: an unauthenticated,
expiring, revocable read-only view is the feature, not an oversight.

| Path | Credential | Why |
|---|---|---|
| `/api/v1/*`, `/ws` | OIDC access token | a human with a browser |
| `/pub` | per-device token | no browser, no human, no session |
| `/s/{token}` | none | the recipient has no account, by design |

---

## 8. Why Keycloak, when the HLD says Zitadel

HLD §5.10 names Zitadel, and this deviates from it in the sense of LLD §11 — a
recorded, reasoned difference, not a drift.

What the HLD actually requires of that box is: self-hostable, open source, no
phone-home, standard OIDC. Keycloak (Apache-2.0) and Zitadel (Apache-2.0) both
qualify, and `docs/open-source.md`'s rule — nothing proprietary, nothing hosted —
holds either way. Keycloak brings a declarative realm import, which is why this
repository can carry its entire identity configuration as one reviewable file
instead of a page of console instructions; it also brings social brokering and
TOTP with no plugin.

The cost of choosing "wrong" is bounded, and that is the real argument. Lura's
server consumes three things: an issuer URL, a JWKS URL and a JWT with `sub`,
`aud` and roles. All three are OIDC, none is Keycloak. Migrating to Zitadel — or
to anything else — is a realm to recreate and configuration values to change, and
zero lines of the validator. The interface is the deliverable, exactly as in
LLD §12.

**One privacy note.** Keycloak runs on your infrastructure, so signing in makes
no outbound call. Signing in *with Google or X* does, by definition, and that
egress is the browser's and Keycloak's rather than Lura's — which puts it outside
the reach of `LURA_AIRGAP`. A deployment that means airgap literally should hide
both providers on the login page. Password plus TOTP is the airgap-clean path,
and it is the default.

---

## 9. Turning it on

| Variable | Example | Meaning |
|---|---|---|
| `LURA_OIDC_ISSUER` | `http://localhost:8085/realms/lura` | empty keeps the Phase 1 static token — the switch is one value |
| `LURA_OIDC_AUDIENCE` | `lura-api` | required in `aud` |
| `LURA_DEV_TOKEN_WITH_OIDC` | `false` | keep `LURA_API_TOKEN` working alongside real sessions |

The JWKS URL is not configuration. It comes from the issuer's discovery
document, which is the only way to be sure the keys and the `iss` string being
trusted belong to the same server.

`LURA_API_TOKEN` does not disappear when an issuer is set — it stops being
accepted. That distinction matters because a tokenless server cannot be poked
with `curl`, seeded, or driven by `cmd/lurasim`, and `docs/local-testing.md` is
written entirely in bearer tokens. `LURA_DEV_TOKEN_WITH_OIDC=true` brings it back
for exactly that, which is why its name says `DEV` twice over: a static token
that outlives development is the credential this whole note exists to retire.

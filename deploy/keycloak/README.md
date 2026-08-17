# Keycloak for Lura

`lura-realm.json` is the whole identity configuration: one realm, two clients, two
roles, the OTP policy, Google and X (Twitter) login, and two seeded test users. It
is a Keycloak **realm import** file — the realm is built from this file, not
clicked together in the admin console. If you change something in the console,
change it here too, or the next clean start loses it.

The design behind it — why Keycloak, what the Go server does with the token, what
stays on device credentials — is in [`docs/auth.md`](../../docs/auth.md).

> **The two seeded users are local-testing credentials.** `aravind@lura.local` /
> `lura-dev-1` and `nistha@lura.local` / `lura-dev-2` exist so you can sign in on
> two devices at once and watch one workspace from both. Their passwords are in a
> public repository. Delete both users before this realm is reachable by anyone
> but you.

---

## Start it

```bash
docker run --rm -p 8085:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -v "$PWD/deploy/keycloak/lura-realm.json:/opt/keycloak/data/import/lura-realm.json:ro" \
  quay.io/keycloak/keycloak:26.4 start-dev --import-realm
```

Run it from the repository root. Port **8085** is deliberate: 8080 is Lura, 8081
is the Expo dev server, 19006 is `expo start --web`.

Wait for `Realm 'lura' imported`, then:

```bash
curl -s http://localhost:8085/realms/lura/.well-known/openid-configuration | jq .issuer
# "http://localhost:8085/realms/lura"
```

Admin console: <http://localhost:8085/> → `admin` / `admin` → realm **lura**.
`start-dev` keeps everything in an in-memory H2 database, so a `docker run --rm`
throws the whole realm away on exit and re-imports it clean on the next start —
which is what you want while the configuration is still changing.

As a compose service, alongside the Phase 1 stack:

```yaml
  keycloak:
    image: quay.io/keycloak/keycloak:26.4
    container_name: lura-keycloak
    command: start-dev --import-realm
    environment:
      KC_BOOTSTRAP_ADMIN_USERNAME: ${KEYCLOAK_ADMIN:-admin}
      KC_BOOTSTRAP_ADMIN_PASSWORD: ${KEYCLOAK_ADMIN_PASSWORD:-admin}
      KC_HTTP_PORT: 8080
      # Social login: set these in deploy/.env, never in the realm file.
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID:-}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:-}
      TWITTER_CLIENT_ID: ${TWITTER_CLIENT_ID:-}
      TWITTER_CLIENT_SECRET: ${TWITTER_CLIENT_SECRET:-}
    volumes:
      - ./keycloak/lura-realm.json:/opt/keycloak/data/import/lura-realm.json:ro
    ports:
      - "${KEYCLOAK_PORT:-8085}:8080"
    restart: unless-stopped
```

`start-dev` is a development mode: no HTTPS, no persistent database, no hostname
checks. A real deployment uses `start` with `--hostname`, `--db postgres` and TLS
in front — and at that point `sslRequired` in the realm file (`external`) starts
doing its job.

---

## What is in the realm

| Thing | Value | Why |
|---|---|---|
| Realm | `lura` | issuer `http://localhost:8085/realms/lura` |
| Public client | `lura-app` | the Expo app: Authorization Code + PKCE (S256), no secret, direct grant **off** |
| API client | `lura-api` | bearer-only; the Go server is a resource, not a login |
| Realm roles | `user`, `admin` | `user` is inside `default-roles-lura`, so every registration gets it |
| OTP policy | TOTP, SHA1, 6 digits, 30 s, no code reuse | what every authenticator app implements |
| Registration | on, email as username, e-mail verification **off** | local dev has no SMTP; turn `verifyEmail` on when it does |
| Brute force | on, 10 failures | free, and this realm faces a laptop's network |

The `lura-app` client carries a protocol mapper (`lura-api-audience`, an
`oidc-audience-mapper`) that puts `lura-api` in the `aud` claim of every access
token it issues. Without it the token is addressed to nobody, and an API that
checks its audience — Lura's does — rejects it.

---

## What the Go server needs

```
issuer    http://localhost:8085/realms/lura
JWKS      http://localhost:8085/realms/lura/protocol/openid-connect/certs
discovery http://localhost:8085/realms/lura/.well-known/openid-configuration
audience  lura-api
algorithm RS256
```

Two details that bite once each:

- **JWKS returns two keys**: an `RS256`/`use=sig` key and an `RSA-OAEP`/`use=enc`
  key. Select by the `kid` in the token header, and never by "the first key".
- **`aud` is a string when there is one audience and an array when there are
  several.** A validator that only handles the array form passes today and fails
  the day a second audience mapper is added.

Everything above is `http://` because it is localhost. Over a network the issuer
must be `https://` — the string in the token has to match what the server is
configured to trust, character for character, including the scheme.

## What the Expo app needs

```
client_id     lura-app
authorization http://localhost:8085/realms/lura/protocol/openid-connect/auth
token         http://localhost:8085/realms/lura/protocol/openid-connect/token
end_session   http://localhost:8085/realms/lura/protocol/openid-connect/logout
scopes        openid profile email
PKCE          required, S256
```

Registered redirect URIs — the app's `AuthSession` redirect must match one:

| URI | Surface |
|---|---|
| `http://localhost:8080/*` | web bundle served by the Go binary |
| `http://localhost:8081/*` | `npm start` → web |
| `http://localhost:19006/*` | `expo start --web` |
| `lura://*` | development / production builds (the app's scheme) |
| `exp://*` | Expo Go |

Web origins are `+` (every redirect URI's origin) plus `http://localhost:8080`,
so the browser CORS preflight to the token endpoint succeeds from the app.

On a phone, `localhost` is the phone. Testing on a device means Keycloak has to be
reachable at the LAN address as well, which means adding
`http://192.168.x.x:19006/*` to `redirectUris` **and** starting Keycloak with
`KC_HOSTNAME` set to that address — an issuer of `http://localhost:8085/...`
cannot be reached from another machine.

---

## Enabling Google

Both identity providers are `enabled: true` in the realm and read their
credentials from environment variables (`${GOOGLE_CLIENT_ID}`,
`${GOOGLE_CLIENT_SECRET}`, `${TWITTER_CLIENT_ID}`, `${TWITTER_CLIENT_SECRET}`).
Keycloak substitutes those at import time, so setting the variables is the whole
job and no secret ever lands in the repository. Import with the variables unset
and the provider is created with the literal `${GOOGLE_CLIENT_ID}` as its client
id: the button appears on the login page and fails at Google. Set them, or hide
the provider (admin console → Identity providers → google → **Hide on login
page**).

1. <https://console.cloud.google.com/> → APIs & Services → Credentials →
   **Create credentials → OAuth client ID → Web application**.
2. Authorised redirect URI — exactly this, no trailing slash:

   ```
   http://localhost:8085/realms/lura/broker/google/endpoint
   ```

3. Export the pair before starting Keycloak:

   ```bash
   export GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   export GOOGLE_CLIENT_SECRET=...
   ```

`trustEmail` is on for Google: Google has already verified the address, so the
user is not asked to verify it again. It is off for X, which does not reliably
return one.

## Enabling X (Twitter)

1. <https://developer.x.com/> → your project → **User authentication settings**.
   Enable OAuth, request e-mail address from users if you want one.
2. Callback URI:

   ```
   http://localhost:8085/realms/lura/broker/twitter/endpoint
   ```

3. ```bash
   export TWITTER_CLIENT_ID=...      # API key / client id
   export TWITTER_CLIENT_SECRET=...  # API secret / client secret
   ```

The alias in the URL is the provider's alias in the realm file (`google`,
`twitter`), not its display name. Rename the alias and the redirect URI you
registered with the provider stops matching.

---

## Two-factor (TOTP)

The realm has `CONFIGURE_TOTP` **enabled** and not forced, which is the honest
default: available to everyone, mandatory for nobody until you decide.

**A user enrols themselves**, in about thirty seconds:

1. <http://localhost:8085/realms/lura/account/> → sign in.
2. **Account security → Signing in → Two-factor authentication →
   Authenticator application → Set up**.
3. Scan the QR with any TOTP app (FreeOTP, Aegis, Google Authenticator, 1Password)
   and type the six digits back.

From then on the browser flow asks for the code after the password — the OTP step
in Keycloak's default browser flow is *conditional*, so it appears exactly for the
users who have configured a credential.

**Force it for everyone**: admin console → Authentication → Required actions →
`Configure OTP` → **Set as default action**. Every user who registers afterwards
must enrol before their first session. In the realm file that is
`"defaultAction": true` on the `CONFIGURE_TOTP` entry.

**Force it for one user**: Users → *user* → Required user actions → `Configure
OTP`.

The policy itself (TOTP, SHA1, 6 digits, 30 s, look-ahead 1, no code reuse) is
under Authentication → Policies → OTP Policy, and is set by the realm file.
`otpPolicyCodeReusable: false` means a code cannot be replayed inside its own
30-second window — worth keeping.

---

## Changing the realm

`--import-realm` imports with the strategy **IGNORE_EXISTING**: if the realm is
already in the database, the file is skipped entirely and your edit silently does
nothing. Three ways out, in order of preference:

```bash
# 1. Throw the server away. With start-dev + --rm there is no database to keep.
docker rm -f lura-keycloak && docker run ... start-dev --import-realm

# 2. Delete the realm in the admin console, then restart the container.

# 3. Import over a persistent database:
docker exec lura-keycloak /opt/keycloak/bin/kc.sh import \
  --file /opt/keycloak/data/import/lura-realm.json --override true
```

Exporting the realm back out (Realm settings → Action → Partial export, or
`kc.sh export`) produces a much larger file: every default client scope, flow and
built-in role written out explicitly. `lura-realm.json` states only what Lura
actually decides and lets Keycloak fill in its own defaults, which is why it is
readable — don't replace it with an export.

---

## Verify it end to end

Nothing here needs the Go server or the app.

```bash
# The realm is up and says who it is
curl -s http://localhost:8085/realms/lura/.well-known/openid-configuration \
  | jq '{issuer, jwks_uri, code_challenge_methods_supported}'

# The signing key the API will fetch
curl -s http://localhost:8085/realms/lura/protocol/openid-connect/certs \
  | jq '.keys[] | {kid, alg, use}'

# Passwords cannot be exchanged for tokens directly — the app must use the browser
curl -s -X POST http://localhost:8085/realms/lura/protocol/openid-connect/token \
  -d grant_type=password -d client_id=lura-app \
  -d username=aravind@lura.local -d password=lura-dev-1
# {"error":"unauthorized_client","error_description":"Client not allowed for direct access grants"}

# PKCE is not optional either
curl -s -o /dev/null -D - "http://localhost:8085/realms/lura/protocol/openid-connect/auth\
?client_id=lura-app&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&scope=openid" \
  | grep -i ^location
# ...error=invalid_request&error_description=Missing+parameter%3A+code_challenge_method
```

Signing in as `aravind@lura.local` through a real Authorization Code + PKCE round
trip yields an access token whose payload is:

```json
{
  "iss": "http://localhost:8085/realms/lura",
  "aud": "lura-api",
  "azp": "lura-app",
  "typ": "Bearer",
  "realm_access": { "roles": ["user"] },
  "preferred_username": "aravind@lura.local"
}
```

`aud: lura-api` is the audience mapper, `realm_access.roles: ["user"]` is the
default role, and the token lives 900 seconds. That is the contract the Go
validator is written against.

---

## Version notes and manual steps

- Written for **Keycloak 26.x** (verified on 26.4). On 26.x the bootstrap admin
  variables are `KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD`;
  the older `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` are deprecated. Below
  25 the file will mostly import, but `CONFIGURE_RECOVERY_AUTHN_CODES` and the
  `basic` client scope are recent additions.
- `bearerOnly` on `lura-api` is honoured by the import and has no switch in the
  new admin console — the client simply shows every flow disabled. That is
  correct, not a broken import.
- **Only these need a human**, and only when you want them: SMTP (Realm settings
  → Email) before password reset or e-mail verification can actually deliver;
  the OAuth applications at Google and X, which no import file can create; and
  the production hostname/TLS settings, which belong to the deployment rather
  than to the realm.

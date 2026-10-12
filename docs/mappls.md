# Mappls maps (optional)

Lura draws its basemap with MapLibre and OpenFreeMap by default. A deployment can
switch to [Mappls](https://developer.mappls.com/) (MapmyIndia) instead, on the web
and on iOS and Android. Mappls is proprietary: its tiles, styles and licence
checks are calls to Mappls' servers, and usage counts against your account's
daily quota. That is why it is opt-in, why the default build does not contain it,
and why **airgap mode always overrides it**.

Only the basemap changes. Places, routes and device markers are Lura's own
overlays on every provider, so the app looks and behaves the same on any of them.

---

## 1. Get credentials

In the [Mappls console](https://auth.mappls.com/console/), create the app from
the right card on the home page: **Web** for the web key, **Mobile** for the
licence files. A **Cloud** app gets REST APIs only. Its key is refused by the map
SDK with `401 ASSET_ACCESS_DENIED "Api access denied"`, and its SDK allocation
list stays empty.

| For | App type | Download / copy | Notes |
|---|---|---|---|
| Web | Web | the **Static Key** (Credentials tab) | It is a browser key: every page that draws the map can read it, including public share links. |
| Android | Mobile | `<appId>.a.olf` + `<appId>.a.conf` | App ID must be `local.lura.app` (or whatever `android.package` is in `client/app.json`). |
| iOS | Mobile | `<appId>.i.olf` + `<appId>.i.conf` | Bundle ID must match `ios.bundleIdentifier`. |

**Whitelisting (Web app).** Mappls checks the page's domain on every SDK and tile
request, and a page served from anywhere else gets `401 "IP/Domain validation
failed"`. Enter a bare host such as `lura.example.com` (no scheme, port or
spaces). The console rejects `localhost`, so a plain `http://localhost:8080`
always falls back to MapLibre. To see Mappls tiles on your own machine, point the
whitelisted name at it (`127.0.0.1 lura.example.com` in `/etc/hosts`) and open
`http://lura.example.com:8080`.

Put the four licence files in `client/mappls/`. That directory, and any `*.olf`,
`*.a.conf` and `*.i.conf` file anywhere in the repo, are gitignored: they are
your account's secrets.

## 2. Switch the server

```bash
LURA_MAP_PROVIDER=mappls \
LURA_MAPPLS_WEB_KEY=<web access token> \
go run ./cmd/lura -web ./client/dist
```

The server tells every client, and every share-link viewer, which provider to draw
(`server.mapProvider` in `/api/v1/overview`, `map.provider` in `/s/{token}`).
With `LURA_AIRGAP=true` it reports `maplibre` and never hands out the key.

The web app needs nothing else: it loads the Mappls Web SDK
(`sdk.mappls.com/map/sdk/web?v=3.0`) only when the server says so.

## 3. Build the mobile app with Mappls

Mappls' native SDK is only linked into builds made with `LURA_MAPPLS=1`.
Without it, the build is exactly the default one, and the app uses MapLibre even
when the server says `mappls`.

```bash
cd client
LURA_MAPPLS=1 npx expo prebuild --clean
LURA_MAPPLS=1 npx expo run:android      # or run:ios
```

`LURA_MAPPLS=1` does two things:

- `react-native.config.js` links `mappls-map-react-native`.
- `plugins/with-mappls.js` adds Mappls' Maven repository on Android, hooks
  `$MAPPLS_MAPS.post_install` into the Podfile on iOS, and copies the licence
  files into the native projects. If the files are missing, prebuild stops with
  an error saying which file it needs.

Keep `LURA_MAPPLS=1` set for every native command on that checkout (prebuild,
`run:*`, `pod install`). Mixing builds with and without it leaves the native
projects out of step with autolinking, and `expo prebuild --clean` fixes that.

Expo Go cannot load either native map, so it keeps using the locally drawn map.

## How it fails

Switching providers must never leave the map empty, so every failure falls back:

| Situation | What you see |
|---|---|
| Web: key missing, rejected, SDK script blocked, or no `load` within 15 s | MapLibre basemap |
| Mobile: build made without `LURA_MAPPLS=1` | MapLibre basemap |
| Mobile: Mappls reports a map error (e.g. licence rejected) | MapLibre basemap |
| Airgap (server or user) | the locally drawn map, no network calls |

## Terms you are agreeing to

- The Mappls logo and copyright notice must stay visible. Lura leaves both on.
- Web, Android and iOS usage counts against one shared daily quota.
- Mappls' terms, not Lura's licence, cover the SDKs and the map data.

The default, open stack in [`open-source.md`](open-source.md) is unaffected when
Mappls is off.

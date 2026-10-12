// Metro configuration: Expo's defaults, with the transform cache kept per checkout.
//
// Expo's default cache lives in one shared directory (os.tmpdir()/metro-cache),
// and expo-router's route context (`expo-router/_ctx.*.js`) is cached there with
// the absolute path of *this* checkout's `app/` folder baked in. Its cache key is
// the file's own contents and its path relative to the project, so every checkout
// that shares a node_modules (git worktrees, a symlinked install) at the same
// depth gets the same key — and bundles whichever checkout's screens were
// transformed first. A worktree then ships another branch's routes and layouts
// without any error. A cache inside the project keeps every checkout honest.
//
// It is also kept per set of EXPO_PUBLIC_* values: babel inlines them into the
// transformed modules, and the cache key does not include them, so a build for
// another Keycloak client (the e2e edge suite's lura-app-edge) silently reused
// modules transformed with the previous build's client id.
const crypto = require('crypto');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const [store] = Array.isArray(config.cacheStores) ? config.cacheStores : [];
if (store) {
  // Same store class Expo picked, rooted under .expo/ (already git-ignored).
  const publicEnv = Object.keys(process.env)
    .filter((k) => k.startsWith('EXPO_PUBLIC_'))
    .sort()
    .map((k) => `${k}=${process.env[k]}`)
    .join('\n');
  const flavour = publicEnv ? crypto.createHash('sha1').update(publicEnv).digest('hex').slice(0, 12) : 'default';
  config.cacheStores = [new store.constructor({ root: path.join(__dirname, '.expo', 'metro-cache', flavour) })];
}

module.exports = config;

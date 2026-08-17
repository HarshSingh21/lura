#!/usr/bin/env node
/**
 * Place MapLibre's web worker next to the web bundle.
 *
 * MapLibre GL JS v6 ships as ES module chunks and starts its worker with
 *
 *   new Worker(new URL('./maplibre-gl-worker.mjs', import.meta.url), { type: 'module' })
 *
 * where `import.meta.url` is the URL of the *bundle that contains MapLibre*.
 * Metro inlines MapLibre into the app bundle but does not emit that sibling
 * chunk, so the browser requests
 *
 *   /_expo/static/js/web/maplibre-gl-worker.mjs      → 404
 *
 * and the map ends up with a style, sprites and no vector tiles at all: the
 * worker is what parses them. The failure is quiet — the basemap is simply
 * blank, while everything drawn on top of it (fences, markers) still renders.
 *
 * MapView.web.tsx pins the URL with MapLibre's setWorkerUrl() to
 * `<baseURI>maplibre-gl-worker.mjs`, so the chunks only need to exist at the site
 * root. This script puts them in public/ — served at the root by the Metro dev
 * server and copied to the export root by `expo export` — and, belt and braces,
 * next to the exported bundle for MapLibre builds that resolve the worker
 * themselves. The worker imports './maplibre-gl-shared.mjs', so both chunks must
 * land in the same directory.
 *
 * Run automatically by `npm run build:web` and after `npm install`.
 */

import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const projectRoot = dirname(dirname(new URL(import.meta.url).pathname));

const maplibreDist = dirname(require.resolve('maplibre-gl/dist/maplibre-gl.mjs'));
const distRoot = join(projectRoot, 'dist');
const CHUNKS = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

/** findBundleDirs returns every directory in dist/ that holds a web JS bundle. */
function findBundleDirs(root) {
  const found = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.js') && dir.includes(join('static', 'js'))) found.add(dir);
    }
  };
  if (existsSync(root)) walk(root);
  return [...found];
}

// public/ is the source of truth: the dev server serves it at the site root and
// `expo export` copies it to the export root. The dist copies cover an export
// that has already happened.
const targets = [join(projectRoot, 'public')];
if (existsSync(distRoot)) targets.push(distRoot, ...findBundleDirs(distRoot));

let copied = 0;
for (const target of targets) {
  mkdirSync(target, { recursive: true });
  for (const chunk of CHUNKS) {
    const from = join(maplibreDist, chunk);
    if (!existsSync(from)) {
      console.error(`[maplibre-worker] missing ${chunk} in ${maplibreDist}`);
      process.exit(1);
    }
    copyFileSync(from, join(target, chunk));
    copied += 1;
  }
  console.log(`[maplibre-worker] → ${relative(projectRoot, target) || '.'}`);
}

console.log(`[maplibre-worker] copied ${copied} file(s); vector tiles will parse off the main thread`);

import type { StyleSpecification } from 'maplibre-gl';

import type { BasemapId } from './types';

/**
 * The basemap catalogue: what each `BasemapId` means for each renderer.
 *
 * Kept free of React and of any runtime import so it can be tested with plain
 * `node --test` and shared by the web and native MapLibre renderers, the Mappls
 * renderers and the picker without any of them owning it.
 *
 * Every remote source below was checked to answer 200 with an
 * `Access-Control-Allow-Origin: *` header before it was listed — a style that 404s
 * is a blank map, and a tile server without CORS is a blank map that only fails
 * in the browser.
 */

export const BASEMAP_IDS: readonly BasemapId[] = ['streets', 'light', 'dark', 'satellite', 'hybrid', 'terrain'];

export const OPENFREEMAP_STYLES = 'https://tiles.openfreemap.org/styles/';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';

export const ESRI_IMAGERY = `${ESRI}World_Imagery/MapServer/tile/{z}/{y}/{x}`;
export const ESRI_PLACES = `${ESRI}Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`;
export const ESRI_ROADS = `${ESRI}Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`;
export const ESRI_TOPO = `${ESRI}World_Topo_Map/MapServer/tile/{z}/{y}/{x}`;

const ESRI_IMAGERY_CREDIT = 'Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const OFM_CREDIT = 'OpenFreeMap · OpenMapTiles · OpenStreetMap contributors';

export type BasemapInfo = {
  id: BasemapId;
  label: string;
  /** Colours for the picker's thumbnail: ground, roads, water, accent detail. */
  swatch: { ground: string; road: string; water: string; detail: string };
  /** Whether the thumbnail should carry label marks (hybrid, streets). */
  labels: boolean;
};

export const BASEMAPS: Record<BasemapId, BasemapInfo> = {
  streets: {
    id: 'streets',
    label: 'Streets',
    swatch: { ground: '#f2efe9', road: '#ffffff', water: '#a8d1e7', detail: '#f6c96b' },
    labels: true,
  },
  light: {
    id: 'light',
    label: 'Light',
    swatch: { ground: '#f7f7f5', road: '#e2e2de', water: '#d4dde3', detail: '#ecece8' },
    labels: false,
  },
  dark: {
    id: 'dark',
    label: 'Dark',
    swatch: { ground: '#1f2328', road: '#3a4048', water: '#14191f', detail: '#2c3238' },
    labels: false,
  },
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    swatch: { ground: '#4d5a3a', road: '#9a9078', water: '#21384a', detail: '#6f7650' },
    labels: false,
  },
  hybrid: {
    id: 'hybrid',
    label: 'Hybrid',
    swatch: { ground: '#4d5a3a', road: '#f2d36b', water: '#21384a', detail: '#6f7650' },
    labels: true,
  },
  terrain: {
    id: 'terrain',
    label: 'Terrain',
    swatch: { ground: '#e7e3cf', road: '#d9a46a', water: '#b5d3e7', detail: '#c4d3a4' },
    labels: false,
  },
};

export function isBasemapId(value: unknown): value is BasemapId {
  return typeof value === 'string' && (BASEMAP_IDS as readonly string[]).includes(value);
}

/**
 * maplibreStyle resolves a basemap to what MapLibre (GL JS or Native) loads: a
 * style URL, an inline raster style, or `undefined` when there is nothing remote
 * to draw (no server style configured) and the caller should use its local
 * fallback.
 *
 * "Streets" is the deployment's own style — a self-hosted Protomaps style stays
 * the default. The one exception is the shipped default, OpenFreeMap's positron:
 * that *is* the "Light" choice, so offering it twice would make Streets a no-op
 * and the picker would look broken. Streets then means OpenFreeMap's liberty,
 * which is the full-colour street map people expect from the word.
 */
export function maplibreStyle(basemap: BasemapId | undefined, serverStyleUrl?: string): string | StyleSpecification | undefined {
  switch (basemap ?? 'streets') {
    case 'light':
      return `${OPENFREEMAP_STYLES}positron`;
    case 'dark':
      return `${OPENFREEMAP_STYLES}dark`;
    case 'satellite':
      return rasterStyle('satellite', [{ id: 'imagery', tiles: ESRI_IMAGERY, maxzoom: 19, credit: ESRI_IMAGERY_CREDIT }]);
    case 'hybrid':
      return rasterStyle('hybrid', [
        { id: 'imagery', tiles: ESRI_IMAGERY, maxzoom: 19, credit: ESRI_IMAGERY_CREDIT },
        { id: 'roads', tiles: ESRI_ROADS, maxzoom: 19, credit: 'Esri', opacity: 0.85 },
        { id: 'places', tiles: ESRI_PLACES, maxzoom: 19, credit: 'Esri' },
      ]);
    case 'terrain':
      return rasterStyle('terrain', [{ id: 'topo', tiles: ESRI_TOPO, maxzoom: 19, credit: 'Esri, HERE, Garmin, USGS, OpenStreetMap contributors' }]);
    case 'streets':
    default:
      if (!serverStyleUrl) return undefined;
      if (isOpenFreeMap(serverStyleUrl, 'positron')) return `${OPENFREEMAP_STYLES}liberty`;
      return serverStyleUrl;
  }
}

/** styleKey is a cheap identity for "has the resolved style changed?". */
export function styleKey(basemap: BasemapId | undefined, serverStyleUrl?: string): string {
  return `${basemap ?? 'streets'}|${serverStyleUrl ?? ''}`;
}

function isOpenFreeMap(url: string, style: string): boolean {
  return url.replace(/\/+$/, '') === `${OPENFREEMAP_STYLES}${style}`;
}

type RasterLayer = { id: string; tiles: string; maxzoom: number; credit: string; opacity?: number };

/**
 * rasterStyle builds a MapLibre style from raster tile layers, bottom first.
 *
 * Glyphs are not needed (no symbol layers), and `maxzoom` on the source makes
 * MapLibre overzoom the last real level instead of requesting tiles Esri does not
 * have, which would otherwise come back as "Map data not yet available" images.
 */
function rasterStyle(name: string, layers: RasterLayer[]): StyleSpecification {
  const sources: StyleSpecification['sources'] = {};
  for (const layer of layers) {
    sources[`lura-${name}-${layer.id}`] = {
      type: 'raster',
      tiles: [layer.tiles],
      tileSize: 256,
      maxzoom: layer.maxzoom,
      attribution: layer.credit,
    };
  }
  return {
    version: 8,
    name: `lura-${name}`,
    sources,
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#1b1f1c' } },
      ...layers.map((layer) => ({
        id: `lura-${name}-${layer.id}`,
        type: 'raster' as const,
        source: `lura-${name}-${layer.id}`,
        paint: { 'raster-opacity': layer.opacity ?? 1, 'raster-fade-duration': 120 },
      })),
    ],
  };
}

/**
 * attribution is the credit line a screen shows under the map. Imagery and
 * OpenStreetMap-derived tiles both carry a licence requirement to credit them,
 * and the credit has to follow the basemap the person actually chose.
 */
export function attribution(basemap: BasemapId | undefined, opts: { serverStyleUrl?: string; provider?: string; offline?: boolean }): string {
  if (opts.offline) return 'Local basemap · airgap mode';
  const id = basemap ?? 'streets';
  // Mappls draws its own day/night/grey styles; imagery and terrain come from
  // Esri through MapLibre when the key has no Mappls equivalent, and the Esri
  // credit is the one that must not be missing.
  if (opts.provider === 'mappls' && (id === 'streets' || id === 'light' || id === 'dark')) return 'Mappls · MapmyIndia';
  switch (id) {
    case 'satellite':
      return `Imagery © ${ESRI_IMAGERY_CREDIT}`;
    case 'hybrid':
      return `Imagery © ${ESRI_IMAGERY_CREDIT} · Labels © Esri`;
    case 'terrain':
      return '© Esri, HERE, Garmin, USGS · OpenStreetMap contributors';
    case 'light':
    case 'dark':
      return `© ${OFM_CREDIT}`;
    case 'streets':
    default:
      if (!opts.serverStyleUrl) return 'Local basemap';
      if (opts.serverStyleUrl.startsWith(OPENFREEMAP_STYLES)) return `© ${OFM_CREDIT}`;
      return 'Protomaps · OpenStreetMap · MapLibre';
  }
}

/**
 * mapplsStyleFor picks a Mappls style name for a basemap out of the names the
 * SDK says this key can use, or `undefined` when none fits.
 *
 * Mappls names its styles per account ("standard-day", "standard-night",
 * "grey-day", …) and exposes the list at runtime, so the match is on the words in
 * the name rather than on a hard-coded table that would go stale. `undefined`
 * means "Mappls cannot draw this" and the caller hands that basemap to MapLibre.
 */
export function mapplsStyleFor(basemap: BasemapId | undefined, available: readonly string[]): string | undefined {
  const names = available.filter((n) => typeof n === 'string' && n.length > 0);
  const find = (want: RegExp, avoid?: RegExp) => names.find((n) => want.test(n) && !(avoid && avoid.test(n)));
  switch (basemap ?? 'streets') {
    case 'streets':
      return find(/standard.*day|^day|default/i) ?? find(/day/i, /night|grey|gray/i);
    case 'light':
      return find(/gr[ae]y.*day|light/i) ?? find(/gr[ae]y/i, /night/i);
    case 'dark':
      return find(/night|dark/i);
    case 'satellite':
      return find(/satellite|imagery/i, /hybrid/i);
    case 'hybrid':
      return find(/hybrid/i);
    case 'terrain':
      return find(/terrain|topo/i);
    default:
      return undefined;
  }
}

/**
 * mapplsStyleNames normalises the SDK's style list, which is an array of
 * `{ name }` objects on native and, depending on the web SDK build, either
 * objects or plain strings.
 */
export function mapplsStyleNames(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === 'string' ? item : (item as { name?: unknown } | null)?.name))
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

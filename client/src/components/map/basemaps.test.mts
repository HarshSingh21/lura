import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StyleSpecification } from 'maplibre-gl';

import {
  attribution,
  BASEMAP_IDS,
  ESRI_IMAGERY,
  ESRI_PLACES,
  ESRI_TOPO,
  isBasemapId,
  maplibreStyle,
  mapplsStyleFor,
  mapplsStyleNames,
  OPENFREEMAP_STYLES,
} from './basemaps.ts';
import type { BasemapId } from './types.ts';

const SELF_HOSTED = 'https://tiles.example.org/style.json';

/** inline resolves a basemap that must be an inline style object. */
function inline(id: BasemapId): StyleSpecification {
  const style = maplibreStyle(id);
  if (!style || typeof style !== 'object') throw new Error(`${id} is not an inline style`);
  return style;
}

test('streets is the server style, and never a duplicate of light', () => {
  assert.equal(maplibreStyle('streets', SELF_HOSTED), SELF_HOSTED);
  assert.equal(maplibreStyle(undefined, SELF_HOSTED), SELF_HOSTED);
  // The shipped default is positron, which is what "light" draws.
  assert.equal(maplibreStyle('streets', `${OPENFREEMAP_STYLES}positron`), `${OPENFREEMAP_STYLES}liberty`);
  assert.equal(maplibreStyle('streets', `${OPENFREEMAP_STYLES}positron/`), `${OPENFREEMAP_STYLES}liberty`);
  // No server style: the caller's local fallback.
  assert.equal(maplibreStyle('streets', undefined), undefined);
});

test('light and dark are OpenFreeMap vector styles', () => {
  assert.equal(maplibreStyle('light', SELF_HOSTED), `${OPENFREEMAP_STYLES}positron`);
  assert.equal(maplibreStyle('dark', SELF_HOSTED), `${OPENFREEMAP_STYLES}dark`);
});

test('satellite, hybrid and terrain are inline raster styles with attribution', () => {
  const sat = inline('satellite');
  const satSources = Object.values(sat.sources);
  assert.equal(satSources.length, 1);
  assert.deepEqual((satSources[0] as { tiles: string[] }).tiles, [ESRI_IMAGERY]);
  assert.ok((satSources[0] as { attribution?: string }).attribution?.includes('Esri'));

  const hybrid = inline('hybrid');
  const tiles = Object.values(hybrid.sources).flatMap((s) => (s as { tiles: string[] }).tiles);
  assert.equal(tiles[0], ESRI_IMAGERY, 'imagery is the bottom layer');
  assert.ok(tiles.includes(ESRI_PLACES), 'hybrid carries a labels layer');
  // Every raster layer points at a source that exists.
  for (const layer of hybrid.layers) {
    if (layer.type === 'raster') assert.ok(hybrid.sources[layer.source], layer.id);
  }

  const terrain = inline('terrain');
  assert.deepEqual(Object.values(terrain.sources).flatMap((s) => (s as { tiles: string[] }).tiles), [ESRI_TOPO]);
});

test('every basemap id resolves to something when the server has a style', () => {
  for (const id of BASEMAP_IDS) assert.ok(maplibreStyle(id, SELF_HOSTED), id);
});

test('isBasemapId guards what comes out of storage', () => {
  assert.ok(isBasemapId('hybrid'));
  assert.ok(!isBasemapId('Satellite'));
  assert.ok(!isBasemapId(null));
  assert.ok(!isBasemapId(42));
});

test('attribution follows the chosen basemap', () => {
  assert.equal(attribution('satellite', { offline: true }), 'Local basemap · airgap mode');
  assert.match(attribution('satellite', {}), /Esri/);
  assert.match(attribution('hybrid', {}), /Labels © Esri/);
  assert.match(attribution('dark', {}), /OpenStreetMap/);
  assert.match(attribution('streets', { serverStyleUrl: `${OPENFREEMAP_STYLES}positron` }), /OpenFreeMap/);
  assert.match(attribution('streets', { serverStyleUrl: SELF_HOSTED }), /OpenStreetMap/);
  assert.match(attribution('streets', { provider: 'mappls' }), /Mappls/);
  // Imagery under a Mappls deployment is Esri's, drawn by MapLibre.
  assert.match(attribution('satellite', { provider: 'mappls' }), /Esri/);
});

test('mapplsStyleFor matches by the words in the style names', () => {
  const names = ['standard-day', 'standard-night', 'grey-day', 'grey-night', 'standard-hybrid'];
  assert.equal(mapplsStyleFor('streets', names), 'standard-day');
  assert.equal(mapplsStyleFor('dark', names), 'standard-night');
  assert.equal(mapplsStyleFor('light', names), 'grey-day');
  assert.equal(mapplsStyleFor('hybrid', names), 'standard-hybrid');
  // Nothing satellite-only and nothing topographic: MapLibre draws those.
  assert.equal(mapplsStyleFor('satellite', names), undefined);
  assert.equal(mapplsStyleFor('terrain', names), undefined);
  assert.equal(mapplsStyleFor('dark', []), undefined);
});

test('mapplsStyleNames accepts objects or strings and drops junk', () => {
  assert.deepEqual(mapplsStyleNames([{ name: 'a' }, 'b', null, { displayName: 'x' }, { name: '' }]), ['a', 'b']);
  assert.deepEqual(mapplsStyleNames(undefined), []);
  assert.deepEqual(mapplsStyleNames({ name: 'a' }), []);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeFailure, isFatalMapplsError } from './mapplsErrors.ts';

const TILE = 'https://tile.mappls.com/map/vector_tile/label/pbf?v=092026&access_token=abc123&rg=';

test('one tile failing is not fatal, even though its URL carries the token', () => {
  assert.equal(isFatalMapplsError({ error: { message: `Precondition Failed (412): ${TILE}`, status: 412 } }), false);
  assert.equal(isFatalMapplsError({ error: { message: `Request Timeout (408): ${TILE}` } }), false);
  assert.equal(isFatalMapplsError({ error: { message: 'Failed to fetch' }, sourceId: 'base', tile: {} }), false);
});

test('a rejected key or domain is fatal', () => {
  assert.equal(isFatalMapplsError({ error: { message: `Unauthorized (401): ${TILE}`, status: 401 } }), true);
  assert.equal(isFatalMapplsError({ error: { message: `Forbidden (403): ${TILE}` }, tile: {} }), true);
  assert.equal(isFatalMapplsError({ error: { message: 'Invalid access token' } }), true);
  assert.equal(isFatalMapplsError({ error: { message: 'The style could not be loaded' } }), true);
});

test('describeFailure keeps the key out of the console', () => {
  assert.equal(describeFailure({ error: { message: `Forbidden (403): ${TILE}` } }).includes('abc123'), false);
  assert.equal(describeFailure('no load event in 15000 ms'), 'no load event in 15000 ms');
  assert.equal(describeFailure(new Error('Mappls SDK script failed to load')), 'Mappls SDK script failed to load');
});

test('an event with nothing to go on is not fatal', () => {
  assert.equal(isFatalMapplsError(undefined), false);
  assert.equal(isFatalMapplsError({}), false);
  assert.equal(isFatalMapplsError({ error: { message: 'something odd' } }), false);
});

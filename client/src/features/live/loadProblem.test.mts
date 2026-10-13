import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadProblem } from './loadProblem.ts';

const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

test('nothing to say without an error', () => {
  assert.equal(loadProblem(null, false), null);
});

test('a failed refetch never covers a workspace that is on screen', () => {
  // The case found after a laptop sleep: a 401 for a request that was in flight.
  assert.equal(loadProblem(apiError(401, 'oidc: token expired at 2026-10-13T01:38:39Z: unauthorized'), true), null);
  assert.equal(loadProblem(new TypeError('Failed to fetch'), true), null);
});

test('a refused session asks to sign in again, without the server\'s wording', () => {
  const p = loadProblem(apiError(401, 'oidc: token expired at 2026-10-13T01:38:39Z: unauthorized'), false);
  assert.equal(p?.action, 'sign-in');
  assert.doesNotMatch(`${p?.title} ${p?.body}`, /oidc|unauthorized|reach/i);
});

test('a network failure points at the server address', () => {
  const p = loadProblem(new TypeError('Failed to fetch'), false);
  assert.equal(p?.title, 'Cannot reach the Lura server');
  assert.equal(p?.action, 'settings');
  assert.match(p?.body ?? '', /Failed to fetch/);
});

test('a server error says the server failed, not that it is unreachable', () => {
  const p = loadProblem(apiError(503, 'unavailable'), false);
  assert.match(p?.title ?? '', /server had a problem/);
  assert.match(p?.body ?? '', /503/);
});

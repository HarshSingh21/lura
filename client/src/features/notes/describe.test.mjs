// Run with: npm run test:unit (node --test; Node 23.6+ strips the TypeScript types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeAudience } from './describe.ts';
import { personColor, PERSON_COLORS } from '../people/color.ts';

const names = { usr_n: 'Nishtha', usr_a: 'Arjun' };
const nameOf = (id) => names[id];

test('the default note is about me and for me', () => {
  const d = describeAudience({
    ownerId: 'usr_h',
    watchUserId: '',
    notifyUserIds: [],
    trigger: 'passby',
    placeName: 'Grocery',
    nameOf,
  });
  assert.equal(d.when, 'When you pass Grocery');
  assert.equal(d.notify, 'notify you');
  assert.equal(d.isDefault, true);
});

test('a note about a peer that notifies both of us', () => {
  const d = describeAudience({
    ownerId: 'usr_h',
    watchUserId: 'usr_n',
    notifyUserIds: ['usr_n', 'usr_h'],
    trigger: 'passby',
    placeName: 'Grocery',
    nameOf,
  });
  assert.equal(d.when, 'When Nishtha passes Grocery');
  assert.equal(d.notify, 'notify you, Nishtha');
  assert.equal(d.isDefault, false);
});

test('unknown people and places degrade to words, not ids', () => {
  const d = describeAudience({
    ownerId: 'usr_h',
    watchUserId: 'usr_gone',
    notifyUserIds: ['usr_gone', 'usr_gone'],
    trigger: 'arrive',
    nameOf,
  });
  assert.equal(d.when, 'When someone arrives at this place');
  assert.equal(d.notify, 'notify someone');
});

test('personColor is stable and inside the palette', () => {
  assert.equal(personColor('usr_n'), personColor('usr_n'));
  assert.ok(PERSON_COLORS.includes(personColor('usr_n')));
  assert.equal(personColor(undefined), PERSON_COLORS[0]);
});

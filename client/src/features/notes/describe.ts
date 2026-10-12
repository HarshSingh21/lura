import type { Trigger } from '../../api/types';

/**
 * describeAudience writes a note's who-and-whom as one sentence:
 * "When Nishtha passes Grocery → notify you, Nishtha".
 *
 * A note has two people fields — whose movement fires it, and who hears about
 * it — and both default to the owner. Spelling them out on every card is the only
 * way a reader can tell "remind me when I pass" from "tell Nishtha when she
 * passes", which otherwise look identical.
 *
 * Pure and type-only on imports, so node --test can exercise it directly.
 */

const PHRASE: Record<Trigger, { self: string; other: string }> = {
  arrive: { self: 'arrive at', other: 'arrives at' },
  leave: { self: 'leave', other: 'leaves' },
  passby: { self: 'pass', other: 'passes' },
  dwell: { self: 'stay at', other: 'stays at' },
};

export type NameOf = (userId: string) => string | undefined;

export function describeAudience(input: {
  ownerId: string;
  watchUserId: string;
  notifyUserIds: string[];
  trigger: Trigger;
  placeName?: string;
  nameOf: NameOf;
}): { when: string; notify: string; isDefault: boolean } {
  const { ownerId, nameOf } = input;
  const watcher = input.watchUserId && input.watchUserId !== ownerId ? input.watchUserId : '';
  const phrase = PHRASE[input.trigger] ?? PHRASE.arrive;
  const place = input.placeName || 'this place';
  const subject = watcher ? (nameOf(watcher) ?? 'someone') : 'you';
  const when = `When ${subject} ${watcher ? phrase.other : phrase.self} ${place}`;

  const ids = input.notifyUserIds.length > 0 ? input.notifyUserIds : [ownerId];
  // "you" leads: the owner reading their own card first wants to know whether it is them.
  const unique = [...new Set(ids)];
  const ordered = [...unique.filter((id) => id === ownerId), ...unique.filter((id) => id !== ownerId)];
  const names = ordered.map((id) => (id === ownerId ? 'you' : (nameOf(id) ?? 'someone')));
  return {
    when,
    notify: `notify ${names.join(', ')}`,
    isDefault: !watcher && ordered.length === 1 && ordered[0] === ownerId,
  };
}

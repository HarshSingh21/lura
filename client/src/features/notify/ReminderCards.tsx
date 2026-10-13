import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { Dot, TriggerBadge } from '@/components/ui/primitives';
import { personColor } from '@/features/people/color';
import { Mono, Txt } from '@/theme/text';
import { color, font, palette, radius, shadow, size, space } from '@/theme/tokens';
import { selectPendingReminders, useStore } from '@/state/store';
import { useTouchTargets } from '@/theme/touch';

import { stackView, type ReminderCard } from './reminders';
import { NotificationGlyph, formatWhen, tintFor, useOpenNotification } from './ui';

/**
 * Sticky reminder cards (release spec §6).
 *
 * A toast can be missed while driving past the shop; a pending reminder cannot.
 * It stays on screen — through navigation, and through reloads, because the
 * pending list is re-read from the server — until somebody presses Acknowledge,
 * here or in any other session. Several pending stack: the newest is shown in
 * full with the rest folded behind it ("+2 more"), so a backlog does not cover
 * the map.
 */
export function ReminderCards() {
  const cards = useStore(selectPendingReminders);
  const [expanded, setExpanded] = useState(false);
  const touch = useTouchTargets();
  if (cards.length === 0) return null;
  const { shown, hidden } = stackView(cards, expanded);

  return (
    <View style={styles.wrap} accessibilityLiveRegion="polite" pointerEvents="box-none">
      {expanded && cards.length > 1 ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollInner}>
          {shown.map((card) => (
            <Card key={card.id} card={card} />
          ))}
        </ScrollView>
      ) : (
        shown.map((card) => <Card key={card.id} card={card} />)
      )}
      {hidden > 0 ? (
        <View pointerEvents="none">
          <View style={[styles.peek, styles.peek1]} />
          {hidden > 1 ? <View style={[styles.peek, styles.peek2]} /> : null}
        </View>
      ) : null}
      {cards.length > 1 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={expanded ? 'Fold pending reminders' : `Show ${hidden} more pending reminders`}
          onPress={() => setExpanded((v) => !v)}
          style={({ pressed }) => [styles.more, touch && styles.moreTouch, pressed && styles.pressed]}
        >
          <Mono size={size.monoXs} medium color={palette.amberInk}>
            {expanded ? 'SHOW LESS' : `+${hidden} MORE`}
          </Mono>
          <Icon name={expanded ? 'chevron-down' : 'chevron-up'} size={12} color={palette.amberInk} />
        </Pressable>
      ) : null}
    </View>
  );
}

function Card({ card }: { card: ReminderCard }) {
  const acknowledge = useStore((s) => s.acknowledgeReminder);
  const open = useOpenNotification();
  const touch = useTouchTargets();
  const tint = tintFor(card);
  const show = () =>
    open({
      id: card.eventId ?? card.id,
      placeId: card.placeId,
      subjectUserId: card.subjectUserId,
      deviceId: card.deviceId,
      point: card.point,
    });

  return (
    <View
      style={[styles.card, { borderLeftColor: tint }]}
      accessibilityRole="alert"
      accessibilityLabel={`Reminder: ${card.title}${card.placeName ? ` at ${card.placeName}` : ''}. Waiting for acknowledgement.`}
    >
      <View style={styles.head}>
        <Dot size={7} color={palette.amber} blink />
        <Mono heading color={palette.amberInk} style={styles.headLabel}>
          REMINDER · WAITING FOR YOU
        </Mono>
        <View style={styles.flex} />
        <Mono size={size.monoTiny} color={color.textFaint}>
          {formatWhen(card.at)}
        </Mono>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${card.title}. Show on the map.`}
        // The crossing it came from, as on the toast it replaces.
        testID={`lura-notice-${card.eventId ?? card.id}`}
        onPress={show}
        style={({ pressed }) => [styles.main, touch && styles.mainTouch, pressed && styles.pressed]}
      >
        <NotificationGlyph item={card} size={36} />
        <View style={styles.flex}>
          <Txt variant="cardTitle" numberOfLines={2}>
            {card.title}
          </Txt>
          {card.body ? (
            <Txt variant="small" color={color.textMuted} numberOfLines={3} style={styles.body}>
              {card.body}
            </Txt>
          ) : null}
          <View style={styles.meta}>
            {card.subjectName ? (
              <View style={styles.metaPart}>
                <View style={[styles.personDot, { backgroundColor: personColor(card.subjectUserId) }]} />
                <Txt variant="micro" color={color.textBody}>
                  {card.subjectName}
                </Txt>
              </View>
            ) : null}
            {card.placeName ? (
              <Txt variant="micro" color={color.textSubtle} numberOfLines={1}>
                {card.placeName}
              </Txt>
            ) : null}
            <TriggerBadge trigger={card.trigger} />
            {card.fromName ? (
              <Txt variant="micro" color={palette.accentInk}>
                from {card.fromName}
              </Txt>
            ) : null}
          </View>
        </View>
      </Pressable>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Acknowledge ${card.title}`}
          onPress={() => void acknowledge(card.id)}
          style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
            styles.ack,
            touch && styles.ackTouch,
            hovered && styles.ackHover,
            pressed && styles.pressed,
          ]}
        >
          <Icon name="check" size={15} color={color.textOnAccent} strokeWidth={2.2} />
          <Txt variant="bodySemi" color={color.textOnAccent}>
            Acknowledge
          </Txt>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={show} hitSlop={6} style={[styles.showLink, touch && styles.showLinkTouch]}>
          <Txt variant="small" color={palette.accentDark} style={styles.link}>
            Show on map
          </Txt>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.88 },
  wrap: { gap: 0 },
  scroll: { maxHeight: 420 },
  scrollInner: { gap: space.md },

  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.amberBorderStrong,
    borderLeftWidth: 4,
    borderRadius: radius.card,
    paddingTop: 10,
    paddingBottom: 12,
    paddingHorizontal: 14,
    gap: 8,
    ...shadow('card'),
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  headLabel: { letterSpacing: 0.85 },
  main: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  mainTouch: { minHeight: 44 },
  body: { marginTop: 2 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginTop: 6 },
  metaPart: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  personDot: { width: 7, height: 7, borderRadius: radius.pill },

  actions: { flexDirection: 'row', alignItems: 'center', gap: space.xl, marginTop: 2 },
  ack: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: palette.accent,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: 8,
    minHeight: 36,
    ...shadow('accent'),
  },
  ackHover: { backgroundColor: palette.accentDark },
  showLink: { paddingVertical: 6 },
  // Under a finger (theme/touch) every action on the card is a full 44 px target.
  ackTouch: { minHeight: 44, paddingHorizontal: 16 },
  showLinkTouch: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  moreTouch: { minHeight: 44, paddingHorizontal: 14 },
  link: { fontFamily: font.sansMedium },

  peek: {
    height: 6,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: color.amberBorder,
    borderBottomLeftRadius: radius.card,
    borderBottomRightRadius: radius.card,
  },
  peek1: { marginHorizontal: 8 },
  peek2: { marginHorizontal: 16, height: 5, opacity: 0.8 },
  more: {
    alignSelf: 'flex-end',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.amberBorder,
    ...shadow('float'),
  },
});

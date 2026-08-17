import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Dot, TriggerBadge, styles as ui } from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, palette, radius, size, space } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';

import { markOnboardingSeen } from './storage';
import { STEPS, type OnboardingStep } from './steps';

/**
 * The post-login introduction.
 *
 * Five screens, one per thing the product actually does, each paired with a
 * working scale model of the surface it describes rather than a picture of one.
 * The shape is deliberate:
 *
 *   - Skip is on every step, in the header, in the same place each time. An intro
 *     you cannot leave is a dark pattern, and burying the exit on the last screen
 *     is the same pattern with extra steps.
 *   - The pager is a horizontal ScrollView: swiping is the gesture people already
 *     have for this, and the buttons drive the same scroll offset so the two
 *     controls can never disagree about where you are.
 *   - Page width comes from `onLayout`, not from the window, so the pages line up
 *     at 360 dp and at 1440 px without a breakpoint table.
 *
 * `onDone` is injected rather than routed from here: this component knows when
 * the introduction is finished, and the route knows where "finished" goes.
 */
export function OnboardingScreen({ onDone }: { onDone?: () => void }) {
  const { isPhone } = useLayoutMode();
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState({ width: 0, height: 0 });
  const pageWidth = page.width;
  const pager = useRef<ScrollView>(null);

  const last = index === STEPS.length - 1;

  const goTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(STEPS.length - 1, next));
      setIndex(clamped);
      pager.current?.scrollTo({ x: clamped * pageWidth, y: 0, animated: true });
    },
    [pageWidth],
  );

  const finish = useCallback(() => {
    // Fire and forget: the flag is a convenience, and a storage failure must not
    // trap someone on the introduction.
    void (async () => {
      await markOnboardingSeen();
      onDone?.();
    })();
  }, [onDone]);

  // Both dimensions are measured, not inferred: the width paginates, and the
  // height has to be explicit or the page collapses to its content and the wide
  // layout stops centring vertically.
  const onPagerLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0 && (width !== page.width || height !== page.height)) {
      setPage({ width, height });
    }
  };

  // A resize (rotation, a dragged browser window) changes the page width under a
  // scroll offset that was measured against the old one; re-pin it to the step.
  useEffect(() => {
    if (pageWidth > 0) pager.current?.scrollTo({ x: index * pageWidth, y: 0, animated: false });
    // Re-pinning on `index` too would fight the swipe gesture mid-scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageWidth]);

  // Reading the index from the scroll offset (rather than from momentum-end,
  // which react-native-web emulates unevenly) keeps swipe and buttons in sync.
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (pageWidth <= 0) return;
    const next = Math.round(event.nativeEvent.contentOffset.x / pageWidth);
    if (next !== index && next >= 0 && next < STEPS.length) setIndex(next);
  };

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <Dot size={8} color={palette.accent} pulse />
          <Mono heading color={color.textFaint}>
            LURA · A QUICK TOUR
          </Mono>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Skip the introduction"
          onPress={finish}
          style={({ pressed }) => [styles.skip, pressed && ui.pressed]}
        >
          <Txt variant="small" color={color.textMuted}>
            Skip
          </Txt>
        </Pressable>
      </View>

      <View style={styles.pagerWrap} onLayout={onPagerLayout}>
        {pageWidth > 0 ? (
          <ScrollView
            ref={pager}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={onScroll}
            style={ui.flex}
          >
            {STEPS.map((step, i) => (
              <View key={step.key} style={{ width: page.width, height: page.height }}>
                <StepPage step={step} index={i} total={STEPS.length} stacked={isPhone} />
              </View>
            ))}
          </ScrollView>
        ) : null}
      </View>

      <View style={[styles.footer, isPhone && styles.footerPhone]}>
        <View style={styles.dots}>
          {STEPS.map((step, i) => (
            <Pressable
              key={step.key}
              accessibilityRole="button"
              accessibilityState={{ selected: i === index }}
              accessibilityLabel={`Step ${i + 1} of ${STEPS.length}: ${step.title}`}
              onPress={() => goTo(i)}
              style={styles.dotHit}
            >
              <View style={[styles.dot, i === index && styles.dotActive]} />
            </Pressable>
          ))}
        </View>

        <View style={styles.actions}>
          {index > 0 ? (
            <Button label="Back" variant="ghost" onPress={() => goTo(index - 1)} />
          ) : null}
          <Button
            label={last ? 'Start using Lura' : 'Next'}
            onPress={last ? finish : () => goTo(index + 1)}
            style={isPhone ? ui.flex : undefined}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

/**
 * StepPage lays one step out in the two shapes it needs: a single scrolling
 * column on a phone, and copy beside the illustration once there is room for both.
 */
function StepPage({
  step,
  index,
  total,
  stacked,
}: {
  step: OnboardingStep;
  index: number;
  total: number;
  stacked: boolean;
}) {
  const head = (
    <View style={styles.head}>
      <Mono heading color={palette.accentInk}>
        {`${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')} · ${step.eyebrow}`}
      </Mono>
      <Txt variant="h1" style={styles.title}>
        {step.title}
      </Txt>
    </View>
  );

  const detail = (
    <View style={styles.detail}>
      <Txt variant="body" color={color.textBody} style={styles.body}>
        {step.body}
      </Txt>

      <View style={styles.points}>
        {step.points.map((point) => (
          <View key={point.text} style={styles.point}>
            {point.trigger ? (
              <TriggerBadge trigger={point.trigger} />
            ) : (
              <View style={styles.pointLabel}>
                <Mono size={size.monoTiny} medium color={palette.accentInk}>
                  {point.label ?? '·'}
                </Mono>
              </View>
            )}
            <Txt variant="small" color={color.textMuted} style={ui.flex}>
              {point.text}
            </Txt>
          </View>
        ))}
      </View>
    </View>
  );

  const visual = (
    <View style={stacked ? styles.visualPhone : styles.visualWide}>
      <step.Visual />
    </View>
  );

  if (stacked) {
    return (
      <ScrollView
        style={ui.flex}
        contentContainerStyle={styles.pagePhone}
        showsVerticalScrollIndicator={false}
      >
        {head}
        {visual}
        {detail}
      </ScrollView>
    );
  }

  return (
    <ScrollView style={ui.flex} contentContainerStyle={styles.pageWide} showsVerticalScrollIndicator={false}>
      <View style={styles.columns}>
        <View style={styles.copyColumn}>
          {head}
          {detail}
        </View>
        {visual}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xxl,
    paddingTop: space.xl,
    paddingBottom: space.md,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  skip: {
    paddingVertical: 7,
    paddingHorizontal: 13,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },

  pagerWrap: { flex: 1, minHeight: 0 },

  pagePhone: { paddingHorizontal: 20, paddingTop: space.md, paddingBottom: space.page, gap: space.xxl },
  pageWide: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: space.pageX,
    paddingVertical: space.page,
  },
  columns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 44,
    width: '100%',
    maxWidth: 1000,
    alignSelf: 'center',
  },
  copyColumn: { flex: 1, minWidth: 0, gap: space.xxl },

  head: { gap: space.md },
  title: { maxWidth: 480, lineHeight: 31 },
  detail: { gap: space.xxl },
  body: { maxWidth: 480, lineHeight: 21 },

  points: { gap: space.lg, maxWidth: 480 },
  point: { flexDirection: 'row', alignItems: 'flex-start', gap: space.lg },
  pointLabel: {
    backgroundColor: color.accentSoft,
    borderRadius: radius.sm,
    paddingVertical: 2,
    paddingHorizontal: 7,
    minWidth: 36,
    alignItems: 'center',
  },

  visualPhone: {},
  visualWide: { flex: 1, minWidth: 0, maxWidth: 470 },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.xl,
    paddingHorizontal: space.xxl,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    borderTopWidth: 1,
    borderTopColor: color.hairlineSoft,
    backgroundColor: color.surface,
  },
  footerPhone: { paddingHorizontal: 20 },

  dots: { flexDirection: 'row', alignItems: 'center' },
  dotHit: { paddingVertical: 10, paddingHorizontal: 4 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: color.checkbox },
  dotActive: { width: 22, backgroundColor: palette.accent },

  actions: { flexDirection: 'row', alignItems: 'center', gap: space.md, flexShrink: 1 },
});

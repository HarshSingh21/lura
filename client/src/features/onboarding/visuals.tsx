import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line, Path } from 'react-native-svg';

import type { Point } from '@/api/types';
import { MapCanvas } from '@/components/map/MapCanvas';
import { metresPerPixel } from '@/components/map/projection';
import { Icon } from '@/components/ui/Icon';
import { Chip, Dot, TriggerBadge, styles as ui } from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, font, palette, radius, shadow, size, space } from '@/theme/tokens';

/**
 * The five illustrations for the introduction.
 *
 * Each one is a scale model of the screen it describes, built from the same
 * primitives that screen uses — the live map is the real `MapCanvas`, the trigger
 * badges are the real `TriggerBadge`, the airgap banner is the same ink bar the
 * shell renders. A drawing that is merely *shaped* like the product teaches the
 * wrong thing: what a person recognises here has to be what they will find.
 *
 * Nothing here is interactive. The two things that move — the live marker's pulse
 * and the share countdown — move because they are the point being made.
 */

/** A stable place to centre the demo maps. Nothing is fetched for it. */
const CENTRE: Point = { lat: 12.9716, lon: 77.5946 };

function offset(base: Point, northM: number, eastM: number): Point {
  return { lat: base.lat + northM / 111_320, lon: base.lon + eastM / 108_500 };
}

/**
 * A live marker draws its dot 46 px above its anchor, to leave room for the label
 * pill it normally carries. In the share thumbnail that would put the dot off the
 * top edge, so the anchor is pushed the same distance south — in metres, derived
 * from the zoom, rather than a magic number that breaks if the zoom changes.
 */
const SHARE_ZOOM = 14;
const MARKER_LIFT_M = 46 * metresPerPixel(CENTRE.lat, SHARE_ZOOM);

/**
 * LiveMapVisual: devices moving over a socket, and a place you drew.
 *
 * The fence carries its radius as a badge because the radius is the whole
 * contract — it is what the geofence engine tests every fix against.
 */
export function LiveMapVisual() {
  return (
    <VisualCard>
      <View style={styles.mapFrame}>
        <MapCanvas
          center={CENTRE}
          zoom={14.6}
          // Everything is placed below the status pill on purpose: fence and
          // marker labels are drawn above their anchor, and a 236 px frame has
          // room for exactly one thing at the top.
          fences={[
            { id: 'store', center: offset(CENTRE, -100, -230), radiusM: 180, name: 'Corner Store', tone: 'accent' },
          ]}
          markers={[
            { id: 'phone', point: offset(CENTRE, 90, 320), label: 'Pixel 8', tone: 'accent', pulse: true },
            { id: 'laptop', point: offset(CENTRE, -180, 400), tone: 'neutral', small: true },
          ]}
        />

        <View style={styles.mapPill} pointerEvents="none">
          <Dot size={7} color={palette.accent} pulse />
          <Mono size={size.monoSm} color={color.textBody}>
            2 devices · live
          </Mono>
        </View>

        <View style={styles.mapFoot} pointerEvents="none">
          <Mono size={size.monoTiny} color={color.textSubtle}>
            180 m fence · ws /ws · positions and events
          </Mono>
        </View>
      </View>
    </VisualCard>
  );
}

/**
 * NoteVisual: the composer with its suggestion row, then the fly-by filter drawn
 * as the two cases it separates.
 */
export function NoteVisual() {
  return (
    <VisualCard>
      <View style={styles.composer}>
        <Txt variant="body" color={color.textStrong}>
          buy oat milk when I pass the store
        </Txt>

        <View style={styles.suggestRow}>
          <Mono size={size.monoTiny} color={color.textFaint} style={styles.suggestLabel}>
            SUGGESTED
          </Mono>
          <Chip label="📍 Corner Store" tone="accent" />
          <Chip label="grocery" />
          <Chip label="pass-by" tone="amber" />
          <Mono size={size.monoXs} color={color.textFaint}>
            92% match · on-device
          </Mono>
        </View>
      </View>

      <View style={styles.divider} />

      <View style={styles.flyby}>
        <Mono heading color={color.textFaint}>
          THE FLY-BY FILTER
        </Mono>

        <Svg width="100%" height={116} viewBox="0 0 300 116" preserveAspectRatio="xMidYMid meet">
          {/* Case one: through the fence at speed. */}
          <G>
            <Line x1={8} y1={32} x2={292} y2={32} stroke={color.mapArterial} strokeWidth={13} strokeLinecap="round" />
            <Circle
              cx={150}
              cy={32}
              r={26}
              fill={color.amberFence}
              stroke={color.amberFenceLine}
              strokeWidth={1.5}
              strokeDasharray="5 4"
            />
            <Line x1={96} y1={32} x2={112} y2={32} stroke={color.amberBorder} strokeWidth={3} strokeLinecap="round" />
            <Line x1={118} y1={32} x2={132} y2={32} stroke={color.amberBorderStrong} strokeWidth={3} strokeLinecap="round" />
            <Circle cx={150} cy={32} r={7} fill={palette.amber} stroke="#ffffff" strokeWidth={2.5} />
            <Path
              d="M 176 32 L 214 32"
              stroke={palette.amberDark}
              strokeWidth={2}
              strokeLinecap="round"
              fill="none"
            />
            <Path
              d="M 206 26 L 214 32 L 206 38"
              stroke={palette.amberDark}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />
          </G>

          {/* Case two: into the fence, then stopped. */}
          <G>
            <Line x1={8} y1={88} x2={292} y2={88} stroke={color.mapArterial} strokeWidth={13} strokeLinecap="round" />
            <Circle
              cx={150}
              cy={88}
              r={26}
              fill={color.accentFence}
              stroke={color.accentFenceLine}
              strokeWidth={1.5}
            />
            <Path
              d="M 96 88 L 138 88"
              stroke={color.accentFenceLine}
              strokeWidth={2}
              strokeLinecap="round"
              fill="none"
            />
            <Circle cx={150} cy={88} r={16} fill={color.accentGlow} opacity={0.35} />
            <Circle cx={150} cy={88} r={7} fill={palette.accent} stroke="#ffffff" strokeWidth={2.5} />
          </G>
        </Svg>

        <View style={styles.caseRow}>
          <TriggerBadge trigger="passby" />
          <Txt variant="micro" color={color.textMuted} style={ui.flex}>
            Entered above 3 m/s and kept going. Pass-by fires; arrive does not.
          </Txt>
        </View>
        <View style={styles.caseRow}>
          <TriggerBadge trigger="arrive" />
          <Txt variant="micro" color={color.textMuted} style={ui.flex}>
            Slowed below 1.5 m/s, or stayed 45 seconds. Only now does arrive fire.
          </Txt>
        </View>
      </View>
    </VisualCard>
  );
}

/**
 * ShareVisual: one live link, with the clock actually running.
 *
 * The countdown ticks because "this ends on its own" is a claim a static mock
 * cannot make. It loops rather than expiring, so the slide is the same on the
 * tenth read as on the first.
 */
export function ShareVisual() {
  const remaining = useCountdown(11 * 60 + 42);

  return (
    <VisualCard>
      <View style={styles.shareRow}>
        <Dot size={9} color={palette.amberDot} blink />
        <View style={ui.flex}>
          <Txt variant="bodySemi">Priya · school run</Txt>
          <Txt variant="tiny" color={color.textSubtle}>
            Until I arrive Home · auto-revokes on arrive
          </Txt>
        </View>
        <View style={styles.fakeGhost}>
          <Txt variant="small" color={color.textMuted}>
            Copy
          </Txt>
        </View>
        <View style={styles.fakeDanger}>
          <Txt variant="small" color={palette.dangerInk}>
            Revoke
          </Txt>
        </View>
      </View>

      <View style={styles.linkBox}>
        <Mono size={size.monoSm} color={color.textBody} style={ui.flex} numberOfLines={1}>
          https://lura.your-server/s/7fbc4e21
        </Mono>
        <View style={styles.countdown}>
          <Mono size={size.monoSm} medium color={palette.amberInk}>
            {remaining}
          </Mono>
        </View>
      </View>

      <View style={styles.previewStrip}>
        <View style={styles.previewMap}>
          <MapCanvas
            center={CENTRE}
            zoom={SHARE_ZOOM}
            variant="dark"
            markers={[{ id: 'shared', point: offset(CENTRE, -MARKER_LIFT_M, 0), tone: 'accent', pulse: true }]}
          />
        </View>
        <View style={ui.flex}>
          <Txt variant="micro" color={color.inkPanelText}>
            What Priya sees
          </Txt>
          <Txt variant="micro" color={color.inkPanelMuted} style={styles.previewNote}>
            One map, one device, no account. No history, no notes, no other devices.
          </Txt>
        </View>
      </View>
    </VisualCard>
  );
}

/** HistoryVisual: the day as the server segmented it, plus the two exits from it. */
export function HistoryVisual() {
  return (
    <VisualCard>
      <View style={styles.historyHead}>
        <Txt variant="cardTitle">Today</Txt>
        <View style={styles.exportRow}>
          <View style={styles.fakeGhost}>
            <Txt variant="small" color={color.textMuted}>
              GPX
            </Txt>
          </View>
          <View style={styles.fakeGhost}>
            <Txt variant="small" color={color.textMuted}>
              GeoJSON
            </Txt>
          </View>
        </View>
      </View>

      <View>
        <TimelineRow
          kind="move"
          title="Home → Corner Store"
          meta="walking · 11 min · 0.9 km"
          time="08:12 – 08:23"
        />
        <TimelineRow kind="stop" title="Stopped at Corner Store" meta="6 min" time="08:23 – 08:29" />
        <TimelineRow
          kind="move"
          title="Corner Store → Office"
          meta="driving · 18 min · 7.4 km"
          time="08:29 – 08:47"
        />
        <TimelineRow kind="stop" title="Stopped at Office" meta="4 h 20 min" time="08:47 – 13:07" last />
      </View>

      <View style={styles.divider} />

      <View style={styles.retentionRow}>
        <Mono size={size.monoXs} color={color.textSubtle}>
          retention 90 days
        </Mono>
        <Mono size={size.monoXs} color={color.textSubtle}>
          · delete any window
        </Mono>
        <Mono size={size.monoXs} color={color.textSubtle}>
          · stored on your infrastructure
        </Mono>
      </View>
    </VisualCard>
  );
}

function TimelineRow({
  kind,
  title,
  meta,
  time,
  last,
}: {
  kind: 'move' | 'stop';
  title: string;
  meta: string;
  time: string;
  last?: boolean;
}) {
  const stop = kind === 'stop';
  return (
    <View style={styles.tlRow}>
      <View style={styles.tlGutter}>
        <View style={[styles.tlNode, stop ? styles.tlNodeStop : styles.tlNodeMove]} />
        {!last ? <View style={styles.tlSpine} /> : null}
      </View>
      <View style={[ui.flex, styles.tlBody]}>
        <Txt variant="bodySemi" color={stop ? color.textMuted : color.textStrong}>
          {title}
        </Txt>
        <Txt variant="tiny" color={stop ? color.textFaint : palette.accentMode}>
          {meta}
        </Txt>
        <Mono size={size.monoTiny} color={color.textFaint}>
          {time}
        </Mono>
      </View>
    </View>
  );
}

/** AirgapVisual: the banner, and the list of paths it closes. */
export function AirgapVisual() {
  return (
    <VisualCard>
      <View style={styles.airgapBanner}>
        <Icon name="airgap" size={14} color={palette.accentBright} strokeWidth={1.8} />
        <Txt variant="small" color="#ffffff" style={styles.airgapText}>
          <Txt variant="bodySemi" color="#ffffff">
            Airgap mode on
          </Txt>
          {' — no outbound calls. AI runs on-device; nothing leaves this server.'}
        </Txt>
      </View>

      <View style={styles.boundary}>
        <Mono heading color={palette.accentInk}>
          YOUR SERVER
        </Mono>
        <View style={styles.boundaryRow}>
          <Chip label="lura" tone="accent" mono />
          <Chip label="postgis" tone="accent" mono />
          <Chip label="ai brain" tone="accent" mono />
          <Chip label="basemap" tone="accent" mono />
        </View>
      </View>

      <View style={styles.egressList}>
        {['telemetry exporters', 'push channels', 'remote basemap tiles', 'AI sidecar'].map((path) => (
          <View key={path} style={styles.egressRow}>
            <Svg width={14} height={14} viewBox="0 0 14 14">
              <Circle cx={7} cy={7} r={5.6} stroke={color.textFaint} strokeWidth={1.4} fill="none" />
              <Line x1={3.2} y1={10.8} x2={10.8} y2={3.2} stroke={color.textFaint} strokeWidth={1.4} strokeLinecap="round" />
            </Svg>
            <Txt variant="micro" color={color.textFaint} style={styles.egressText}>
              {path}
            </Txt>
          </View>
        ))}
      </View>
    </VisualCard>
  );
}

/** VisualCard is the white plate every illustration sits on. */
function VisualCard({ children }: { children: ReactNode }) {
  return <View style={styles.visualCard}>{children}</View>;
}

/**
 * useCountdown returns a mm:ss string that ticks down and wraps around, so the
 * slide never sits on an expired share.
 */
function useCountdown(startSeconds: number): string {
  const [seconds, setSeconds] = useState(startSeconds);

  useEffect(() => {
    const id = setInterval(() => {
      setSeconds((current) => (current <= 1 ? startSeconds : current - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [startSeconds]);

  const mm = Math.floor(seconds / 60);
  const ss = seconds % 60;
  return `${mm}:${ss.toString().padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  visualCard: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    overflow: 'hidden',
    ...shadow('card'),
  },

  mapFrame: { height: 236, backgroundColor: color.mapBg },
  mapPill: {
    position: 'absolute',
    top: 12,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.lg,
    paddingVertical: 6,
    paddingHorizontal: 11,
    ...shadow('float'),
  },
  mapFoot: { position: 'absolute', left: 13, bottom: 10 },

  composer: { padding: 15, gap: 11 },
  suggestRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  suggestLabel: { letterSpacing: 0.6 },

  divider: { height: 1, backgroundColor: color.hairlineSoft },

  flyby: { padding: 15, gap: space.md },
  caseRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },

  shareRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 15,
  },
  fakeGhost: {
    backgroundColor: color.surfaceMuted,
    borderRadius: radius.md,
    paddingVertical: 6,
    paddingHorizontal: 11,
  },
  fakeDanger: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: palette.danger,
    borderRadius: radius.md,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  linkBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginHorizontal: 15,
    marginBottom: 14,
    backgroundColor: color.surfaceMuted,
    borderRadius: radius.md,
    paddingVertical: 9,
    paddingHorizontal: 11,
  },
  countdown: {
    backgroundColor: color.amberSoft,
    borderRadius: radius.sm,
    paddingVertical: 2,
    paddingHorizontal: 7,
  },
  previewStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: color.inkPanel,
    padding: 12,
  },
  previewMap: {
    width: 116,
    height: 78,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.ink,
  },
  previewNote: { marginTop: 2 },

  historyHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 15,
    paddingBottom: 12,
  },
  exportRow: { flexDirection: 'row', gap: space.sm },

  tlRow: { flexDirection: 'row', gap: 13, paddingHorizontal: 15 },
  tlGutter: { width: 14, alignItems: 'center' },
  tlNode: { width: 11, height: 11, borderRadius: 6, marginTop: 4 },
  tlNodeMove: { backgroundColor: palette.accent },
  tlNodeStop: { backgroundColor: color.surface, borderWidth: 2, borderColor: color.timelineNode },
  tlSpine: { flex: 1, width: 2, backgroundColor: color.hairline, marginTop: 3 },
  tlBody: { paddingBottom: space.xl, gap: 1 },

  retentionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, padding: 15 },

  airgapBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    backgroundColor: color.ink,
    paddingVertical: space.lg,
    paddingHorizontal: space.xl,
  },
  airgapText: { textAlign: 'center' },

  boundary: {
    margin: 15,
    marginBottom: 0,
    gap: space.md,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.accentFenceLine,
    backgroundColor: color.accentSofter,
    borderRadius: radius.card,
    padding: 13,
  },
  boundaryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },

  egressList: { padding: 15, gap: 7 },
  egressRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  egressText: { textDecorationLine: 'line-through', fontFamily: font.sans },
});

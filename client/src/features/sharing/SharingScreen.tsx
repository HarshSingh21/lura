import { useState } from 'react';
import { Platform, Pressable, ScrollView, Share as RNShare, StyleSheet, View } from 'react-native';

import { useCreateShare, useOverview, useRevokeShare, type ShareInput } from '@/api/hooks';
import type { Share, ShareMode } from '@/api/types';
import { MapCanvas } from '@/components/map/MapCanvas';
import {
  Button,
  Card,
  Dot,
  EmptyState,
  Field,
  RadioRow,
  styles as ui,
} from '@/components/ui/primitives';
import { Mono, SectionLabel, Txt } from '@/theme/text';
import { color, palette, radius, size, space } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';

import { formatClock } from '@/features/live/rail';

/**
 * Sharing: create a link, see exactly what the recipient sees, revoke it.
 *
 * The preview panel is not decoration. HLD §5.8 forbids covert sharing, and the
 * strongest form of that promise is showing the sharer the recipient's view before
 * they send the link: a live dot, a name, and nothing else — no notes, no places,
 * no history.
 */
export function SharingScreen() {
  const { isPhone } = useLayoutMode();
  const { data } = useOverview();
  const createShare = useCreateShare();
  const revokeShare = useRevokeShare();

  const [mode, setMode] = useState<ShareMode>('until_arrive');
  const [label, setLabel] = useState('');
  const [durationMins, setDurationMins] = useState('120');
  const [arrivePlaceId, setArrivePlaceId] = useState<string>('');
  const [lastLink, setLastLink] = useState<string | null>(null);

  const places = data?.places ?? [];
  const shares = data?.shares ?? [];
  const devices = data?.devices ?? [];
  const arriveChoice = arrivePlaceId || places[0]?.id || '';

  const submit = () => {
    const input: ShareInput = { mode, label: label.trim() || undefined };
    if (mode === 'duration') input.durationMins = Number(durationMins) || 120;
    if (mode === 'until_arrive') input.arrivePlaceId = arriveChoice;

    createShare.mutate(input, {
      onSuccess: (res) => {
        setLastLink(res.share.link);
        setLabel('');
      },
    });
  };

  const previewPoint = devices.find((d) => d.lastPoint)?.lastPoint ?? { lat: 12.9716, lon: 77.5946 };

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Txt variant="h1">Sharing</Txt>
        <Txt variant="body" color={color.textMuted} style={styles.subtitle}>
          Expiring, revocable links. No account needed to view. Nothing covert — you always see who can see
          you.
        </Txt>
      </View>

      <View style={[styles.topRow, isPhone && styles.topRowPhone]}>
        <Card style={[styles.createCard, isPhone ? undefined : ui.flex]}>
          <Txt variant="cardTitle">Create a share link</Txt>
          <Txt variant="small" color={color.textSubtle} style={styles.cardHint}>
            Choose how it ends
          </Txt>

          <View style={styles.modes}>
            <RadioRow
              label="Until I arrive at a place"
              description="Auto-revokes the moment you get there."
              selected={mode === 'until_arrive'}
              onPress={() => setMode('until_arrive')}
            />
            <RadioRow
              label="For a set duration"
              description="Expires on a clock, whatever happens."
              selected={mode === 'duration'}
              onPress={() => setMode('duration')}
            />
            <RadioRow
              label="Until I revoke it"
              description="Stays live until you switch it off."
              selected={mode === 'until_revoke'}
              onPress={() => setMode('until_revoke')}
            />
          </View>

          {mode === 'until_arrive' ? (
            <View style={styles.inlineField}>
              <Txt variant="small" color={color.textMuted}>
                Arriving at
              </Txt>
              <View style={styles.placePicker}>
                {places.length === 0 ? (
                  <Txt variant="micro" color={palette.amberInk}>
                    Create a place first — this mode needs somewhere to arrive.
                  </Txt>
                ) : (
                  places.map((place) => (
                    <Pressable
                      key={place.id}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: place.id === arriveChoice }}
                      onPress={() => setArrivePlaceId(place.id)}
                      style={[styles.placeChip, place.id === arriveChoice && styles.placeChipActive]}
                    >
                      <Txt
                        variant="small"
                        color={place.id === arriveChoice ? palette.accentInk : color.textMuted}
                      >
                        {place.name}
                      </Txt>
                    </Pressable>
                  ))
                )}
              </View>
            </View>
          ) : null}

          {mode === 'duration' ? (
            <Field
              label="Duration (minutes)"
              value={durationMins}
              onChangeText={setDurationMins}
              keyboardType="number-pad"
              hint="Up to 30 days; shorter is safer."
            />
          ) : null}

          <Field
            label="Who is it for?"
            placeholder="Priya"
            value={label}
            onChangeText={setLabel}
            hint="A name for your own list — it is not sent to them."
          />

          {createShare.error ? (
            <Txt variant="micro" color={palette.dangerInk}>
              {createShare.error instanceof Error ? createShare.error.message : 'Could not create the link'}
            </Txt>
          ) : null}

          <Button
            label="Generate link"
            full
            loading={createShare.isPending}
            onPress={submit}
            style={styles.generate}
          />

          {lastLink ? (
            <View style={styles.linkBox}>
              <Mono size={size.monoSm} color={color.textBody} selectable style={ui.flex}>
                {lastLink}
              </Mono>
              <Button
                label="Copy"
                variant="ghost"
                small
                onPress={() => void copyLink(lastLink)}
              />
            </View>
          ) : null}
        </Card>

        <View style={[styles.previewCard, isPhone ? undefined : styles.previewCardWide]}>
          <Txt variant="small" color={color.inkPanelMuted}>
            Preview · what a recipient sees
          </Txt>
          <View style={styles.previewMap}>
            <MapCanvas
              center={previewPoint}
              zoom={14}
              variant="dark"
              markers={[{ id: 'preview', point: previewPoint, tone: 'accent', pulse: true }]}
            />
            <View style={styles.previewCaption} pointerEvents="none">
              <Txt variant="micro" color={color.inkPanelText}>
                {data?.user.displayName || 'You'} ·{' '}
                <Txt variant="micro" color={palette.accentBright}>
                  live
                </Txt>
              </Txt>
            </View>
          </View>
          <Mono size={size.monoSm} color={color.inkPanelFaint} style={styles.previewUrl} numberOfLines={2}>
            {lastLink ?? `${data?.server.publicBaseUrl ?? 'http://localhost:8080'}/s/…`}
          </Mono>
        </View>
      </View>

      <View>
        <SectionLabel>ACTIVE SHARES</SectionLabel>
        <View style={styles.list}>
          {shares.length === 0 ? (
            <Card>
              <EmptyState
                title="Nothing is shared right now"
                body="When a link is live, it appears here and in the banner on the live map."
              />
            </Card>
          ) : (
            shares.map((share) => (
              <ShareRow
                key={share.id}
                share={share}
                placeName={places.find((p) => p.id === share.arrivePlaceId)?.name}
                revoking={revokeShare.isPending}
                onRevoke={() => revokeShare.mutate(share.id)}
                onCopy={() => void copyLink(share.link)}
              />
            ))
          )}
        </View>
      </View>
    </ScrollView>
  );
}

function ShareRow({
  share,
  placeName,
  revoking,
  onRevoke,
  onCopy,
}: {
  share: Share;
  placeName?: string;
  revoking?: boolean;
  onRevoke: () => void;
  onCopy: () => void;
}) {
  return (
    <Card style={styles.shareRow}>
      <Dot size={9} color={palette.amberDot} blink />
      <View style={ui.flex}>
        <Txt variant="bodySemi">{share.label}</Txt>
        <Txt variant="tiny" color={color.textSubtle}>
          {describeShare(share, placeName)}
        </Txt>
      </View>
      <Button label="Copy" variant="ghost" small onPress={onCopy} />
      <Button label="Revoke" variant="danger" small loading={revoking} onPress={onRevoke} />
    </Card>
  );
}

function describeShare(share: Share, placeName?: string): string {
  switch (share.mode) {
    case 'until_arrive':
      return `Until I arrive ${placeName ?? 'a place'} · auto-revokes on arrive`;
    case 'duration':
      return share.expiresAt ? `Timed · expires ${formatClock(share.expiresAt)}` : 'Timed';
    case 'until_revoke':
      return 'Until revoked · no expiry';
  }
}

/**
 * copyLink puts the URL where the user can paste it. The clipboard API is
 * web-only here, so native uses the OS share sheet — which is what a phone user
 * actually wants anyway.
 */
async function copyLink(link: string) {
  if (Platform.OS === 'web') {
    try {
      await navigator.clipboard.writeText(link);
      return;
    } catch {
      // Clipboard permission denied; fall through to the share sheet.
    }
  }
  try {
    await RNShare.share({ message: link, url: link });
  } catch {
    // The user dismissed the sheet.
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.page, paddingHorizontal: space.pageX, gap: space.page, maxWidth: 820 },
  header: { gap: 5 },
  subtitle: { maxWidth: 640 },

  topRow: { flexDirection: 'row', gap: space.xl },
  topRowPhone: { flexDirection: 'column' },

  createCard: { gap: space.lg, borderRadius: radius.cardLg, padding: space.xxl },
  cardHint: { marginTop: -8 },
  modes: { gap: space.md },
  inlineField: { gap: 6 },
  placePicker: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  placeChip: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  placeChipActive: { backgroundColor: color.accentSoft },
  generate: { marginTop: 4 },
  linkBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.surfaceMuted,
    borderRadius: radius.lg,
    padding: space.lg,
  },

  previewCard: {
    backgroundColor: color.ink,
    borderRadius: radius.cardLg,
    padding: space.xxl,
    gap: 10,
    minHeight: 240,
  },
  previewCardWide: { flex: 1 },
  previewMap: { flex: 1, minHeight: 150, borderRadius: radius.lg, overflow: 'hidden' },
  previewCaption: { position: 'absolute', left: 14, bottom: 12 },
  previewUrl: { marginTop: 2 },

  list: { gap: 9 },
  shareRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14, paddingHorizontal: 16 },
});

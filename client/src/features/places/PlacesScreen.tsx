import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useCreatePlace, useDeletePlace, useOverview, useUpdatePlace } from '@/api/hooks';
import type { Place } from '@/api/types';
import { MapCanvas } from '@/components/map/MapCanvas';
import { formatMetres } from '@/components/map/geometry';
import { fitBounds } from '@/components/map/projection';
import { Button, Card, Chip, EmptyState, Sheet, TriggerBadge, styles as ui } from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, palette, radius, size, space } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';

import { PlaceForm } from './PlaceForm';

/**
 * The Places grid.
 *
 * Each card carries the three facts that decide whether a fence will behave:
 * its radius, which triggers are armed, and how many notes depend on it. The
 * preview is the local canvas rather than a GL map — a dozen live GL contexts on
 * one screen is a waste, and at 96 px the difference is a texture, not information.
 */
export function PlacesScreen({ search }: { search?: string }) {
  const router = useRouter();
  const { isPhone, width } = useLayoutMode();
  const { data, isLoading } = useOverview();
  const createPlace = useCreatePlace();
  const updatePlace = useUpdatePlace();
  const deletePlace = useDeletePlace();

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Place | null>(null);

  const places = useMemo(() => {
    const all = data?.places ?? [];
    const query = (search ?? '').trim().toLowerCase();
    if (!query) return all;
    return all.filter(
      (p) => p.name.toLowerCase().includes(query) || p.tags.some((t) => t.includes(query)),
    );
  }, [data?.places, search]);

  // A responsive grid without a grid library: pick a column count from the
  // available width, matching the mock's minmax(300px, 1fr).
  const columns = Math.max(1, Math.min(4, Math.floor((width - (isPhone ? 40 : 300)) / 320)));

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <View style={ui.flex}>
          <Txt variant="h1">Places</Txt>
          <Txt variant="body" color={color.textMuted} style={styles.subtitle}>
            Geofences you&apos;ve drawn. Attach notes and triggers to any of them.
          </Txt>
        </View>
        <Button label="New place" icon="plus" onPress={() => setCreating(true)} />
      </View>

      {isLoading ? (
        <Txt variant="small" color={color.textMuted}>
          Loading places…
        </Txt>
      ) : places.length === 0 ? (
        <Card>
          <EmptyState
            title={search ? `No places match “${search}”` : 'No places yet'}
            body="Draw one on the live map, or create it here with coordinates."
            action={<Button label="New place" icon="plus" onPress={() => setCreating(true)} />}
          />
        </Card>
      ) : (
        <View style={styles.grid}>
          {places.map((place) => (
            <View key={place.id} style={{ width: `${100 / columns}%`, padding: space.md }}>
              <PlaceCard
                place={place}
                onPress={() => setEditing(place)}
                // The live map owns the shape editor; it opens on this fence.
                onEditOnMap={() => router.push({ pathname: '/', params: { edit: place.id } })}
              />
            </View>
          ))}
        </View>
      )}

      <Sheet visible={creating} onClose={() => setCreating(false)} title="New place" phone={isPhone}>
        <PlaceForm
          submitting={createPlace.isPending}
          error={createPlace.error instanceof Error ? createPlace.error.message : undefined}
          onCancel={() => setCreating(false)}
          onSubmit={(values) => createPlace.mutate(values, { onSuccess: () => setCreating(false) })}
        />
      </Sheet>

      <Sheet
        visible={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `Edit ${editing.name}` : 'Edit place'}
        phone={isPhone}
      >
        {editing ? (
          <PlaceForm
            initial={editing}
            submitting={updatePlace.isPending || deletePlace.isPending}
            error={updatePlace.error instanceof Error ? updatePlace.error.message : undefined}
            onCancel={() => setEditing(null)}
            onDelete={() => deletePlace.mutate(editing.id, { onSuccess: () => setEditing(null) })}
            onSubmit={(values) =>
              updatePlace.mutate({ id: editing.id, ...values }, { onSuccess: () => setEditing(null) })
            }
          />
        ) : null}
      </Sheet>
    </ScrollView>
  );
}

function PlaceCard({ place, onPress, onEditOnMap }: { place: Place; onPress: () => void; onEditOnMap: () => void }) {
  const passby = place.triggers.includes('passby');
  const polygon = place.shape === 'polygon' && place.polygon.length >= 3 ? place.polygon : null;
  const tone = passby ? 'amber' : 'accent';
  // A polygon is framed by its corners: its bounding radius overstates how
  // much map a long thin shape needs. The box is the preview's typical size.
  const framed = polygon ? fitBounds(polygon, 320, 96, 10, 17) : null;

  return (
    <Card padded={false} style={styles.card} onPress={onPress}>
      <View style={styles.preview}>
        <MapCanvas
          center={framed?.center ?? place.center}
          // A zoom that frames the fence: bigger fences pull the camera back.
          zoom={framed?.zoom ?? (place.radiusM > 400 ? 13 : place.radiusM > 150 ? 14.5 : 15.5)}
          fences={
            polygon
              ? []
              : [{ id: place.id, center: place.center, radiusM: place.radiusM, tone, dashed: passby }]
          }
          // A polygon's outline is drawn as a closed track: the preview is the
          // canvas renderer, whose fence layer only knows circles.
          tracks={polygon ? [{ id: `${place.id}-ring`, points: [...polygon, polygon[0]!], tone, width: 2 }] : []}
          markers={[{ id: `${place.id}-pin`, point: place.center, tone, small: true }]}
        />
      </View>

      <View style={styles.cardBody}>
        <View style={styles.cardHead}>
          <Txt variant="cardTitle" numberOfLines={1} style={ui.flex}>
            {place.name}
          </Txt>
          {place.tags[0] ? <Chip label={place.tags[0]} mono /> : null}
        </View>

        <View style={styles.triggerRow}>
          {place.triggers.map((trigger) => (
            <TriggerBadge key={trigger} trigger={trigger} />
          ))}
        </View>

        <View style={styles.metaRow}>
          <Mono size={size.monoXs} color={color.textMuted}>
            {polygon ? `⬠ polygon · ${polygon.length} corners` : `◎ ${formatMetres(place.radiusM)}`}
          </Mono>
          <Mono size={size.monoXs} color={color.textMuted}>
            ✎ {place.stats?.notes ?? 0} notes
          </Mono>
          <Mono size={size.monoXs} color={color.textMuted}>
            ⚡ {place.stats?.events ?? 0} fired
          </Mono>
          {place.triggers.includes('dwell') && place.dwellMins > 0 ? (
            <Mono size={size.monoXs} color={color.textMuted}>
              ⏱ {place.dwellMins} min
            </Mono>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit ${place.name} on the map`}
          onPress={onEditOnMap}
          style={({ pressed }) => [styles.mapAction, pressed && styles.mapActionPressed]}
        >
          <Txt variant="small" color={palette.accentDark} style={styles.mapActionText}>
            Edit on map →
          </Txt>
        </Pressable>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: { padding: space.page, paddingHorizontal: space.pageX, gap: space.xxl },
  header: { flexDirection: 'row', alignItems: 'flex-end', gap: space.xl, flexWrap: 'wrap' },
  subtitle: { marginTop: 5, maxWidth: 560 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', margin: -space.md },
  card: { overflow: 'hidden', borderRadius: radius.cardLg },
  preview: { height: 96, backgroundColor: color.mapBg },
  cardBody: { paddingHorizontal: 15, paddingTop: 14, paddingBottom: 15, gap: 9 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  triggerRow: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  metaRow: { flexDirection: 'row', gap: 14, flexWrap: 'wrap' },
  mapAction: {
    alignSelf: 'flex-start',
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: 8,
    marginLeft: -8,
    borderRadius: radius.md,
  },
  mapActionPressed: { backgroundColor: color.accentSoft },
  mapActionText: { fontWeight: '600' },
});

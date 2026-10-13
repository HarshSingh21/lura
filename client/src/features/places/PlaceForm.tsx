import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import type { Place, Point, Trigger } from '@/api/types';
import { TRIGGERS } from '@/api/types';
import { boundingRadiusM, formatMetres } from '@/components/map/geometry';
import type { FenceGeometry } from '@/components/map/types';
import { Icon } from '@/components/ui/Icon';
import { Button, Field, styles as ui } from '@/components/ui/primitives';
import { usePeople } from '@/features/people/api';
import { partitionPeople } from '@/features/people/peer';
import { PersonPicker, peerOption } from '@/features/people/PersonPicker';
import { Mono, Txt } from '@/theme/text';
import { color, font, palette, radius, size, space } from '@/theme/tokens';
import { useTouchTargets } from '@/theme/touch';

/**
 * The place editor, shared by "Draw a place" on the map and "New place" in the
 * grid.
 *
 * HLD §14 specifies React Hook Form + Zod, and the Zod schema does real work here:
 * the radius and trigger rules it enforces are the same ones the server enforces
 * (internal/httpapi validatePlace), so a mistake is caught before a round trip
 * instead of coming back as a 400. The server remains the authority — this is a
 * faster copy of its rules, not a replacement for them.
 */

export const placeSchema = z.object({
  name: z.string().trim().min(1, 'Give the place a name').max(120, 'Name is too long'),
  tags: z.string().optional(),
  lat: z.coerce.number().min(-90, 'Latitude out of range').max(90, 'Latitude out of range'),
  lon: z.coerce.number().min(-180, 'Longitude out of range').max(180, 'Longitude out of range'),
  radiusM: z.coerce
    .number()
    .int('Radius must be a whole number of metres')
    // Below ~20 m a fence sits inside GPS noise; above 5 km it is a region.
    .min(20, 'Radius must be at least 20 m')
    .max(5000, 'Radius must be at most 5000 m'),
  triggers: z.array(z.enum(['arrive', 'leave', 'dwell', 'passby'])).min(1, 'Pick at least one trigger'),
  dwellMins: z.coerce.number().int().min(0).max(1440).optional(),
});

export type PlaceFormValues = {
  name: string;
  tags: string;
  lat: string;
  lon: string;
  radiusM: string;
  triggers: Trigger[];
  dwellMins: string;
  watchUserIds: string[];
};

/**
 * PlaceSubmit carries the fence's geometry in the shape the API takes it: a
 * circle as centre + radius, a polygon as its ring alone (the server derives
 * the centroid and bounding radius).
 */
export type PlaceSubmit = {
  name: string;
  tags: string[];
  triggers: Trigger[];
  dwellMins: number;
  /** Connected people whose crossings of this place notify me. */
  watchUserIds: string[];
} & FenceGeometry;

/** Polygon places edit their shape on the map, so the form only checks the rest. */
const polygonPlaceSchema = placeSchema.omit({ lat: true, lon: true, radiusM: true });

const TRIGGER_HELP: Record<Trigger, string> = {
  arrive: 'Fires once you have actually stopped here, not while driving through.',
  // A polygon is not a circle: the help names the place, whatever its shape.
  leave: 'Fires when you leave the place.',
  dwell: 'Fires after you have stayed for the dwell time below.',
  passby: 'Fires when you pass through while still moving.',
};

export function PlaceForm({
  initial,
  seedPoint,
  geometry,
  submitting,
  error,
  onSubmit,
  onCancel,
  onDelete,
}: {
  initial?: Place;
  seedPoint?: { lat: number; lon: number };
  /** A shape drawn on the map; it wins over `initial`'s geometry and `seedPoint`. */
  geometry?: FenceGeometry;
  submitting?: boolean;
  error?: string;
  onSubmit: (values: PlaceSubmit) => void;
  onCancel?: () => void;
  onDelete?: () => void;
}) {
  const touch = useTouchTargets();
  // The ring this form saves, when the place is (or was just drawn as) a polygon.
  const polygon: Point[] | null =
    geometry?.shape === 'polygon'
      ? geometry.polygon
      : !geometry && initial?.shape === 'polygon' && initial.polygon.length >= 3
        ? initial.polygon
        : null;
  const drawnCircle = geometry?.shape === 'circle' ? geometry : undefined;

  const defaults = useMemo<PlaceFormValues>(
    () => ({
      name: initial?.name ?? '',
      tags: (initial?.tags ?? []).join(', '),
      lat: drawnCircle ? drawnCircle.center.lat.toFixed(6) : String(initial?.center.lat ?? seedPoint?.lat ?? ''),
      lon: drawnCircle ? drawnCircle.center.lon.toFixed(6) : String(initial?.center.lon ?? seedPoint?.lon ?? ''),
      radiusM: String(drawnCircle?.radiusM ?? initial?.radiusM ?? 120),
      triggers: initial?.triggers ?? ['arrive'],
      dwellMins: String(initial?.dwellMins ?? 45),
      watchUserIds: initial?.watchUserIds ?? [],
    }),
    [initial, seedPoint, drawnCircle],
  );

  const { control, handleSubmit, setError, formState } = useForm<PlaceFormValues>({
    defaultValues: defaults,
  });

  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const noteCount = initial?.stats?.notes ?? 0;

  const triggers = useWatch({ control, name: 'triggers' });
  const wantsDwell = triggers.includes('dwell');

  // Only accepted connections can be watched (the server answers not_connected
  // otherwise). Someone who has paused sharing stays pickable — the watch
  // resumes the moment they share again — but says so.
  const people = usePeople();
  const connected = partitionPeople(people.data?.people ?? []).accepted;

  const submit = handleSubmit((values) => {
    const parsed = polygon ? polygonPlaceSchema.safeParse(values) : placeSchema.safeParse(values);
    if (!parsed.success) {
      // Map Zod's issues onto the fields so each message lands under its input.
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === 'string') {
          setError(field as keyof PlaceFormValues, { message: issue.message });
        }
      }
      return;
    }
    const data = parsed.data;
    const rest = {
      name: data.name,
      tags: (data.tags ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      triggers: data.triggers,
      dwellMins: wantsDwell ? (data.dwellMins ?? 45) : 0,
      watchUserIds: values.watchUserIds ?? [],
    };
    if (polygon) {
      onSubmit({ ...rest, shape: 'polygon', polygon });
      return;
    }
    // The circle branch parsed with the full schema, so these fields exist.
    const circle = data as z.infer<typeof placeSchema>;
    onSubmit({ ...rest, shape: 'circle', center: { lat: circle.lat, lon: circle.lon }, radiusM: circle.radiusM });
  });

  return (
    <View style={styles.form}>
      <Controller
        control={control}
        name="name"
        render={({ field }) => (
          <Field
            label="Name"
            placeholder="Whole Foods"
            value={field.value}
            onChangeText={field.onChange}
            error={formState.errors.name?.message}
            autoCapitalize="words"
          />
        )}
      />

      <Controller
        control={control}
        name="tags"
        render={({ field }) => (
          <Field
            label="Tags"
            placeholder="grocery, errands"
            hint="Comma separated. Tags are how a note finds its place."
            value={field.value}
            onChangeText={field.onChange}
            autoCapitalize="none"
          />
        )}
      />

      {polygon ? (
        <View style={styles.shapeBox}>
          <Txt variant="small" color={color.textMuted} style={styles.blockLabel}>
            Shape
          </Txt>
          <Mono size={size.monoSm} color={color.textBody}>
            Polygon · {polygon.length} corners · {formatMetres(boundingRadiusM(polygon))} from the centre
          </Mono>
          <Txt variant="micro" color={color.textFaint}>
            Move or reshape it on the live map: tap the fence, then “Edit shape”.
          </Txt>
        </View>
      ) : (
        <>
        <View style={styles.row}>
          <Controller
            control={control}
            name="lat"
            render={({ field }) => (
              <Field
                label="Latitude"
                placeholder="12.9611"
                value={field.value}
                onChangeText={field.onChange}
                error={formState.errors.lat?.message}
                keyboardType="numbers-and-punctuation"
                style={ui.flex}
              />
            )}
          />
          <Controller
            control={control}
            name="lon"
            render={({ field }) => (
              <Field
                label="Longitude"
                placeholder="77.6387"
                value={field.value}
                onChangeText={field.onChange}
                error={formState.errors.lon?.message}
                keyboardType="numbers-and-punctuation"
                style={ui.flex}
              />
            )}
          />
        </View>

        <Controller
          control={control}
          name="radiusM"
          render={({ field }) => (
            <View style={styles.radiusBlock}>
              <Field
                label="Radius (metres)"
                value={field.value}
                onChangeText={field.onChange}
                error={formState.errors.radiusM?.message}
                keyboardType="number-pad"
              />
              <View style={styles.presets}>
                {[60, 120, 200, 500].map((preset) => (
                  <Pressable
                    key={preset}
                    accessibilityRole="button"
                    onPress={() => field.onChange(String(preset))}
                    style={[styles.preset, touch && styles.presetTouch, Number(field.value) === preset && styles.presetActive]}
                  >
                    <Mono
                      size={size.monoXs}
                      color={Number(field.value) === preset ? palette.accentInk : color.textMuted}
                    >
                      {preset} m
                    </Mono>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        />
        </>
      )}

      <Controller
        control={control}
        name="triggers"
        render={({ field }) => (
          <View style={styles.triggerBlock}>
            <Txt variant="small" color={color.textMuted} style={styles.blockLabel}>
              Triggers
            </Txt>
            {TRIGGERS.map((trigger) => {
              const selected = field.value.includes(trigger);
              return (
                <Pressable
                  key={trigger}
                  accessibilityRole="checkbox"
                  aria-checked={selected}
                  onPress={() =>
                    field.onChange(
                      selected ? field.value.filter((t) => t !== trigger) : [...field.value, trigger],
                    )
                  }
                  style={[styles.triggerRow, selected && styles.triggerRowSelected]}
                >
                  {/* A tick, not just a filled square: on and off must read apart at a glance. */}
                  <View style={[styles.triggerBox, selected && styles.triggerBoxOn]}>
                    {selected ? <Icon name="check" size={12} color="#ffffff" strokeWidth={2.4} /> : null}
                  </View>
                  <View style={ui.flex}>
                    <Txt variant="bodyMedium" color={selected ? color.textStrong : color.textMuted}>
                      {trigger === 'passby' ? 'Pass by' : trigger.charAt(0).toUpperCase() + trigger.slice(1)}
                    </Txt>
                    <Txt variant="micro" color={color.textFaint}>
                      {TRIGGER_HELP[trigger]}
                    </Txt>
                  </View>
                </Pressable>
              );
            })}
            {formState.errors.triggers ? (
              <Txt variant="micro" color={palette.dangerInk}>
                {formState.errors.triggers.message}
              </Txt>
            ) : null}
          </View>
        )}
      />

      {wantsDwell ? (
        <Controller
          control={control}
          name="dwellMins"
          render={({ field }) => (
            <Field
              label="Dwell time (minutes)"
              hint="How long you must stay before the dwell reminder fires."
              value={field.value}
              onChangeText={field.onChange}
              keyboardType="number-pad"
            />
          )}
        />
      ) : null}

      <Controller
        control={control}
        name="watchUserIds"
        render={({ field }) => (
          <View style={styles.triggerBlock}>
            <Txt variant="small" color={color.textMuted} style={styles.blockLabel}>
              Watch people
            </Txt>
            {connected.length === 0 ? (
              <Txt variant="micro" color={color.textFaint}>
                Connect with someone under People to be told when they cross this place.
              </Txt>
            ) : (
              <>
                <PersonPicker
                  multiple
                  accessibilityLabel="People whose crossings of this place notify you"
                  options={connected.map((peer) => {
                    const option = peerOption(peer);
                    return peer.sharingWithMe ? option : { ...option, hint: 'paused · resumes when they share' };
                  })}
                  selected={field.value}
                  onToggle={(id) =>
                    field.onChange(
                      field.value.includes(id) ? field.value.filter((x) => x !== id) : [...field.value, id],
                    )
                  }
                />
                <Txt variant="micro" color={color.textFaint}>
                  You are notified when they {triggers.length === 1 && triggers[0] === 'passby' ? 'pass by' : 'cross'} here,
                  using the triggers above. They are not told.
                </Txt>
              </>
            )}
          </View>
        )}
      />

      {error ? (
        <View style={styles.errorBox}>
          <Txt variant="small" color={palette.dangerInk}>
            {error}
          </Txt>
        </View>
      ) : null}

      {confirmingDelete && onDelete ? (
        // Deleting a fence is not undoable and silently changes what its notes
        // do, so it says so before it happens.
        <View style={styles.confirmBox} accessibilityRole="alert">
          <Txt variant="small" color={palette.dangerInk} style={styles.confirmTitle}>
            Delete {initial?.name ?? 'this place'}?
          </Txt>
          <Txt variant="small" color={color.textBody}>
            {noteCount > 0
              ? `Its ${noteCount === 1 ? 'note keeps its' : `${noteCount} notes keep their`} text but will no longer fire here. Nothing about this place will notify anyone again.`
              : 'Nothing about this place will notify anyone again.'}
          </Txt>
          <View style={styles.actions}>
            <View style={ui.flex} />
            <Button label="Keep it" variant="ghost" onPress={() => setConfirmingDelete(false)} />
            <Button
              label={`Delete ${initial?.name ?? 'place'}`}
              variant="danger"
              onPress={onDelete}
              loading={submitting}
            />
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          {onDelete ? <Button label="Delete" variant="danger" onPress={() => setConfirmingDelete(true)} /> : null}
          <View style={ui.flex} />
          {onCancel ? <Button label="Cancel" variant="ghost" onPress={onCancel} /> : null}
          <Button label={initial ? 'Save place' : 'Create place'} onPress={submit} loading={submitting} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.xl },
  row: { flexDirection: 'row', gap: space.lg },
  blockLabel: { fontFamily: font.sansMedium, marginBottom: 2 },

  radiusBlock: { gap: space.md },
  shapeBox: {
    gap: 4,
    borderWidth: 1,
    borderColor: color.borderInput,
    borderRadius: radius.lg,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  presets: { flexDirection: 'row', gap: space.md, flexWrap: 'wrap' },
  preset: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  presetActive: { backgroundColor: color.accentSoft },
  presetTouch: { minHeight: 44, minWidth: 52, justifyContent: 'center', alignItems: 'center' },

  triggerBlock: { gap: space.md },
  triggerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderWidth: 1,
    borderColor: color.borderInput,
    borderRadius: radius.lg,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  triggerRowSelected: { borderColor: 'rgba(32,160,123,0.5)', backgroundColor: 'rgba(32,160,123,0.06)' },
  triggerBox: {
    width: 18,
    height: 18,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: color.checkbox,
    marginTop: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  triggerBoxOn: { backgroundColor: palette.accent, borderColor: palette.accent },

  errorBox: {
    backgroundColor: 'rgba(200,101,86,0.1)',
    borderWidth: 1,
    borderColor: palette.danger,
    borderRadius: radius.lg,
    padding: space.lg,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.md, flexWrap: 'wrap' },
  confirmBox: {
    gap: space.md,
    backgroundColor: 'rgba(200,101,86,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(200,101,86,0.45)',
    borderRadius: radius.lg,
    padding: space.lg,
  },
  confirmTitle: { fontFamily: font.sansSemiBold },
});

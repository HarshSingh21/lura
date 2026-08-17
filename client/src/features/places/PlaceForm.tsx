import { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import type { Place, Trigger } from '@/api/types';
import { TRIGGERS } from '@/api/types';
import { Button, Field, styles as ui } from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, font, palette, radius, size, space } from '@/theme/tokens';

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
};

export type PlaceSubmit = {
  name: string;
  tags: string[];
  center: { lat: number; lon: number };
  radiusM: number;
  triggers: Trigger[];
  dwellMins: number;
};

const TRIGGER_HELP: Record<Trigger, string> = {
  arrive: 'Fires once you have actually stopped here, not while driving through.',
  leave: 'Fires when you leave the circle.',
  dwell: 'Fires after you have stayed for the dwell time below.',
  passby: 'Fires when you pass through while still moving.',
};

export function PlaceForm({
  initial,
  seedPoint,
  submitting,
  error,
  onSubmit,
  onCancel,
  onDelete,
}: {
  initial?: Place;
  seedPoint?: { lat: number; lon: number };
  submitting?: boolean;
  error?: string;
  onSubmit: (values: PlaceSubmit) => void;
  onCancel?: () => void;
  onDelete?: () => void;
}) {
  const defaults = useMemo<PlaceFormValues>(
    () => ({
      name: initial?.name ?? '',
      tags: (initial?.tags ?? []).join(', '),
      lat: String(initial?.center.lat ?? seedPoint?.lat ?? ''),
      lon: String(initial?.center.lon ?? seedPoint?.lon ?? ''),
      radiusM: String(initial?.radiusM ?? 120),
      triggers: initial?.triggers ?? ['arrive'],
      dwellMins: String(initial?.dwellMins ?? 45),
    }),
    [initial, seedPoint],
  );

  const { control, handleSubmit, setError, watch, formState } = useForm<PlaceFormValues>({
    defaultValues: defaults,
  });

  const triggers = watch('triggers');
  const wantsDwell = triggers.includes('dwell');

  const submit = handleSubmit((values) => {
    const parsed = placeSchema.safeParse(values);
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
    onSubmit({
      name: data.name,
      tags: (data.tags ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
      center: { lat: data.lat, lon: data.lon },
      radiusM: data.radiusM,
      triggers: data.triggers,
      dwellMins: wantsDwell ? (data.dwellMins ?? 45) : 0,
    });
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
                  style={[styles.preset, Number(field.value) === preset && styles.presetActive]}
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
                  accessibilityState={{ checked: selected }}
                  onPress={() =>
                    field.onChange(
                      selected ? field.value.filter((t) => t !== trigger) : [...field.value, trigger],
                    )
                  }
                  style={[styles.triggerRow, selected && styles.triggerRowSelected]}
                >
                  <View style={[styles.triggerBox, selected && styles.triggerBoxOn]} />
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

      {error ? (
        <View style={styles.errorBox}>
          <Txt variant="small" color={palette.dangerInk}>
            {error}
          </Txt>
        </View>
      ) : null}

      <View style={styles.actions}>
        {onDelete ? <Button label="Delete" variant="danger" onPress={onDelete} /> : null}
        <View style={ui.flex} />
        {onCancel ? <Button label="Cancel" variant="ghost" onPress={onCancel} /> : null}
        <Button label={initial ? 'Save place' : 'Create place'} onPress={submit} loading={submitting} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: space.xl },
  row: { flexDirection: 'row', gap: space.lg },
  blockLabel: { fontFamily: font.sansMedium, marginBottom: 2 },

  radiusBlock: { gap: space.md },
  presets: { flexDirection: 'row', gap: space.md, flexWrap: 'wrap' },
  preset: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  presetActive: { backgroundColor: color.accentSoft },

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
});

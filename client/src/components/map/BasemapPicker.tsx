import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { Txt } from '@/theme/text';
import { color, palette, radius, shadow } from '@/theme/tokens';

import { BASEMAP_IDS, BASEMAPS, type BasemapInfo } from './basemaps';
import type { BasemapId } from './types';

/**
 * BasemapPicker is the map's "layers" control: one compact button showing the
 * current basemap's thumbnail, which opens a small grid of the others.
 *
 * The thumbnails are drawn rather than fetched. A tile image per chip would be
 * six network requests every time the control opens — and in a weak signal, six
 * grey squares — while a drawn swatch reads instantly and still tells streets
 * from satellite at a glance.
 */
export function BasemapPicker({
  value,
  onChange,
  options = BASEMAP_IDS,
  align = 'right',
}: {
  value: BasemapId;
  onChange: (basemap: BasemapId) => void;
  /** Restrict the choices (e.g. a renderer that cannot draw some of them). */
  options?: readonly BasemapId[];
  /** Which edge the grid opens towards. */
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const current = BASEMAPS[value] ?? BASEMAPS.streets;

  return (
    <View style={[styles.root, align === 'left' ? styles.alignLeft : styles.alignRight]}>
      {open ? (
        <View style={styles.panel} accessibilityRole="radiogroup" accessibilityLabel="Basemap">
          {options.map((id) => {
            const info = BASEMAPS[id];
            const selected = id === value;
            return (
              <Pressable
                key={id}
                accessibilityRole="radio"
                aria-selected={selected}
                accessibilityLabel={`${info.label} map`}
                onPress={() => {
                  onChange(id);
                  setOpen(false);
                }}
                style={({ pressed }) => [styles.chip, pressed ? styles.pressed : null]}
              >
                <View style={[styles.thumbFrame, selected ? styles.thumbSelected : null]}>
                  <Thumbnail info={info} size={46} />
                </View>
                <Txt variant="micro" color={selected ? palette.accentInk : color.textMuted} style={styles.chipLabel}>
                  {info.label}
                </Txt>
              </Pressable>
            );
          })}
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? 'Close basemap picker' : `Change basemap, currently ${current.label}`}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.toggle, pressed ? styles.pressed : null]}
      >
        <Thumbnail info={current} size={30} />
        <View style={styles.toggleGlyph} pointerEvents="none">
          <LayersGlyph />
        </View>
      </Pressable>
    </View>
  );
}

/** Thumbnail draws a tiny abstract map in a basemap's colours. */
function Thumbnail({ info, size }: { info: BasemapInfo; size: number }) {
  const { ground, road, water, detail } = info.swatch;
  const s = size;
  return (
    <Svg width={s} height={s} viewBox="0 0 48 48">
      <Rect x={0} y={0} width={48} height={48} fill={ground} />
      {/* fields / blocks */}
      <Rect x={4} y={5} width={15} height={12} rx={2} fill={detail} opacity={0.8} />
      <Rect x={27} y={22} width={16} height={11} rx={2} fill={detail} opacity={0.7} />
      {/* water */}
      <Path d="M0 38 Q12 33 22 39 T48 37 L48 48 L0 48 Z" fill={water} />
      {/* roads */}
      <Path d="M-2 30 L20 20 L50 8" stroke={road} strokeWidth={3.2} fill="none" strokeLinecap="round" />
      <Path d="M24 -2 L22 50" stroke={road} strokeWidth={2.2} fill="none" />
      {info.labels ? (
        <>
          <Rect x={28} y={12} width={12} height={2.4} rx={1.2} fill={info.id === 'hybrid' ? '#ffffff' : '#5b6168'} />
          <Rect x={6} y={23} width={9} height={2.2} rx={1.1} fill={info.id === 'hybrid' ? '#ffffff' : '#5b6168'} />
        </>
      ) : null}
      {info.id === 'terrain' ? (
        <>
          <Circle cx={36} cy={27} r={9} stroke="#b59a70" strokeWidth={0.8} fill="none" />
          <Circle cx={36} cy={27} r={5} stroke="#b59a70" strokeWidth={0.8} fill="none" />
        </>
      ) : null}
    </Svg>
  );
}

function LayersGlyph() {
  return (
    <Svg width={14} height={14} viewBox="0 0 20 20">
      <Path d="M10 3 L18 7.5 L10 12 L2 7.5 Z" fill="#ffffff" stroke={color.textStrong} strokeWidth={1.4} strokeLinejoin="round" />
      <Path d="M2.5 11 L10 15.2 L17.5 11" fill="none" stroke={color.textStrong} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  alignRight: { alignItems: 'flex-end' },
  alignLeft: { alignItems: 'flex-start' },
  toggle: {
    width: 38,
    height: 38,
    borderRadius: radius.lg,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: color.surface,
    backgroundColor: color.surface,
    ...shadow('button'),
  },
  toggleGlyph: {
    position: 'absolute',
    right: 1,
    bottom: 1,
    width: 18,
    height: 18,
    borderRadius: 5,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: 3 * 62 + 2 * 4 + 16,
    gap: 4,
    padding: 8,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.card,
    ...shadow('card'),
  },
  chip: { width: 62, alignItems: 'center', paddingVertical: 4, borderRadius: radius.md },
  pressed: { opacity: 0.7 },
  thumbFrame: {
    width: 50,
    height: 50,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  thumbSelected: { borderColor: palette.accent },
  chipLabel: { marginTop: 3, fontWeight: '600' },
});

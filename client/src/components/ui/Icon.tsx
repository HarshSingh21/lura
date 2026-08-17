import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { color } from '@/theme/tokens';

/**
 * Icons, transcribed from the design mock's inline SVGs.
 *
 * react-native-svg renders the same paths on web, iOS and Android, so there is
 * one icon set for all three surfaces rather than a web sprite plus a native font.
 * Each icon keeps the mock's 20×20 viewBox and 1.7 stroke so the optical weight
 * matches the original at any size.
 */

export type IconName =
  | 'live'
  | 'people'
  | 'places'
  | 'notes'
  | 'sharing'
  | 'history'
  | 'settings'
  | 'search'
  | 'plus'
  | 'minus'
  | 'crosshair'
  | 'check'
  | 'airgap'
  | 'close'
  | 'chevron-up'
  | 'chevron-down';

export type IconProps = {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
};

export function Icon({ name, size = 18, color: stroke = color.textBody, strokeWidth = 1.7 }: IconProps) {
  const common = { stroke, strokeWidth, fill: 'none' as const, strokeLinecap: 'round' as const };

  switch (name) {
    case 'live':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Circle cx={10} cy={10} r={2.4} fill={stroke} />
          <Circle cx={10} cy={10} r={6.5} {...common} />
        </Svg>
      );

    // Two figures, the nearer one whole and the further one implied — the same
    // read as the avatar stack in the rail, at 20 dp.
    case 'people':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Circle cx={7.6} cy={6.4} r={2.9} {...common} />
          <Path d="M2.4 16.4c0-2.7 2.3-4.4 5.2-4.4s5.2 1.7 5.2 4.4" {...common} />
          <Path d="M13.4 4.2a2.9 2.9 0 0 1 0 5.4" {...common} />
          <Path d="M14.6 12.4c1.9.4 3.2 1.8 3.2 4" {...common} />
        </Svg>
      );

    case 'places':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Rect x={3} y={3} width={6} height={6} rx={1.6} {...common} />
          <Rect x={11} y={3} width={6} height={6} rx={1.6} {...common} />
          <Rect x={3} y={11} width={6} height={6} rx={1.6} {...common} />
          <Rect x={11} y={11} width={6} height={6} rx={1.6} {...common} />
        </Svg>
      );

    case 'notes':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Rect x={4} y={3} width={12} height={14} rx={2} {...common} />
          <Line x1={7} y1={7} x2={13} y2={7} {...common} />
          <Line x1={7} y1={10} x2={13} y2={10} {...common} />
          <Line x1={7} y1={13} x2={10.5} y2={13} {...common} />
        </Svg>
      );

    case 'sharing':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Circle cx={6} cy={10} r={2.2} {...common} />
          <Circle cx={14} cy={5} r={2.2} {...common} />
          <Circle cx={14} cy={15} r={2.2} {...common} />
          <Line x1={7.9} y1={8.9} x2={12.1} y2={6.1} {...common} />
          <Line x1={7.9} y1={11.1} x2={12.1} y2={13.9} {...common} />
        </Svg>
      );

    case 'history':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Circle cx={10} cy={10} r={6.5} {...common} />
          <Line x1={10} y1={10} x2={10} y2={6.2} {...common} />
          <Line x1={10} y1={10} x2={12.6} y2={11.6} {...common} />
        </Svg>
      );

    case 'settings':
      // Three sliders with knobs: the mock fills the knobs with the surface colour
      // so the track appears to pass behind them.
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Line x1={3} y1={6} x2={17} y2={6} {...common} />
          <Line x1={3} y1={10} x2={17} y2={10} {...common} />
          <Line x1={3} y1={14} x2={17} y2={14} {...common} />
          <Circle cx={7} cy={6} r={2} {...common} fill={color.surface} />
          <Circle cx={13} cy={10} r={2} {...common} fill={color.surface} />
          <Circle cx={8} cy={14} r={2} {...common} fill={color.surface} />
        </Svg>
      );

    case 'search':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Circle cx={9} cy={9} r={6} {...common} />
          <Line x1={13.5} y1={13.5} x2={17} y2={17} {...common} />
        </Svg>
      );

    case 'plus':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Line x1={10} y1={4} x2={10} y2={16} {...common} strokeWidth={2} />
          <Line x1={4} y1={10} x2={16} y2={10} {...common} strokeWidth={2} />
        </Svg>
      );

    case 'minus':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Line x1={4} y1={10} x2={16} y2={10} {...common} strokeWidth={2} />
        </Svg>
      );

    case 'crosshair':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Circle cx={10} cy={10} r={3} {...common} strokeWidth={1.8} />
          <Line x1={10} y1={1.5} x2={10} y2={4} {...common} strokeWidth={1.8} />
          <Line x1={10} y1={16} x2={10} y2={18.5} {...common} strokeWidth={1.8} />
          <Line x1={1.5} y1={10} x2={4} y2={10} {...common} strokeWidth={1.8} />
          <Line x1={16} y1={10} x2={18.5} y2={10} {...common} strokeWidth={1.8} />
        </Svg>
      );

    case 'check':
      return (
        <Svg width={size} height={size} viewBox="0 0 16 16">
          <Path d="M3 8.5 L6.5 12 L13 4" {...common} strokeWidth={2.4} strokeLinejoin="round" />
        </Svg>
      );

    case 'airgap':
      // A wifi arc struck through: no outbound calls.
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Path d="M4 10 a6 6 0 0 1 12 0" {...common} strokeWidth={1.8} />
          <Line x1={10} y1={10} x2={10} y2={16} {...common} strokeWidth={1.8} />
          <Line x1={3} y1={3} x2={17} y2={17} {...common} strokeWidth={1.8} />
        </Svg>
      );

    case 'close':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Line x1={5} y1={5} x2={15} y2={15} {...common} strokeWidth={1.8} />
          <Line x1={15} y1={5} x2={5} y2={15} {...common} strokeWidth={1.8} />
        </Svg>
      );

    case 'chevron-up':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Path d="M5 12.5 L10 7.5 L15 12.5" {...common} strokeWidth={1.9} strokeLinejoin="round" />
        </Svg>
      );

    case 'chevron-down':
      return (
        <Svg width={size} height={size} viewBox="0 0 20 20">
          <Path d="M5 7.5 L10 12.5 L15 7.5" {...common} strokeWidth={1.9} strokeLinejoin="round" />
        </Svg>
      );
  }
}

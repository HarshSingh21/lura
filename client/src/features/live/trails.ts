import { create } from 'zustand';

import type { Position } from '@/api/types';

import { pushTrail, trailPointOf, type TrailPoint } from './motion';

/**
 * The recent-fixes buffer behind every live marker's trail, heading and glide.
 *
 * It sits beside the main store rather than in it: the main store keeps one
 * position per device (what is true *now*), and this keeps the last thirty (how
 * they got there). Splitting them means a component that only needs "where is
 * Nishtha" does not re-render on bookkeeping it never reads, and the buffer can
 * be cleared with the connection without touching anything else.
 */
type TrailsState = {
  trails: Record<string, TrailPoint[]>;
  push: (p: Position) => void;
  clear: () => void;
};

export const useTrails = create<TrailsState>((set) => ({
  trails: {},
  push: (p) =>
    set((state) => {
      const point = trailPointOf(p);
      if (!point) return state;
      const prev = state.trails[p.deviceId];
      const next = pushTrail(prev, point);
      if (next === prev) return state;
      return { trails: { ...state.trails, [p.deviceId]: next } };
    }),
  clear: () => set({ trails: {} }),
}));

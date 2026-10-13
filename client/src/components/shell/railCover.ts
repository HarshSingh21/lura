import { create } from 'zustand';

/**
 * How tall the sticky reminder cards over the desktop Live rail are, in px
 * (0: none up, or the stack is not over the rail). Toasts measures it; the
 * Live rail pads its top by it (stackSlot.railTopPadding). Passing toasts are
 * left out on purpose: they go in seconds, and a rail that jumped for each
 * would be worse than one briefly covered.
 */
export const useRailCover = create<{ height: number; set: (height: number) => void }>((set) => ({
  height: 0,
  set: (height) => set((s) => (s.height === height ? s : { height })),
}));

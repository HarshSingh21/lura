import { Platform } from 'react-native';
import { create } from 'zustand';

import { DEFAULT_TOKEN, defaultBaseUrl, setConfig } from '@/api/client';
import type { GeoEvent, Position, Reminder } from '@/api/types';
import type { LiveStatus } from '@/api/live';

/**
 * Client-local state (HLD §14: Zustand for local, TanStack Query for server).
 *
 * The split is strict, and worth stating: anything the server owns is *not* here.
 * This store holds the live position stream, the toast queue, the connection
 * status and the server address — state with no server-side truth to invalidate
 * against. Devices, places and notes are never mirrored here, so there is exactly
 * one copy of them in the app.
 */

const STORAGE_KEY = 'lura.connection';

/** Live positions are keyed by device so the map can render the newest of each. */
export type LiveState = {
  positions: Record<string, Position>;
  lastEvent?: GeoEvent;
  status: LiveStatus;
  toasts: Toast[];
  /** Set when the server tells a share viewer their access changed. */
  aclNotice?: { action: string; reason?: string; at: number };
};

export type Toast = {
  id: string;
  title: string;
  body?: string;
  kind: 'reminder' | 'event' | 'error' | 'info';
  at: number;
};

export type ConnectionState = {
  baseUrl: string;
  token: string;
};

export type UiState = {
  /** Draw mode arms the map for "draw a place" (tap to place a new geofence). */
  drawing: boolean;
  selectedPlaceId?: string;
  selectedDeviceId?: string;
  /** Phone layout: whether the live rail sheet is expanded. */
  sheetOpen: boolean;
  /** Foreground location sharing from this device (native + web geolocation). */
  trackingEnabled: boolean;
  /** The top bar's search text; the Places grid filters on it. */
  search: string;
};

export type Store = LiveState &
  UiState & {
  connection: ConnectionState;

  applyPosition: (p: Position) => void;
  applyGeoEvent: (e: GeoEvent) => void;
  applyReminder: (r: Reminder) => void;
  applyAcl: (action: string, reason?: string) => void;
  setStatus: (s: LiveStatus) => void;

  pushToast: (t: Omit<Toast, 'id' | 'at'>) => void;
  dismissToast: (id: string) => void;

  setConnection: (next: Partial<ConnectionState>) => void;
  setDrawing: (drawing: boolean) => void;
  selectPlace: (id?: string) => void;
  selectDevice: (id?: string) => void;
  setSheetOpen: (open: boolean) => void;
  setTracking: (on: boolean) => void;
  setSearch: (query: string) => void;
};

/** loadConnection restores the server address on web; native starts from defaults. */
function loadConnection(): ConnectionState {
  const fallback = { baseUrl: defaultBaseUrl(), token: DEFAULT_TOKEN };
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ConnectionState>;
    return {
      baseUrl: parsed.baseUrl?.trim() || fallback.baseUrl,
      token: parsed.token?.trim() || fallback.token,
    };
  } catch {
    return fallback;
  }
}

function persistConnection(next: ConnectionState) {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A private-mode browser refusing storage is not worth failing over.
  }
}

const initialConnection = loadConnection();
setConfig(initialConnection);

let toastSeq = 0;

export const useStore = create<Store>((set, get) => ({
  positions: {},
  status: 'idle',
  toasts: [],

  drawing: false,
  sheetOpen: false,
  trackingEnabled: false,
  search: '',

  connection: initialConnection,

  applyPosition: (p) =>
    set((state) => {
      const current = state.positions[p.deviceId];
      // Drop-to-latest also applies on the client: an out-of-order frame must not
      // move a marker backwards, and the server's recv_ts is the authority.
      if (current && new Date(current.recvTs).getTime() > new Date(p.recvTs).getTime()) {
        return state;
      }
      return { positions: { ...state.positions, [p.deviceId]: p } };
    }),

  applyGeoEvent: (e) => set({ lastEvent: e }),

  applyReminder: (r) =>
    set((state) => ({
      toasts: [
        ...state.toasts.slice(-3),
        {
          id: `toast_${++toastSeq}`,
          title: r.title,
          body: r.body,
          kind: 'reminder' as const,
          at: Date.now(),
        },
      ],
    })),

  applyAcl: (action, reason) => set({ aclNotice: { action, reason, at: Date.now() } }),

  setStatus: (status) => set({ status }),

  pushToast: (t) =>
    set((state) => ({
      toasts: [...state.toasts.slice(-3), { ...t, id: `toast_${++toastSeq}`, at: Date.now() }],
    })),

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  setConnection: (next) => {
    const merged = { ...get().connection, ...next };
    setConfig(merged);
    persistConnection(merged);
    // Positions belong to the previous server; keeping them would draw another
    // deployment's markers on this one's map.
    set({ connection: merged, positions: {}, lastEvent: undefined });
  },

  setDrawing: (drawing) => set({ drawing }),
  selectPlace: (selectedPlaceId) => set({ selectedPlaceId }),
  selectDevice: (selectedDeviceId) => set({ selectedDeviceId }),
  setSheetOpen: (sheetOpen) => set({ sheetOpen }),
  setTracking: (trackingEnabled) => set({ trackingEnabled }),
  setSearch: (search) => set({ search }),
}));

/** Selectors, so components subscribe to the narrowest slice they need. */
export const selectPositions = (s: Store) => s.positions;
export const selectStatus = (s: Store) => s.status;
export const selectToasts = (s: Store) => s.toasts;
export const selectConnection = (s: Store) => s.connection;

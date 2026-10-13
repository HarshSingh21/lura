import { Platform } from 'react-native';
import { create } from 'zustand';

import { ApiError, DEFAULT_TOKEN, defaultBaseUrl, setConfig } from '@/api/client';
import type { GeoEvent, Point, Position, Reminder, ReminderRecord } from '@/api/types';
import type { LiveStatus } from '@/api/live';
import { isStored, postAck } from '@/api/reminders';
import { announce, focusTarget, reminderTag } from '@/features/notify/announce';
import { closeDesktop } from '@/features/notify/desktop';
import {
  fromGeo,
  fromReminder,
  ingest,
  markAllRead as markItemsRead,
  mergeStored,
  setReminderStatus,
  type NotificationItem,
} from '@/features/notify/model';
import {
  EMPTY_REMINDERS,
  beginAck,
  commitAck,
  dueCards,
  markChimed,
  reconcile,
  rollbackAck,
  upsert,
  acknowledge as ackCard,
  type ReminderCard,
  type RemindersState,
} from '@/features/notify/reminders';
import { inQuietHours, type QuietHours } from '@/features/notify/quiet';
import { loadMuted, saveMuted } from '@/features/notify/sound';
import { toastsAfter } from '@/features/notify/toasts';

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
  /** The signed-in user, from the socket's hello frame: tells my crossings from a peer's. */
  viewerId?: string;
};

/**
 * NotifyState is the notification centre: the session's crossings and
 * reminders, newest first, one entry per crossing (see features/notify/model).
 * It is client-local on purpose — the server's trigger log is the durable
 * record; this is "what did I hear about while this tab was open".
 */
export type NotifyState = {
  notifications: NotificationItem[];
  /** Per-viewer: mutes chimes and vibration, never the toast itself. */
  muted: boolean;
  /**
   * The viewer's quiet hours (Settings). Inside them a toast still appears but
   * makes no sound and raises no system notification — the in-app half of the
   * server holding back push (features/notify/quiet.ts).
   */
  quietHours: QuietHours | null;
  /**
   * A request to look at something on the Live map, made from a toast or the
   * panel. `seq` changes on every request so asking twice for the same place
   * still recentres.
   */
  focus?: { seq: number; placeId?: string; deviceId?: string; point?: Point };
  /**
   * Reminders waiting for an Acknowledge (release spec §6): the sticky cards.
   * The server's `reminders` table is the truth; this is the session's copy of
   * its pending rows, kept in step by the notify / reminder_ack frames and by
   * re-reading the pending list on load and on every reconnect.
   */
  reminders: RemindersState;
};

export type Toast = {
  id: string;
  title: string;
  body?: string;
  kind: 'reminder' | 'event' | 'error' | 'info';
  at: number;
  /** For reminder/event toasts: the notification-centre entry this toast announces. */
  notificationId?: string;
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
  UiState &
  NotifyState & {
  connection: ConnectionState;

  applyPosition: (p: Position) => void;
  /**
   * forgetDevices drops the live positions of devices the server no longer
   * lists (deleted, or no longer shared with me) whose last fix predates
   * `before` — so a removed phone does not haunt the map as a "new device".
   */
  forgetDevices: (known: ReadonlySet<string>, before: number) => void;
  applyGeoEvent: (e: GeoEvent) => void;
  applyReminder: (r: Reminder | ReminderRecord) => void;
  setViewer: (viewerId: string) => void;
  applyAcl: (action: string, reason?: string) => void;
  setStatus: (s: LiveStatus) => void;

  pushToast: (t: Omit<Toast, 'id' | 'at'>) => void;
  dismissToast: (id: string) => void;

  /**
   * notify records an entry and, the first time a crossing deserves it, toasts it
   * and plays its chime. Returns whether it announced.
   */
  notify: (item: NotificationItem) => { announced: boolean; item: NotificationItem };
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  clearNotifications: () => void;
  setMuted: (muted: boolean) => void;

  /** reconcileReminders applies GET /reminders?status=pending, read at `requestedAt`. */
  reconcileReminders: (records: ReminderRecord[], requestedAt: number) => void;
  /** applyReminderAck clears a reminder acknowledged in any session (the `reminder_ack` frame). */
  applyReminderAck: (id: string, ackedAt?: string) => void;
  /**
   * acknowledgeReminder is the Acknowledge button: optimistic, rolled back with
   * an error toast if the server refuses. Resolves to whether it stuck.
   */
  acknowledgeReminder: (id: string) => Promise<boolean>;
  /** takeDueChimes returns the cards whose repeat chime is due and restarts their interval. */
  takeDueChimes: (now: number, everyMs: number) => ReminderCard[];
  setQuietHours: (quiet: QuietHours | null) => void;
  requestFocus: (target: { placeId?: string; deviceId?: string; point?: Point }) => void;

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

/**
 * The notification centre survives a reload of the page, per signed-in person:
 * otherwise reloading mid-walk silently marks every crossing read by forgetting
 * it. Each entry keeps `announced`, so nothing toasts or chimes twice.
 */
const NOTIFY_KEY = 'lura.notifications.';

function loadNotifications(viewerId: string): NotificationItem[] {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(NOTIFY_KEY + viewerId) ?? '[]');
    return Array.isArray(parsed) ? (parsed as NotificationItem[]) : [];
  } catch {
    return [];
  }
}

function saveNotifications(viewerId: string | undefined, items: NotificationItem[]) {
  if (!viewerId || Platform.OS !== 'web' || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(NOTIFY_KEY + viewerId, JSON.stringify(items));
  } catch {
    // Full or refused storage costs the history, not the live toast.
  }
}

const initialConnection = loadConnection();
setConfig(initialConnection);

let toastSeq = 0;

export const useStore = create<Store>((set, get) => ({
  positions: {},
  status: 'idle',
  toasts: [],

  notifications: [],
  muted: loadMuted(),
  reminders: EMPTY_REMINDERS,
  quietHours: null,

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

  forgetDevices: (known, before) =>
    set((state) => {
      const gone = Object.keys(state.positions).filter((id) => {
        const p = state.positions[id];
        return !known.has(id) && p !== undefined && new Date(p.recvTs).getTime() < before;
      });
      if (gone.length === 0) return state;
      const positions = { ...state.positions };
      for (const id of gone) delete positions[id];
      return { positions };
    }),

  // Every crossing and every reminder goes through notify(), which dedupes the
  // two frames one crossing can produce into one entry, one toast and one sound.
  applyGeoEvent: (e) => {
    set({ lastEvent: e });
    get().notify(fromGeo(e, get().viewerId));
  },

  applyReminder: (r) => {
    const viewerId = get().viewerId;
    if (isStored(r)) {
      const res = upsert(get().reminders, r, viewerId);
      set({ reminders: res.state });
      if (r.status === 'acknowledged') closeDesktop(reminderTag(r.id));
    }
    get().notify(fromReminder(r, viewerId));
  },

  // Another account's reminders and notifications must not linger after
  // switching users; this viewer's own saved centre comes back after a reload.
  setViewer: (viewerId) =>
    set((state) => {
      if (state.viewerId === viewerId) return { viewerId };
      const switching = !!state.viewerId;
      const notifications = mergeStored(switching ? [] : state.notifications, loadNotifications(viewerId));
      return switching ? { viewerId, reminders: EMPTY_REMINDERS, notifications } : { viewerId, notifications };
    }),

  applyAcl: (action, reason) => set({ aclNotice: { action, reason, at: Date.now() } }),

  setStatus: (status) => set({ status }),

  pushToast: (t) =>
    set((state) => ({
      toasts: [...state.toasts.slice(-3), { ...t, id: `toast_${++toastSeq}`, at: Date.now() }],
    })),

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  notify: (next) => {
    const res = ingest(get().notifications, next);
    // A pending reminder is a sticky card, a repeat frame re-words its toast,
    // and only a first announcement adds one (features/notify/toasts.ts).
    set((state) => ({
      notifications: res.items,
      toasts: toastsAfter(state.toasts, res, () => ({ id: `toast_${++toastSeq}`, at: Date.now() })),
    }));
    if (res.announce) {
      announce(res.item, { muted: get().muted, quiet: inQuietHours(get().quietHours), onOpen: () => get().requestFocus(focusTarget(res.item)) });
    }
    return { announced: res.announce, item: res.item };
  },

  markNotificationRead: (id) =>
    set((state) => {
      const notifications = state.notifications.map((n) => (n.id === id && !n.read ? { ...n, read: true } : n));
      return { notifications };
    }),
  markAllNotificationsRead: () =>
    set((state) => {
      const notifications = markItemsRead(state.notifications);
      return { notifications };
    }),
  clearNotifications: () => set({ notifications: [] }),
  setMuted: (muted) => {
    saveMuted(muted);
    set({ muted });
  },

  reconcileReminders: (records, requestedAt) => {
    const viewerId = get().viewerId;
    const res = reconcile(get().reminders, records, requestedAt, viewerId);
    let notifications = get().notifications;
    for (const id of res.removed) {
      notifications = setReminderStatus(notifications, id, 'acknowledged');
      closeDesktop(reminderTag(id));
    }
    set({ reminders: res.state, notifications });
    // Pending reminders read from the server also get their notification-centre
    // entry; ingest dedupes against the frames and the saved centre, so a
    // reminder rings once, not again on every reload. Until the viewer is known
    // the saved centre is not loaded and every entry would look new.
    if (!viewerId) return;
    const live = new Set(res.state.cards.map((c) => c.id));
    for (const r of records) if (live.has(r.id)) get().notify(fromReminder(r, viewerId));
  },

  applyReminderAck: (id, ackedAt) => {
    const at = ackedAt ? new Date(ackedAt).getTime() : Date.now();
    const when = Number.isNaN(at) ? Date.now() : at;
    closeDesktop(reminderTag(id));
    set((state) => ({
      reminders: ackCard(state.reminders, id, when),
      notifications: setReminderStatus(state.notifications, id, 'acknowledged', when),
    }));
  },

  acknowledgeReminder: async (id) => {
    const began = beginAck(get().reminders, id);
    if (!began.card) return false;
    const now = Date.now();
    closeDesktop(reminderTag(id));
    set((state) => ({
      reminders: began.state,
      notifications: setReminderStatus(state.notifications, id, 'acknowledged', now),
    }));
    try {
      const res = await postAck(id);
      const at = res?.reminder?.ackedAt ? new Date(res.reminder.ackedAt).getTime() : now;
      const when = Number.isNaN(at) ? now : at;
      set((state) => ({
        reminders: commitAck(state.reminders, id, when),
        notifications: setReminderStatus(state.notifications, id, 'acknowledged', when),
      }));
      return true;
    } catch (err) {
      // 404: not ours or already gone — either way there is nothing to wait for.
      if (err instanceof ApiError && err.status === 404) {
        set((state) => ({ reminders: commitAck(state.reminders, id, now) }));
        return true;
      }
      set((state) => {
        const reminders = rollbackAck(state.reminders, id);
        const back = reminders.cards.some((c) => c.id === id);
        return {
          reminders,
          notifications: back ? setReminderStatus(state.notifications, id, 'pending') : state.notifications,
        };
      });
      get().pushToast({
        kind: 'error',
        title: 'Could not acknowledge',
        body: `${began.card.title} is still pending. ${err instanceof Error ? err.message : ''}`.trim(),
      });
      return false;
    }
  },

  takeDueChimes: (now, everyMs) => {
    const due = dueCards(get().reminders, now, everyMs);
    if (due.length > 0) set((state) => ({ reminders: markChimed(state.reminders, due.map((c) => c.id), now) }));
    return due;
  },

  setQuietHours: (quietHours) => {
    const prev = get().quietHours;
    if (prev?.from === quietHours?.from && prev?.to === quietHours?.to && prev?.tz === quietHours?.tz) return;
    set({ quietHours });
  },
  requestFocus: (target) => set((state) => ({ focus: { ...target, seq: (state.focus?.seq ?? 0) + 1 } })),

  setConnection: (next) => {
    const merged = { ...get().connection, ...next };
    setConfig(merged);
    persistConnection(merged);
    // Positions belong to the previous server; keeping them would draw another
    // deployment's markers on this one's map.
    set({
      connection: merged,
      positions: {},
      lastEvent: undefined,
      notifications: [],
      reminders: EMPTY_REMINDERS,
      viewerId: undefined,
    });
  },

  setDrawing: (drawing) => set({ drawing }),
  selectPlace: (selectedPlaceId) => set({ selectedPlaceId }),
  selectDevice: (selectedDeviceId) => set({ selectedDeviceId }),
  setSheetOpen: (sheetOpen) => set({ sheetOpen }),
  setTracking: (trackingEnabled) => set({ trackingEnabled }),
  setSearch: (search) => set({ search }),
}));

// One writer for the saved centre: every change to the list — a new item, a
// read, an acknowledgement, a clear — lands in this viewer's storage, so no
// action can forget to save it.
useStore.subscribe((state, prev) => {
  if (state.notifications !== prev.notifications) {
    saveNotifications(state.viewerId, state.notifications);
  }
});

/** Selectors, so components subscribe to the narrowest slice they need. */
export const selectPositions = (s: Store) => s.positions;
export const selectStatus = (s: Store) => s.status;
export const selectToasts = (s: Store) => s.toasts;
export const selectConnection = (s: Store) => s.connection;
export const selectPendingReminders = (s: Store) => s.reminders.cards;
export const selectUnread = (s: Store) => s.notifications.reduce((n, item) => (item.read ? n : n + 1), 0);

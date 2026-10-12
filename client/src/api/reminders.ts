import { request } from './client';
import type {
  AckResponse,
  ActivityItem,
  ActivityResponse,
  Reminder,
  ReminderAck,
  ReminderKind,
  ReminderRecord,
  ReminderStatus,
} from './types';

/**
 * Calls and small helpers for reminders that wait for an acknowledgement and
 * for the activity timeline (docs/release-spec.md §6 and §7). The wire types
 * themselves are the server's, in types.ts.
 */

export type { AckResponse, ActivityItem, ActivityResponse, ReminderAck, ReminderKind, ReminderRecord, ReminderStatus };

/**
 * StoredReminder is anything that names a stored reminder: a row from
 * GET /api/v1/reminders, or a `notify` frame's Reminder carrying its record id
 * and status. A notify frame without an id (the owner's own crossing of a place
 * with no note) is not one: there is nothing to acknowledge.
 */
export type StoredReminder = ReminderRecord | (Reminder & { id: string; status: ReminderStatus });

/** isStored tells a stored reminder from a bare live notice (or a pre-§6 server's frame). */
export function isStored(r: Reminder | ReminderRecord): r is StoredReminder {
  return typeof r.id === 'string' && r.id.length > 0 && (r.status === 'pending' || r.status === 'acknowledged');
}

export function fetchReminders(status: ReminderStatus | 'all' = 'pending', limit = 100) {
  return request<{ reminders: ReminderRecord[] | null }>(`/api/v1/reminders?status=${status}&limit=${limit}`);
}

export function postAck(id: string) {
  return request<AckResponse>(`/api/v1/reminders/${encodeURIComponent(id)}/ack`, { method: 'POST' });
}

export function fetchActivity(params: { from: string; to: string; limit?: number }) {
  const q = new URLSearchParams({ from: params.from, to: params.to, limit: String(params.limit ?? 500) });
  return request<ActivityResponse>(`/api/v1/activity?${q.toString()}`);
}

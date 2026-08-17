import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';

import { ApiError, request } from './client';
import type {
  Channel,
  Device,
  HistorySummary,
  Note,
  Overview,
  Place,
  PublicShareView,
  ServerInfo,
  Share,
  Suggestion,
  Trigger,
  TriggerEvent,
  User,
} from './types';

/**
 * Server state lives in TanStack Query (HLD §14), and every mutation invalidates
 * the queries it can affect rather than patching caches by hand: the server is
 * the authority on derived values (place stats, armed triggers, share expiry), so
 * re-reading is both simpler and more correct than mirroring its rules here.
 */

export const keys = {
  overview: ['overview'] as const,
  me: ['me'] as const,
  devices: ['devices'] as const,
  places: ['places'] as const,
  notes: (filter?: string) => ['notes', filter ?? 'all'] as const,
  shares: ['shares'] as const,
  channels: ['channels'] as const,
  events: ['events'] as const,
  history: (deviceId: string, from: string, to: string) => ['history', deviceId, from, to] as const,
  publicShare: (token: string) => ['publicShare', token] as const,
};

/** retry skips retries for client errors: a 400 will still be a 400. */
function retry(count: number, error: unknown) {
  if (error instanceof ApiError && error.isClientError) return false;
  return count < 2;
}

export function useOverview(options?: Partial<UseQueryOptions<Overview>>) {
  return useQuery<Overview>({
    queryKey: keys.overview,
    queryFn: () => request<Overview>('/api/v1/overview'),
    // The live socket pushes changes, so polling is a safety net, not the
    // mechanism: a slow interval keeps a missed frame from stranding the UI.
    refetchInterval: 60_000,
    retry,
    ...options,
  });
}

export function useMe() {
  return useQuery<{ user: User; server: ServerInfo }>({
    queryKey: keys.me,
    queryFn: () => request('/api/v1/me'),
    retry,
  });
}

export function useUpdateMe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<Pick<User, 'displayName' | 'locale' | 'tz' | 'quietFrom' | 'quietTo' | 'airgap'>>) =>
      request<{ user: User; server: ServerInfo }>('/api/v1/me', { method: 'PATCH', body: patch }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.me });
      void qc.invalidateQueries({ queryKey: keys.overview });
    },
  });
}

// ---------------------------------------------------------------- devices

export function useDevices() {
  return useQuery<{ devices: Device[] }>({
    queryKey: keys.devices,
    queryFn: () => request('/api/v1/devices'),
    retry,
  });
}

export function useCreateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; kind?: string }) =>
      request<{ device: Device; pubToken: string; pubExample: string }>('/api/v1/devices', {
        method: 'POST',
        body: input,
      }),
    onSuccess: () => invalidateWorkspace(qc),
  });
}

export function useRotateDeviceToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      request<{ device: Device; pubToken: string }>(`/api/v1/devices/${id}/token`, { method: 'POST' }),
    onSuccess: () => invalidateWorkspace(qc),
  });
}

export function useDeleteDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<void>(`/api/v1/devices/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateWorkspace(qc),
  });
}

// ---------------------------------------------------------------- places

export type PlaceInput = {
  name: string;
  tags?: string[];
  center: { lat: number; lon: number };
  radiusM: number;
  triggers: Trigger[];
  dwellMins?: number;
};

export function usePlaces() {
  return useQuery<{ places: Place[] }>({
    queryKey: keys.places,
    queryFn: () => request('/api/v1/places'),
    retry,
  });
}

export function useCreatePlace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PlaceInput) => request<{ place: Place }>('/api/v1/places', { method: 'POST', body: input }),
    onSuccess: () => invalidateWorkspace(qc),
  });
}

export function useUpdatePlace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<PlaceInput> & { id: string }) =>
      request<{ place: Place }>(`/api/v1/places/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => invalidateWorkspace(qc),
  });
}

export function useDeletePlace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<void>(`/api/v1/places/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateWorkspace(qc),
  });
}

// ---------------------------------------------------------------- notes

export function useNotes(filter?: { placeId?: string; trigger?: Trigger; done?: boolean }) {
  const params = new URLSearchParams();
  if (filter?.placeId) params.set('placeId', filter.placeId);
  if (filter?.trigger) params.set('trigger', filter.trigger);
  if (filter?.done !== undefined) params.set('done', String(filter.done));
  const qs = params.toString();

  return useQuery<{ notes: Note[] }>({
    queryKey: keys.notes(qs),
    queryFn: () => request(`/api/v1/notes${qs ? `?${qs}` : ''}`),
    retry,
  });
}

export type NoteInput = {
  text: string;
  placeId?: string;
  trigger?: Trigger;
  tags?: string[];
  channel?: string;
  autoSuggest?: boolean;
};

export function useCreateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: NoteInput) =>
      request<{ note: Note; suggestion?: Suggestion }>('/api/v1/notes', { method: 'POST', body: input }),
    onSuccess: () => invalidateWorkspace(qc),
  });
}

export function useUpdateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<NoteInput> & { id: string; done?: boolean }) =>
      request<{ note: Note }>(`/api/v1/notes/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => invalidateWorkspace(qc),
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<void>(`/api/v1/notes/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateWorkspace(qc),
  });
}

/** useSuggest powers the composer's live suggestion row. */
export function useSuggest() {
  return useMutation({
    mutationFn: (text: string) =>
      request<{ suggestion: Suggestion }>('/api/v1/notes/suggest', { method: 'POST', body: { text } }),
  });
}

// ---------------------------------------------------------------- shares

export function useShares(includeInactive = false) {
  return useQuery<{ shares: Share[] }>({
    queryKey: [...keys.shares, includeInactive],
    queryFn: () => request(`/api/v1/shares${includeInactive ? '?includeInactive=true' : ''}`),
    retry,
  });
}

export type ShareInput = {
  label?: string;
  mode: 'until_arrive' | 'duration' | 'until_revoke';
  durationMins?: number;
  arrivePlaceId?: string;
  deviceIds?: string[];
};

export function useCreateShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ShareInput) => request<{ share: Share }>('/api/v1/shares', { method: 'POST', body: input }),
    onSuccess: () => invalidateWorkspace(qc),
  });
}

export function useRevokeShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<{ share: Share }>(`/api/v1/shares/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateWorkspace(qc),
  });
}

/** usePublicShare is the recipient's view: no token, no account. */
export function usePublicShare(token: string) {
  return useQuery<PublicShareView>({
    queryKey: keys.publicShare(token),
    queryFn: () => request<PublicShareView>(`/s/${token}`, { anonymous: true }),
    enabled: token.length > 0,
    retry: (count, error) => {
      // A revoked or expired link is a final answer, not a transient failure.
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return false;
      return count < 2;
    },
  });
}

// ---------------------------------------------------------------- channels

export function useChannels() {
  return useQuery<{ channels: Channel[]; available: string[] }>({
    queryKey: keys.channels,
    queryFn: () => request('/api/v1/channels'),
    retry,
  });
}

export function useCreateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { type: string; config?: Record<string, string>; priority?: number; enabled?: boolean }) =>
      request<{ channel: Channel }>('/api/v1/channels', { method: 'POST', body: input }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.channels }),
  });
}

export function useUpdateChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string; enabled?: boolean; priority?: number; config?: Record<string, string> }) =>
      request<{ channel: Channel }>(`/api/v1/channels/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.channels }),
  });
}

export function useDeleteChannel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<void>(`/api/v1/channels/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.channels }),
  });
}

// ---------------------------------------------------------------- history

export function useHistory(params: { deviceId?: string; from?: string; to?: string; placeId?: string }) {
  const search = new URLSearchParams();
  if (params.deviceId) search.set('deviceId', params.deviceId);
  search.set('from', params.from ?? '-24h');
  if (params.to) search.set('to', params.to);
  if (params.placeId) search.set('placeId', params.placeId);
  const qs = search.toString();

  return useQuery<HistorySummary>({
    queryKey: keys.history(params.deviceId ?? 'all', params.from ?? '-24h', params.to ?? 'now'),
    queryFn: () => request<HistorySummary>(`/api/v1/history?${qs}`),
    retry,
  });
}

export function useEvents(limit = 50) {
  return useQuery<{ events: TriggerEvent[] }>({
    queryKey: [...keys.events, limit],
    queryFn: () => request(`/api/v1/events?limit=${limit}`),
    retry,
  });
}

// ---------------------------------------------------------------- helpers

/**
 * invalidateWorkspace refreshes everything a workspace mutation can touch.
 *
 * It is deliberately broad: creating a note can arm a trigger on a place, which
 * changes the places grid; revoking a share changes the live banner. Being
 * precise here would mean duplicating the server's rules in the client.
 */
function invalidateWorkspace(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [keys.overview, keys.places, keys.devices, keys.shares, keys.events, ['notes']]) {
    void qc.invalidateQueries({ queryKey: key as readonly unknown[] });
  }
}

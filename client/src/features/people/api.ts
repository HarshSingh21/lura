import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, request } from '@/api/client';

import type { Peer, PeerConnection } from './types';

/**
 * The People endpoints.
 *
 * Every mutation is a consent transition rather than a field write, so each one
 * gets its own hook with its own name — `useSetPeerSharing` flips *my* switch for
 * one peer and nothing else, and there is deliberately no hook that could write
 * the other direction, because the server would refuse it anyway.
 *
 * All of them invalidate the overview as well as the people list: /overview
 * carries `people` too, and the live map reads its peers from there.
 */

export const peopleKeys = {
  all: ['people'] as const,
};

/** The overview key, spelled out so this file owns no part of src/api/hooks.ts. */
const overviewKey = ['overview'] as const;

/** retry skips retries for client errors: a 404 for an unknown address stays a 404. */
function retry(count: number, error: unknown) {
  if (error instanceof ApiError && error.isClientError) return false;
  return count < 2;
}

export function usePeople() {
  return useQuery<{ people: Peer[] }>({
    queryKey: peopleKeys.all,
    queryFn: () => request('/api/v1/people'),
    // Sharing can be paused from the other side at any moment, and this list is
    // the answer to "who can see me": a stale answer here is a privacy bug, so
    // it re-reads more eagerly than the rest of the app.
    refetchInterval: 30_000,
    retry,
  });
}

export function useInvitePerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) =>
      request<{ connection: PeerConnection }>('/api/v1/people/invite', {
        method: 'POST',
        body: { email: email.trim() },
      }),
    onSuccess: () => invalidatePeople(qc),
  });
}

export function useAcceptPerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (peerId: string) =>
      request<{ connection: PeerConnection }>(`/api/v1/people/${encodeURIComponent(peerId)}/accept`, {
        method: 'POST',
      }),
    onSuccess: () => invalidatePeople(qc),
  });
}

/** useSetPeerSharing flips my own switch for one peer — never theirs. */
export function useSetPeerSharing() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ peerId, sharing }: { peerId: string; sharing: boolean }) =>
      request<{ connection: PeerConnection }>(`/api/v1/people/${encodeURIComponent(peerId)}`, {
        method: 'PATCH',
        body: { sharing },
      }),
    onSuccess: () => invalidatePeople(qc),
  });
}

/** useRemovePerson deletes the relationship for both people. */
export function useRemovePerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (peerId: string) =>
      request<void>(`/api/v1/people/${encodeURIComponent(peerId)}`, { method: 'DELETE' }),
    onSuccess: () => invalidatePeople(qc),
  });
}

/**
 * describeInviteError turns the server's statuses into the two sentences a user
 * can act on. The server answers 404 for an unknown address on purpose — the
 * endpoint must not become a way to test which addresses have accounts — so the
 * copy says what to do next instead of implying the address is wrong.
 */
export function describeInviteError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return 'No account on this server uses that address. They have to sign in to this Lura server once before you can connect.';
    }
    if (error.status === 400) {
      if (/yourself/i.test(error.message)) return 'That is your own address — invite someone else.';
      return 'That address is not one this server will accept. Check it for typos.';
    }
    if (error.status === 0) return 'The server did not answer in time. Check the connection in Settings.';
  }
  return error instanceof Error ? error.message : 'Could not send the invitation.';
}

/** describePeopleError is the same courtesy for the row-level actions. */
export function describePeopleError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return 'That connection no longer exists — the other person may have removed it.';
    if (error.status === 0) return 'The server did not answer in time.';
  }
  return error instanceof Error ? error.message : fallback;
}

function invalidatePeople(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: peopleKeys.all });
  void qc.invalidateQueries({ queryKey: overviewKey });
}

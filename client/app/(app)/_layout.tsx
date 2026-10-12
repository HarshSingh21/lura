import { Slot } from 'expo-router';

import { Shell } from '@/components/shell/Shell';
import { useLive } from '@/hooks/useLive';
import { usePublishing, useQuietHoursSync } from '@/hooks/usePublishing';
import { useReminders } from '@/hooks/useReminders';

/**
 * The control-centre layout: chrome plus one live socket.
 *
 * Opening the socket here rather than per screen matters — HLD §5.1 folds fan-out
 * into the Gateway and expects one subscription per client, so switching from the
 * map to Places must not tear the stream down and re-authorise it.
 */
export default function AppLayout() {
  useLive();
  // This device's own location, published from whichever screen is open.
  usePublishing();
  // Pending reminders: read on sign-in / load (and on every reconnect, from
  // useLive), and chimed again until acknowledged.
  useReminders();
  // Quiet hours silence chimes on whichever screen is open.
  useQuietHoursSync();
  return (
    <Shell>
      <Slot />
    </Shell>
  );
}

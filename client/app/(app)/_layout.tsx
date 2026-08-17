import { Slot } from 'expo-router';

import { Shell } from '@/components/shell/Shell';
import { useLive } from '@/hooks/useLive';

/**
 * The control-centre layout: chrome plus one live socket.
 *
 * Opening the socket here rather than per screen matters — HLD §5.1 folds fan-out
 * into the Gateway and expects one subscription per client, so switching from the
 * map to Places must not tear the stream down and re-authorise it.
 */
export default function AppLayout() {
  useLive();
  return (
    <Shell>
      <Slot />
    </Shell>
  );
}

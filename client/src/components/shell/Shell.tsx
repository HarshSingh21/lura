import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useOverview, useUpdateMe } from '@/api/hooks';
import { Icon } from '@/components/ui/Icon';
import { Txt } from '@/theme/text';
import { color, palette, space } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';
import { useStore } from '@/state/store';

import { BottomTabs } from './BottomTabs';
import { Sidebar } from './Sidebar';
import { Toasts } from './Toasts';
import { TopBar } from './TopBar';

/**
 * The application shell.
 *
 * One layout, two shapes: sidebar + content (+ the screen's own rail) on a wide
 * viewport, top bar + content + tab bar on a phone. HLD §14's surface capability
 * rule says web is the full control centre while mobile adds tracking — the shell
 * expresses that by keeping every destination reachable on both, and letting each
 * screen decide how its secondary column collapses.
 */
export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { isWide } = useLayoutMode();
  const { data } = useOverview();
  const updateMe = useUpdateMe();
  const status = useStore((s) => s.status);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);

  const airgap = data?.user.airgap ?? data?.server.airgap ?? false;
  // Every collection is read through `?.` all the way down. The server now sends
  // `[]` rather than `null` for an empty workspace, but a client that crashes on
  // an unexpected null is one deployment away from a white screen, and the whole
  // shell — not just one counter — is what goes down with it.
  const activeShares = data?.shares?.length ?? 0;
  const openNotes = data?.notes?.filter((n) => !n.done).length ?? 0;

  const initials = (data?.user.displayName || data?.user.email || 'Lura')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <TopBar
        airgap={airgap}
        onToggleAirgap={() => updateMe.mutate({ airgap: !airgap })}
        initials={initials || 'LU'}
        status={status}
        search={search}
        onSearchChange={setSearch}
        onSearchSubmit={() => {
          // Search is a place filter in Phase 1; Photon geocoding lands with the
          // self-hosted tile stack (HLD §13).
          if (search.trim()) router.push('/places');
        }}
        aiEngine={data?.server.aiEngine}
      />

      <View style={styles.body}>
        {isWide ? (
          <Sidebar
            pathname={pathname}
            counts={{
              devices: data?.devices?.length ?? 0,
              places: data?.places?.length ?? 0,
              notes: openNotes,
            }}
            sharing={activeShares > 0}
            health={{
              ok: status === 'open',
              label: status === 'open' ? 'All services healthy' : 'Live stream offline',
              detail: data ? `${data.server.store} · phase ${data.server.phase}` : 'connecting…',
            }}
          />
        ) : null}

        <View style={styles.content}>{children}</View>
      </View>

      {airgap ? <AirgapBanner /> : null}
      {!isWide ? <BottomTabs pathname={pathname} sharing={activeShares > 0} /> : null}
      <Toasts />
    </SafeAreaView>
  );
}

/**
 * AirgapBanner is the persistent, unmissable statement of the invariant: the
 * operator has switched egress off and nothing is leaving this server.
 */
function AirgapBanner() {
  return (
    <View style={styles.airgapBanner}>
      <Icon name="airgap" size={14} color={palette.accentBright} strokeWidth={1.8} />
      <Txt variant="small" color="#ffffff" style={styles.airgapText}>
        <Txt variant="bodySemi" color="#ffffff">
          Airgap mode on
        </Txt>
        {' — no outbound calls. AI runs on-device; nothing leaves this server.'}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  body: { flex: 1, flexDirection: 'row', minHeight: 0 },
  content: { flex: 1, minWidth: 0 },
  airgapBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    backgroundColor: color.ink,
    paddingVertical: space.md,
    paddingHorizontal: space.xl,
  },
  airgapText: { textAlign: 'center' },
});

import { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import {
  SpaceGrotesk_400Regular,
  SpaceGrotesk_500Medium,
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import { JetBrainsMono_400Regular, JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';

import { ApiError } from '@/api/client';
import { Txt } from '@/theme/text';
import { color, palette } from '@/theme/tokens';

/**
 * Root layout: providers only.
 *
 * The shell lives one level down, in (app)/_layout.tsx, so the public share
 * viewer can render outside it — a recipient has no workspace, no sidebar and no
 * account, and giving them the control centre's chrome would imply otherwise.
 *
 * Fonts are bundled rather than fetched from Google Fonts: HLD §11's airgap
 * promise has to hold for typography too.
 */
export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // The live socket is the freshness mechanism, so queries can be
            // relaxed: refetch on focus, tolerate a slightly stale cache.
            staleTime: 15_000,
            gcTime: 5 * 60_000,
            retry: (count, error) => !(error instanceof ApiError && error.isClientError) && count < 2,
            refetchOnWindowFocus: true,
          },
          mutations: {
            retry: 0, // a mutation that failed should surface, not silently repeat
          },
        },
      }),
    [],
  );

  // A missing font must not block the app: rendering with the system font is far
  // better than a permanently blank screen.
  if (!fontsLoaded && !fontError) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator color={palette.accent} />
        <Txt variant="small" color={color.textMuted} style={styles.bootText}>
          Loading Lura…
        </Txt>
      </View>
    );
  }

  return (
    <QueryClientProvider client={client}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Slot />
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: color.bg },
  bootText: {},
});

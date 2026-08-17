import { useMemo, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Redirect, Slot, usePathname } from 'expo-router';
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
import { installSessionBridge, LOGIN_ROUTE, useRequireAuth } from '@/features/auth';
import { useOnboarded } from '@/features/onboarding';
import { Txt } from '@/theme/text';
import { color, palette } from '@/theme/tokens';

// The HTTP client takes its bearer from the session. Installed at module scope so
// the provider is in place before any component gets a chance to fetch.
installSessionBridge();

/**
 * Root layout: providers and the front door.
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
  if (!fontsLoaded && !fontError) return <Splash label="Loading Lura…" />;

  return (
    <QueryClientProvider client={client}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Gate>
          <Slot />
        </Gate>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

/**
 * Gate decides, per navigation, whether this route may render.
 *
 * Three states, in this order, because each one is a precondition of the next:
 *
 *   1. **Still reading the persisted session.** Render the splash. Treating "not
 *      read yet" as signed out would flash the login screen on every cold start.
 *   2. **Signed out.** Go to Keycloak's front door.
 *   3. **Signed in but never introduced.** Run the tour once, then land on the map.
 *
 * The share viewer is the one route outside all of it: public by definition,
 * because the whole point of a link is that the recipient has no account.
 *
 * This is the *only* place in the app that redirects on authentication state.
 * Two owners is one too many — the login screen used to send itself back to the
 * map the moment a session appeared, which raced this component's redirect to the
 * introduction and left the router on neither, showing a blank page.
 *
 * The redirect lives here rather than inside `useRequireAuth` for the same
 * reason: a hook that navigates during a layout's render fights whatever else
 * that layout is doing, and hides the routing decision from anyone reading the
 * routes.
 */
function Gate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { ready, isSignedIn } = useRequireAuth();
  const onboarded = useOnboarded();

  // Public by design; never gated, never redirected away from.
  if (pathname.startsWith('/share/')) return <>{children}</>;

  if (!ready) return <Splash label="Signing you in…" />;

  if (!isSignedIn) {
    return pathname === LOGIN_ROUTE ? <>{children}</> : <Redirect href={LOGIN_ROUTE} />;
  }
  if (!onboarded) {
    return pathname === ONBOARDING_ROUTE ? <>{children}</> : <Redirect href={ONBOARDING_ROUTE} />;
  }
  // Signed in and introduced: the login screen has nothing left to say.
  if (pathname === LOGIN_ROUTE) return <Redirect href="/" />;

  return <>{children}</>;
}

const ONBOARDING_ROUTE = '/onboarding';

function Splash({ label }: { label: string }) {
  return (
    <View style={styles.boot}>
      <ActivityIndicator color={palette.accent} />
      <Txt variant="small" color={color.textMuted}>
        {label}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: color.bg },
});

import { type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button, Dot } from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, font, palette, radius, shadow, size, space } from '@/theme/tokens';

import { GoogleGlyph, XGlyph } from './ProviderGlyphs';
import { useOidc, type OidcProvider } from './useOidc';
import { useSession } from './session';

/**
 * The sign-in screen.
 *
 * There is no password field here, and that is the design. The realm runs a `totp`
 * OTP policy, so the second factor lives in Keycloak's own browser flow; putting a
 * form in this app would either duplicate that flow badly or bypass it. Every
 * button below opens the same hosted page — the social ones just carry a
 * `kc_idp_hint` so Keycloak forwards straight to the provider.
 *
 * The unreachable state is treated as a first-class screen rather than a toast. In
 * local development a stopped Keycloak container is the single most likely reason
 * sign-in does nothing, and an error that names the URL it tried and the command
 * that fixes it is the difference between a two-minute and a two-hour detour.
 */
export function LoginScreen() {
  const oidc = useOidc();
  const sessionError = useSession((s) => s.error);

  // Note what is *not* here: no redirect once the session exists. The gate in the
  // root layout owns every routing decision, and two owners is one too many — an
  // earlier version replaced to `/` from this effect while the gate was rendering
  // a redirect to the introduction in the same tick, and the router landed on
  // neither, leaving a blank page on /login.

  const busy = oidc.pending !== null;
  const blocked = !oidc.ready || busy;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <View style={styles.brand}>
          <View style={styles.logo}>
            <View style={styles.logoCore} />
            <Dot size={42} color={palette.accent} pulse style={styles.logoPulse} />
          </View>
          <Txt style={styles.wordmark}>Lura</Txt>
          <View style={styles.selfHosted}>
            <Mono size={size.monoTiny} color={color.textSubtle}>
              self-hosted
            </Mono>
          </View>
        </View>

        <View style={styles.heading}>
          <Txt variant="h1">Sign in to your deployment</Txt>
          <Txt variant="body" color={color.textMuted} style={styles.headingBody}>
            Lura hands you to the Keycloak you run. Your password and one-time code are typed there, never here.
          </Txt>
        </View>

        {sessionError ? (
          <View style={styles.notice}>
            <Txt variant="micro" color={palette.amberInk}>
              {sessionError}
            </Txt>
          </View>
        ) : null}

        {oidc.error?.kind === 'unreachable' ? (
          <UnreachableNotice url={oidc.discoveryUrl} onRetry={oidc.retry} retrying={oidc.discovering} />
        ) : null}

        {oidc.error && oidc.error.kind !== 'unreachable' ? (
          <View style={styles.errorBox}>
            <Txt variant="micro" color={palette.dangerInk}>
              {oidc.error.message}
            </Txt>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Button
            label="Continue with email"
            full
            disabled={blocked}
            loading={oidc.pending === 'email'}
            onPress={() => {
              void oidc.signIn('email');
            }}
          />

          <View style={styles.dividerRow}>
            <View style={styles.dividerLine} />
            <Mono size={size.monoTiny} color={color.textFaint}>
              or
            </Mono>
            <View style={styles.dividerLine} />
          </View>

          <ProviderButton
            label="Continue with Google"
            provider="google"
            glyph={<GoogleGlyph />}
            disabled={blocked}
            pending={oidc.pending === 'google'}
            onPress={oidc.signIn}
          />
          <ProviderButton
            label="Continue with X (Twitter)"
            provider="twitter"
            glyph={<XGlyph />}
            disabled={blocked}
            pending={oidc.pending === 'twitter'}
            onPress={oidc.signIn}
          />
        </View>

        {oidc.discovering ? (
          <View style={styles.statusRow}>
            <ActivityIndicator size="small" color={palette.accent} />
            <Txt variant="micro" color={color.textFaint}>
              Contacting {oidc.issuer}…
            </Txt>
          </View>
        ) : busy ? (
          <View style={styles.statusRow}>
            <ActivityIndicator size="small" color={palette.accent} />
            <Txt variant="micro" color={color.textFaint}>
              {Platform.OS === 'web'
                ? 'Finish signing in in the popup window.'
                : 'Finish signing in in the browser, then come back.'}
            </Txt>
          </View>
        ) : null}

        <View style={styles.footer}>
          <Txt variant="micro" color={color.textFaint} style={styles.footerText}>
            Google and X only confirm who you are, to your Keycloak. They never see a place, a trip or a position —
            that data never leaves the server you run.
          </Txt>
          <Mono size={size.monoTiny} color={color.textFaint}>
            {oidc.issuer}
          </Mono>
        </View>
      </View>
    </ScrollView>
  );
}

/**
 * ProviderButton is the secondary button with a brand mark.
 *
 * It is not `primitives.Button` because that takes an `IconName` from the product
 * icon set, and a trademarked multi-colour logo cannot be expressed there. The
 * metrics are copied from it so the two stack without a seam.
 */
function ProviderButton({
  label,
  provider,
  glyph,
  disabled,
  pending,
  onPress,
}: {
  label: string;
  provider: OidcProvider;
  glyph: ReactNode;
  disabled: boolean;
  pending: boolean;
  onPress: (provider: OidcProvider) => Promise<void>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: pending }}
      disabled={disabled}
      onPress={() => {
        void onPress(provider);
      }}
      style={({ pressed }) => [
        styles.providerButton,
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      {glyph}
      <Txt variant="bodySemi" color={color.textStrong} style={styles.providerLabel}>
        {pending ? 'Working…' : label}
      </Txt>
    </Pressable>
  );
}

/** UnreachableNotice names the URL that failed and the command that fixes it. */
function UnreachableNotice({ url, onRetry, retrying }: { url: string; onRetry: () => void; retrying: boolean }) {
  return (
    <View style={styles.unreachable}>
      <Txt variant="bodySemi" color={palette.dangerInk}>
        Keycloak is not answering
      </Txt>
      <Txt variant="micro" color={color.textBody} style={styles.unreachableBody}>
        Nothing responded at:
      </Txt>
      <Mono size={size.monoSm} selectable color={color.textBody}>
        {url}
      </Mono>
      <Txt variant="micro" color={color.textBody} style={styles.unreachableBody}>
        Start it with:
      </Txt>
      <Mono size={size.monoSm} selectable color={color.textBody}>
        docker compose -f deploy/docker-compose.yml up -d keycloak
      </Mono>
      <Txt variant="micro" color={color.textFaint} style={styles.unreachableBody}>
        The realm is imported from deploy/keycloak/lura-realm.json. Point somewhere else with
        EXPO_PUBLIC_KEYCLOAK_URL.
      </Txt>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Try reaching Keycloak again"
        accessibilityState={{ disabled: retrying, busy: retrying }}
        disabled={retrying}
        onPress={onRetry}
        style={({ pressed }) => [styles.retry, pressed && !retrying ? styles.pressed : null]}
      >
        <Txt variant="small" color={palette.accentDark} style={styles.retryLabel}>
          {retrying ? 'Trying…' : 'Try again'}
        </Txt>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.page,
  },

  card: {
    width: '100%',
    maxWidth: 400,
    gap: space.xxl,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    padding: space.page,
    ...shadow('card'),
  },

  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoCore: { width: 13, height: 13, borderRadius: 7, backgroundColor: '#ffffff' },
  logoPulse: { position: 'absolute', opacity: 0.6 },
  wordmark: { fontFamily: font.sansBold, fontSize: 22, letterSpacing: -0.44 },
  selfHosted: {
    borderWidth: 1,
    borderColor: color.hairlineStrong,
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },

  heading: { gap: 6 },
  headingBody: { lineHeight: 19 },

  notice: {
    backgroundColor: color.amberSofter,
    borderWidth: 1,
    borderColor: color.amberBorder,
    borderRadius: radius.lg,
    padding: space.lg,
  },
  errorBox: {
    backgroundColor: 'rgba(200,101,86,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(200,101,86,0.35)',
    borderRadius: radius.lg,
    padding: space.lg,
  },
  unreachable: {
    gap: 5,
    backgroundColor: 'rgba(200,101,86,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(200,101,86,0.3)',
    borderRadius: radius.lg,
    padding: space.lg,
  },
  unreachableBody: { marginTop: 3, lineHeight: 15 },
  retry: { alignSelf: 'flex-start', marginTop: space.md },
  retryLabel: { fontFamily: font.sansSemiBold },

  actions: { gap: space.lg },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  dividerLine: { flex: 1, height: 1, backgroundColor: color.hairline },

  providerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    width: '100%',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    paddingVertical: 10,
    paddingHorizontal: 15,
  },
  providerLabel: { letterSpacing: -0.1 },
  pressed: { opacity: 0.9 },
  disabled: { opacity: 0.55 },

  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },

  footer: { gap: 6, borderTopWidth: 1, borderTopColor: color.hairline, paddingTop: space.xl },
  footerText: { lineHeight: 15 },
});

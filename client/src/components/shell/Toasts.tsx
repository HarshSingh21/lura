import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { Dot } from '@/components/ui/primitives';
import { Txt } from '@/theme/text';
import { color, palette, radius, shadow, space } from '@/theme/tokens';
import { useStore, type Toast } from '@/state/store';

/**
 * Live reminder toasts.
 *
 * When a geofence fires, the in-app channel pushes the reminder down the socket
 * (HLD §5.6) — this is where it surfaces. Reminders auto-dismiss but stay long
 * enough to read while driving past the shop they are about; errors stay until
 * dismissed, because an error nobody saw is an error nobody fixed.
 */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <View style={styles.stack} pointerEvents="box-none">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </View>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const sticky = toast.kind === 'error';

  useEffect(() => {
    if (sticky) return;
    const timer = setTimeout(onDismiss, toast.kind === 'reminder' ? 9000 : 5000);
    return () => clearTimeout(timer);
  }, [onDismiss, sticky, toast.kind]);

  const tint =
    toast.kind === 'error' ? palette.danger : toast.kind === 'reminder' ? palette.accent : color.textSubtle;

  return (
    <View style={[styles.toast, toast.kind === 'error' && styles.toastError]}>
      <Dot size={8} color={tint} style={styles.dot} />
      <View style={styles.body}>
        <Txt variant="bodySemi" numberOfLines={2}>
          {toast.title}
        </Txt>
        {toast.body ? (
          <Txt variant="tiny" color={color.textMuted} style={styles.bodyText} numberOfLines={4}>
            {toast.body}
          </Txt>
        ) : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={onDismiss} hitSlop={8}>
        <Icon name="close" size={14} color={color.textFaint} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    position: 'absolute',
    right: space.xxl,
    bottom: space.xxl,
    gap: space.md,
    maxWidth: 380,
    zIndex: 60,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.card,
    paddingVertical: 12,
    paddingHorizontal: 14,
    ...shadow('card'),
  },
  toastError: { borderColor: palette.danger },
  dot: { marginTop: 5 },
  body: { flex: 1, minWidth: 0 },
  bodyText: { marginTop: 2 },
});

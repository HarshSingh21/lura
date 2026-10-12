import { Platform } from 'react-native';

import type { NotificationItem } from './model';

/**
 * Desktop (system) notifications, for when the tab is not being looked at.
 *
 * The in-app toast is the primary surface; this is the fallback for a Lura tab
 * sitting behind another window, which is exactly when a "Nishtha arrived" chime
 * plays to nobody watching. It only ever fires while `document.hidden` and with
 * permission already granted — asking is a button in Settings and in the
 * notification panel, never a prompt that ambushes someone on page load.
 *
 * The notification's `tag` is the crossing id, so the browser itself collapses a
 * repeat for the same crossing instead of stacking two.
 */

export type DesktopPermission = NotificationPermission | 'unsupported';

function api(): typeof Notification | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  try {
    return 'Notification' in window ? window.Notification : null;
  } catch {
    return null;
  }
}

export function desktopPermission(): DesktopPermission {
  const N = api();
  if (!N) return 'unsupported';
  try {
    return N.permission;
  } catch {
    return 'unsupported';
  }
}

/** requestDesktop asks once; it must be called from a click for browsers to show the prompt. */
export async function requestDesktop(): Promise<DesktopPermission> {
  const N = api();
  if (!N) return 'unsupported';
  try {
    return await N.requestPermission();
  } catch {
    return desktopPermission();
  }
}

/** showDesktop raises a system notification when the page is hidden. Returns whether it did. */
export function showDesktop(item: NotificationItem, onClick?: () => void): boolean {
  const N = api();
  if (!N || desktopPermission() !== 'granted') return false;
  if (typeof document === 'undefined' || !document.hidden) return false;
  try {
    const lines = [item.body, item.fromName ? `from ${item.fromName}` : undefined].filter(Boolean);
    const n = new N(item.title, {
      body: lines.join(' · ') || item.placeName || undefined,
      tag: item.id,
      icon: '/favicon.ico',
    });
    n.onclick = () => {
      try {
        window.focus();
      } catch {
        // Some browsers refuse focus() from a notification; the click still closes it.
      }
      onClick?.();
      n.close();
    };
    return true;
  } catch {
    // Chrome on Android throws for `new Notification` outside a service worker.
    return false;
  }
}

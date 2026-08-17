import type { IconName } from '@/components/ui/Icon';

/**
 * The navigation model, shared by the desktop sidebar and the phone tab bar.
 *
 * Keeping it in one list means the two never disagree about what exists, and the
 * route strings match Expo Router's file names exactly — a typo here is a dead
 * tab, so there is exactly one place to get it right.
 */
export type NavItem = {
  key: string;
  label: string;
  /** Short label for the phone tab bar, where 60 dp is all there is. */
  short: string;
  href: '/' | '/places' | '/notes' | '/sharing' | '/history' | '/settings';
  icon: IconName;
};

export const NAV_ITEMS: NavItem[] = [
  { key: 'live', label: 'Live map', short: 'Live', href: '/', icon: 'live' },
  { key: 'places', label: 'Places', short: 'Places', href: '/places', icon: 'places' },
  { key: 'notes', label: 'Notes', short: 'Notes', href: '/notes', icon: 'notes' },
  { key: 'sharing', label: 'Sharing', short: 'Share', href: '/sharing', icon: 'sharing' },
  { key: 'history', label: 'History', short: 'History', href: '/history', icon: 'history' },
];

export const SETTINGS_ITEM: NavItem = {
  key: 'settings',
  label: 'Settings',
  short: 'More',
  href: '/settings',
  icon: 'settings',
};

/** isActive matches a pathname to a nav item, treating "/" exactly. */
export function isActive(pathname: string, href: NavItem['href']): boolean {
  if (href === '/') return pathname === '/' || pathname === '/index';
  return pathname === href || pathname.startsWith(`${href}/`);
}

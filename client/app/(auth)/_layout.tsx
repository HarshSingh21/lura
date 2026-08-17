import { Slot } from 'expo-router';

/**
 * The signed-out layout: nothing at all.
 *
 * No top bar, no sidebar, no live socket. The shell in (app)/_layout.tsx assumes a
 * session — it renders an account avatar and opens an authorised WebSocket — so a
 * visitor who has not signed in yet must render outside it, the same way the public
 * share viewer does.
 */
export default function AuthLayout() {
  return <Slot />;
}

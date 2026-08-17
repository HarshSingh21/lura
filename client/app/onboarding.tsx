import { router } from 'expo-router';

import { OnboardingScreen } from '@/features/onboarding';

/**
 * The introduction route.
 *
 * It sits outside `(app)` on purpose: the tour explains the control centre, so
 * rendering it inside the control centre's chrome would put the sidebar, the tab
 * bar and the live socket behind an explanation of what they are.
 *
 * The screen records the "seen" flag itself; this route only decides where
 * finishing goes.
 */
export default function OnboardingRoute() {
  return <OnboardingScreen onDone={() => router.replace('/')} />;
}

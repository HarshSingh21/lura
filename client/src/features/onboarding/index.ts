/**
 * The post-login introduction: one screen component and the flag that says it has
 * been seen. Everything else in this folder is an implementation detail of those
 * two, so callers only ever need this file.
 */

export { OnboardingScreen } from './OnboardingScreen';
export { hasSeenOnboarding, markOnboardingSeen, resetOnboarding } from './storage';
export { STEPS, type OnboardingStep, type OnboardingPoint } from './steps';
export { useOnboarded } from './useOnboarded';

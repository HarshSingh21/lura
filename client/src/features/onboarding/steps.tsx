import type { ComponentType } from 'react';

import type { TriggerName } from '@/theme/tokens';

import { AirgapVisual, HistoryVisual, LiveMapVisual, NoteVisual, ShareVisual } from './visuals';

/**
 * The introduction, as content.
 *
 * Copy and layout are separated here for one reason: every sentence below is a
 * claim about behaviour that exists in this repository, and keeping them in one
 * list makes them reviewable against the code rather than scattered through JSX.
 * The defaults quoted (45 s, 1.5 m/s, 3 m/s, 30 min, 90 days) are the server's
 * documented defaults, so an operator who changed them will recognise what moved.
 */

export type OnboardingPoint = {
  text: string;
  /** A short mono tag rendered before the line, e.g. "WS". */
  label?: string;
  /** Renders the shared trigger badge instead of a label, so it matches Notes. */
  trigger?: TriggerName;
};

export type OnboardingStep = {
  key: string;
  eyebrow: string;
  title: string;
  body: string;
  points: OnboardingPoint[];
  Visual: ComponentType;
};

export const STEPS: OnboardingStep[] = [
  {
    key: 'live',
    eyebrow: 'LIVE MAP',
    title: 'Your devices, on one live map',
    body:
      'Every phone or tracker you connect publishes its position to your server. The map keeps a WebSocket open, so markers move as fixes arrive rather than when you reload. Places are geofences you draw yourself: tap the map, set a radius in metres, and that circle is what everything else reacts to.',
    points: [
      { label: 'WS', text: 'One socket carries positions, geofence events and reminders together.' },
      { label: 'PUB', text: 'Any OwnTracks-compatible client can post to /pub with a device token.' },
      { label: 'GEO', text: 'A place is a centre and a radius. Change the radius and the behaviour changes with it.' },
    ],
    Visual: LiveMapVisual,
  },
  {
    key: 'notes',
    eyebrow: 'NOTES',
    title: 'Notes that fire where you are',
    body:
      'Write the reminder the way you would say it — buy oat milk when I pass the store. The AI Brain runs on your own server, matches the words to one of your places, and proposes a tag and a trigger. It shows its confidence and where it ran, and you can overrule any part of it.',
    points: [
      { trigger: 'arrive', text: 'Fires when you have actually stopped there, not when you cross the line.' },
      { trigger: 'leave', text: 'Fires when you go, once the fix confirms you are outside.' },
      { trigger: 'dwell', text: 'Fires after you have stayed the number of minutes you set.' },
      { trigger: 'passby', text: 'Fires when you enter while still moving — the drive-past case.' },
    ],
    Visual: NoteVisual,
  },
  {
    key: 'sharing',
    eyebrow: 'SHARING',
    title: 'Sharing that ends on its own',
    body:
      'A share is a link. Whoever opens it needs no account and sees one map and nothing else. You choose how it ends: on a clock, when you revoke it, or "until I arrive", which revokes itself the moment the arrive trigger fires at the place you picked.',
    points: [
      { label: 'LIST', text: 'Every live link is listed to you with its token and a one-tap revoke.' },
      { label: 'DROP', text: 'A revoke drops the viewer on the next fix rather than at the end of a TTL.' },
      { label: 'SEE', text: 'A banner on the live map stays up the whole time anything is shared.' },
    ],
    Visual: ShareVisual,
  },
  {
    key: 'history',
    eyebrow: 'HISTORY',
    title: 'A history only you can read',
    body:
      'Your fixes are segmented into trips and stops on your own server, with the mode of travel inferred from the track. Nothing is aggregated, sold or sent anywhere, because there is nowhere else for it to go.',
    points: [
      { label: 'OUT', text: 'Export any window as GPX or GeoJSON in one tap.' },
      { label: 'DEL', text: 'Delete a window whenever you like; deletion is an ordinary endpoint, not a request.' },
      { label: 'TTL', text: 'Retention defaults to 90 days and runs in-process. Set it to 0 to keep everything.' },
    ],
    Visual: HistoryVisual,
  },
  {
    key: 'server',
    eyebrow: 'YOUR INFRASTRUCTURE',
    title: 'It runs on your server',
    body:
      'Lura is one Go binary and one database that you host. The suggester is local computation, the basemap falls back to a locally drawn one, and airgap mode closes every outbound path at once — telemetry, push, remote tiles, the AI sidecar — and says so in a banner you cannot miss.',
    points: [
      { label: 'OFF', text: 'A notification channel has to declare whether it leaves the box, so nothing can quietly slip out.' },
      { label: 'LOC', text: 'Fonts and the fallback map are bundled, so airgap holds for typography and tiles too.' },
      { label: 'YOU', text: 'No third party is in the path of your location. There is no third party in the path at all.' },
    ],
    Visual: AirgapVisual,
  },
];

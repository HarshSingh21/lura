/**
 * Wire types, mirroring internal/domain in the Go server.
 *
 * These are hand-written rather than generated on purpose: the surface is small,
 * and a hand-written type is where a comment explaining *why* a field exists can
 * live. If the API grows past this, generate them from an OpenAPI document
 * instead of letting the two drift.
 */

export type Trigger = 'arrive' | 'leave' | 'dwell' | 'passby';

export const TRIGGERS: Trigger[] = ['arrive', 'leave', 'dwell', 'passby'];

export type Point = { lat: number; lon: number };

export type User = {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  tz: string;
  quietFrom: string;
  quietTo: string;
  airgap: boolean;
  createdAt: string;
};

export type Device = {
  id: string;
  userId: string;
  name: string;
  kind: string;
  lastSeen?: string;
  lastPoint?: Point;
  speedMps?: number;
  battery?: number;
  createdAt: string;
  /** Places the geofence engine currently considers this device inside. */
  insidePlaces?: string[];
};

export type PlaceStats = { notes: number; events: number };

export type Place = {
  id: string;
  userId: string;
  name: string;
  tags: string[];
  center: Point;
  radiusM: number;
  triggers: Trigger[];
  dwellMins: number;
  createdAt: string;
  updatedAt: string;
  stats?: PlaceStats;
};

export type Note = {
  id: string;
  userId: string;
  text: string;
  placeId: string;
  trigger: Trigger;
  tags: string[];
  done: boolean;
  channel: string;
  createdAt: string;
  updatedAt: string;
  firedAt?: string;
};

export type ShareMode = 'until_arrive' | 'duration' | 'until_revoke';

export type Share = {
  id: string;
  userId: string;
  token: string;
  label: string;
  mode: ShareMode;
  deviceIds: string[];
  expiresAt?: string;
  arrivePlaceId?: string;
  revokedAt?: string;
  revokeReason?: string;
  createdAt: string;
  link: string;
};

export type Channel = {
  id: string;
  userId: string;
  type: string;
  config: Record<string, string>;
  enabled: boolean;
  priority: number;
  createdAt: string;
};

export type TriggerEvent = {
  id: string;
  userId: string;
  placeId: string;
  placeName: string;
  deviceId: string;
  trigger: Trigger;
  ts: string;
  noteIds: string[];
  delivered: string[];
  note?: string;
};

export type PendingDwell = {
  deviceId: string;
  userId: string;
  placeId: string;
  fireAt: string;
  enteredAt: string;
};

export type Suggestion = {
  text: string;
  tags: string[];
  placeId?: string;
  placeName?: string;
  trigger: Trigger;
  confidence: number;
  engine: string;
  onDevice: boolean;
};

export type Position = {
  deviceId: string;
  userId: string;
  recvTs: string;
  deviceTs: string;
  point: Point;
  accuracyM: number;
  speedMps: number;
  altitudeM: number;
  headingDeg: number;
  battery: number;
  seq: number;
};

export type GeoEvent = {
  id: string;
  userId: string;
  deviceId: string;
  placeId: string;
  placeName: string;
  trigger: Trigger;
  ts: string;
  point: Point;
  speedMps: number;
};

export type Reminder = {
  userId: string;
  title: string;
  body: string;
  trigger: Trigger;
  placeId: string;
  placeName: string;
  deviceId: string;
  noteIds: string[];
  tags: string[];
  priority: number;
  clickUrl?: string;
  ts: string;
  event: GeoEvent;
};

/** ServerInfo lets the UI reflect the deployment instead of hard-coding it. */
export type ServerInfo = {
  version: string;
  store: string;
  mapStyleUrl: string;
  airgap: boolean;
  phase: string;
  publicBaseUrl: string;
  freshWindowSeconds: number;
  coolOffSeconds: number;
  aiEngine: string;
  pushChannels: string[];
};

export type Overview = {
  user: User;
  server: ServerInfo;
  devices: Device[];
  places: Place[];
  notes: Note[];
  shares: Share[];
  events: TriggerEvent[];
  pendingDwells: PendingDwell[];
};

export type Segment = {
  id: string;
  deviceId: string;
  kind: 'stop' | 'move';
  mode: string;
  startTs: string;
  endTs: string;
  distanceM: number;
  fromPlace?: string;
  toPlace?: string;
  atPlace?: string;
  path: Point[];
};

export type HistorySummary = {
  deviceId: string;
  from: string;
  to: string;
  distanceM: number;
  trips: number;
  stops: number;
  movingSeconds: number;
  segments: Segment[];
  track: Point[];
  points: number;
};

export type PublicShareView = {
  label: string;
  sharerName: string;
  mode: ShareMode;
  expiresAt?: string;
  arrivePlaceName?: string;
  devices: {
    id: string;
    name: string;
    point?: Point;
    speedMps?: number;
    lastSeen?: string;
  }[];
  serverTime: string;
};

/** The WebSocket envelope from internal/hub. */
export type Frame =
  | { type: 'hello'; ts: string; data: { clientId: string; viewerId: string; subjects: string[] } }
  | { type: 'snapshot'; ts: string; data: { devices?: Device[]; places?: Place[]; server?: ServerInfo; share?: PublicShareView } }
  | { type: 'position'; ts: string; subject?: string; data: Position }
  | { type: 'geo'; ts: string; subject?: string; data: GeoEvent }
  | { type: 'notify'; ts: string; subject?: string; data: Reminder }
  | { type: 'acl'; ts: string; subject?: string; data: { action: string; shareId?: string; reason?: string } }
  | { type: 'pong'; ts: string; data?: unknown }
  | { type: 'closing'; ts: string; data?: { reason?: string } }
  | { type: 'error'; ts: string; data?: { error?: string } };

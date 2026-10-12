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
  /** 'circle' uses center + radiusM; 'polygon' uses polygon (center/radiusM are then the server-computed centroid and bounding radius). */
  shape: PlaceShape;
  center: Point;
  radiusM: number;
  /** Polygon ring, 3–200 vertices, not closed (first vertex is not repeated). Empty for circles. */
  polygon: Point[];
  /** Connected people whose crossings of this fence notify the place owner (each must share live with the owner). */
  watchUserIds: string[];
  triggers: Trigger[];
  dwellMins: number;
  createdAt: string;
  updatedAt: string;
  stats?: PlaceStats;
};

export type PlaceShape = 'circle' | 'polygon';

export type Note = {
  id: string;
  userId: string;
  text: string;
  placeId: string;
  trigger: Trigger;
  tags: string[];
  done: boolean;
  channel: string;
  /** Whose movement fires this note: '' = the note's owner, otherwise a connected peer who shares live with the owner. */
  watchUserId: string;
  /** Who receives the reminder. Each id is the owner or an accepted connection. Empty means [owner]. */
  notifyUserIds: string[];
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
  /** User whose device crossed the fence (differs from userId, the place owner, for a peer crossing). */
  subjectUserId: string;
  /** Display name of subjectUserId, so a toast can say "Nishtha arrived at Grocery". */
  subjectName: string;
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
  /** 'note' = a note fired; 'watch' = a watched person crossed a fence, no note involved. */
  kind: 'note' | 'watch';
  /** Owner of the note/place when it is not the recipient (e.g. Harsh's note delivered to Nishtha). */
  fromUserId?: string;
  fromName?: string;
};

/** MapProvider is the basemap a deployment draws: the open default, or Mappls. */
export type MapProvider = 'maplibre' | 'mappls';

/** ServerInfo lets the UI reflect the deployment instead of hard-coding it. */
export type ServerInfo = {
  version: string;
  store: string;
  mapStyleUrl: string;
  /** Which basemap to draw; airgap always reports the open renderer. */
  mapProvider?: MapProvider;
  /** Mappls Web SDK browser key, present only while Mappls is the provider. */
  mapplsWebKey?: string;
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
  /**
   * The only configuration a recipient is told about. Deliberately not the whole
   * server block — an endpoint anyone with a link can call should not fingerprint
   * the deployment — but the basemap URL has to be here, because without it the
   * viewer is markers on blank ground.
   */
  map?: { styleUrl?: string; provider?: MapProvider; mapplsWebKey?: string; airgap: boolean };
};

/** The WebSocket envelope from internal/hub. */
/** SnapshotPeer is one connected person in the socket's first frame. */
export type SnapshotPeer = {
  userId: string;
  devices: { id: string; name: string; point?: Point; speedMps?: number; lastSeen?: string }[] | null;
};

export type Frame =
  | { type: 'hello'; ts: string; data: { clientId: string; viewerId: string; subjects: string[] } }
  | {
      type: 'snapshot';
      ts: string;
      data: {
        devices?: Device[];
        /** Connected people sharing with the viewer, with each device's last known point. */
        peers?: SnapshotPeer[];
        places?: Place[];
        server?: ServerInfo;
        share?: PublicShareView;
      };
    }
  | { type: 'position'; ts: string; subject?: string; data: Position }
  | { type: 'geo'; ts: string; subject?: string; data: GeoEvent }
  | { type: 'notify'; ts: string; subject?: string; data: Reminder }
  | { type: 'acl'; ts: string; subject?: string; data: { action: string; shareId?: string; reason?: string } }
  | { type: 'pong'; ts: string; data?: unknown }
  | { type: 'closing'; ts: string; data?: { reason?: string } }
  | { type: 'error'; ts: string; data?: { error?: string } };

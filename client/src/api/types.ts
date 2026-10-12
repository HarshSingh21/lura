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
  /** Whose device crossed (a watched peer, or the owner). */
  subjectUserId?: string;
  subjectName?: string;
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
  /**
   * When the device was at `point`, on the server's clock: its own timestamp
   * corrected for how far its clock is off. Older than `recvTs` for a fix a
   * phone queued offline. Absent from older servers and from snapshots.
   */
  fixTs?: string;
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
  /**
   * 'note' = a note fired; 'watch' = a watched person crossed a fence, no note involved;
   * 'ack' = someone you sent a note to acknowledged it (arrives already 'acknowledged').
   */
  kind: ReminderKind;
  /** Owner of the note/place when it is not the recipient (e.g. Harsh's note delivered to Nishtha). */
  fromUserId?: string;
  fromName?: string;
  /**
   * The stored ReminderRecord this frame delivers. Absent only for the owner's own
   * crossing of a place with no note (a plain live toast, nothing to acknowledge).
   */
  id?: string;
  status?: ReminderStatus;
  ownerId?: string;
  eventId?: string;
  createdAt?: string;
  subjectUserId?: string;
  subjectName?: string;
  ackedAt?: string;
  ackedBy?: string;
};

export type ReminderKind = 'note' | 'watch' | 'ack';

export type ReminderStatus = 'pending' | 'acknowledged';

/**
 * A delivered reminder, stored per recipient (GET /api/v1/reminders). A pending one
 * stays on screen until POST /api/v1/reminders/{id}/ack.
 */
export type ReminderRecord = {
  id: string;
  /** The recipient. Only they can see or acknowledge it. */
  userId: string;
  /** Owner of the note/place that produced it. */
  ownerId: string;
  noteIds: string[];
  placeId: string;
  placeName: string;
  trigger: Trigger;
  kind: ReminderKind;
  title: string;
  body: string;
  /** Whose device crossed. */
  subjectUserId: string;
  subjectName: string;
  /** Set when ownerId is not the recipient. */
  fromUserId?: string;
  fromName?: string;
  /** The geo event that produced it ('' for kind 'ack'). */
  eventId: string;
  createdAt: string;
  status: ReminderStatus;
  ackedAt?: string;
  /** User id that acknowledged (the recipient; for kind 'ack', the peer who acknowledged). */
  ackedBy?: string;
};

/** WS frame payload: a reminder was acknowledged in some session; clear it everywhere. */
export type ReminderAck = { id: string; ackedAt: string };

/** POST /api/v1/reminders/{id}/ack response. */
export type AckResponse = {
  reminder: ReminderRecord;
  /** Notes the ack marked done (owner acked, or every recipient has). */
  notesDone: string[];
};

/** Kind of a connection change in the activity feed. */
export type ConnectionAction = 'invited' | 'accepted' | 'paused' | 'resumed' | 'removed';

/**
 * GET /api/v1/activity?from&to&limit → { items: ActivityItem[], from, to }.
 * Newest first by ts (RFC3339). `id` is unique within a response and stable across calls.
 */
export type ActivityItem =
  | {
      type: 'trip';
      id: string;
      ts: string; // = startTs
      deviceId: string;
      deviceName: string;
      mode: string;
      startTs: string;
      endTs: string;
      distanceM: number;
      fromPlace?: string;
      toPlace?: string;
      path: Point[];
    }
  | {
      type: 'stop';
      id: string;
      ts: string; // = startTs
      deviceId: string;
      deviceName: string;
      startTs: string;
      endTs: string;
      atPlace?: string;
      point?: Point;
    }
  | {
      /** A fence crossing on one of your places (yours, or a watched person's). */
      type: 'geo';
      id: string;
      ts: string;
      /**
       * The crossing's GeoEvent id (geo_…) — the id the WS geo frame and its
       * reminders carry as eventId. Rows recorded before 0.2.0 carry their
       * trigger-event id here instead.
       */
      eventId: string;
      /** The stored trigger-history row (evt_…). */
      triggerEventId?: string;
      placeId: string;
      placeName: string;
      trigger: Trigger;
      deviceId: string;
      subjectUserId: string;
      subjectName: string;
      noteIds: string[];
      delivered: string[];
    }
  | { type: 'reminder'; id: string; ts: string; reminder: ReminderRecord }
  | {
      type: 'ack';
      id: string;
      ts: string; // = ackedAt
      reminderId: string;
      title: string;
      body: string;
      placeName: string;
      noteIds: string[];
      ackedBy: string;
      ackedByName: string;
      /** true = you acknowledged your own reminder; false = a person you notified acknowledged. */
      byMe: boolean;
    }
  | {
      type: 'connection';
      id: string;
      ts: string;
      action: ConnectionAction;
      peerId: string;
      peerName: string;
      /** true when you made the change, false when the peer did. */
      byMe: boolean;
    }
  | {
      type: 'share';
      id: string;
      ts: string;
      action: 'created' | 'revoked';
      shareId: string;
      label: string;
      mode: ShareMode;
      reason?: string;
    };

export type ActivityResponse = { items: ActivityItem[]; from: string; to: string };

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
  /** Server time the snapshot was read at (older servers omit it). */
  asOf?: string;
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
  | { type: 'reminder_ack'; ts: string; subject?: string; data: ReminderAck }
  | { type: 'acl'; ts: string; subject?: string; data: { action: string; shareId?: string; reason?: string } }
  | { type: 'pong'; ts: string; data?: unknown }
  | { type: 'closing'; ts: string; data?: { reason?: string } }
  | { type: 'error'; ts: string; data?: { error?: string } };

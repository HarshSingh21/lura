/**
 * Which credential this app publishes its own fixes with.
 *
 * /pub takes device credentials only — a person's session token is deliberately
 * not accepted for ingest (internal/auth DeviceAuth) — so a signed-in browser
 * cannot just post its fixes the way the development setup does with the static
 * API token. The rule, in order:
 *
 *   1. A device credential this app already holds for this user is used as-is.
 *   2. Otherwise the session token is tried with `?device=` — what the static
 *      development token (no Keycloak) is allowed to do.
 *   3. If that is refused (401/403), this app registers a device of its own
 *      ("This browser" / "This phone") and keeps its ingest token. It never
 *      rotates an existing device's token: that would silently cut off the
 *      phone or OwnTracks install already publishing with it.
 *
 * A held credential that stops working (device deleted, token rotated) is
 * dropped and the rule starts over, once per fix.
 *
 * Kept free of React and of runtime imports so it is tested with fakes
 * (publisher.test.mts); useTracking wires in the real request and storage.
 */

export type DeviceCredential = { deviceId: string; token: string };

export type PublisherDeps = {
  /** POST /pub with the given body; `bearerToken` overrides the session token. Rejects with `{ status }` on HTTP errors. */
  post: (path: string, body: unknown, bearerToken?: string) => Promise<unknown>;
  /** Registers a device for this app and returns its id and ingest token. */
  register: () => Promise<DeviceCredential>;
  load: () => Promise<DeviceCredential | null>;
  save: (cred: DeviceCredential | null) => Promise<void>;
};

export type PublishResult = { via: 'device-token' | 'session'; deviceId: string; registered?: boolean };

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

const refused = (err: unknown) => {
  const s = statusOf(err);
  return s === 401 || s === 403;
};

export class Publisher {
  private cred: DeviceCredential | null | undefined;
  /** Set once the session token has been refused, so it is not retried on every fix. */
  private sessionRefused = false;

  private readonly deps: PublisherDeps;

  constructor(deps: PublisherDeps) {
    this.deps = deps;
  }

  private async credential(): Promise<DeviceCredential | null> {
    if (this.cred === undefined) {
      try {
        this.cred = await this.deps.load();
      } catch {
        this.cred = null;
      }
    }
    return this.cred;
  }

  private async forget(): Promise<void> {
    this.cred = null;
    await this.deps.save(null).catch(() => undefined);
  }

  /**
   * publish sends one fix. `deviceId` is the device the session would publish as
   * (step 2); it may be empty for a brand-new account with no devices yet.
   */
  async publish(body: unknown, deviceId: string): Promise<PublishResult> {
    const held = await this.credential();
    if (held) {
      try {
        await this.deps.post('/pub', body, held.token);
        return { via: 'device-token', deviceId: held.deviceId };
      } catch (err) {
        if (!refused(err)) throw err;
        await this.forget();
      }
    }

    if (deviceId && !this.sessionRefused) {
      try {
        await this.deps.post(`/pub?device=${encodeURIComponent(deviceId)}`, body);
        return { via: 'session', deviceId };
      } catch (err) {
        if (!refused(err)) throw err;
        this.sessionRefused = true;
      }
    }

    const cred = await this.deps.register();
    this.cred = cred;
    await this.deps.save(cred).catch(() => undefined);
    await this.deps.post('/pub', body, cred.token);
    return { via: 'device-token', deviceId: cred.deviceId, registered: true };
  }
}

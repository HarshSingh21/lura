import { Platform } from 'react-native';

/**
 * The HTTP client.
 *
 * Two things it deliberately does:
 *
 *   - Resolves the API base URL at runtime. On web, the app is usually served by
 *     the Go binary itself, so same-origin is the right default and no
 *     configuration is needed; on a device, localhost means the phone, so an
 *     explicit address is required and the UI has to be able to ask for one.
 *   - Turns the server's error envelope into a typed ApiError. The server already
 *     maps domain errors to statuses, so the client can branch on `status`
 *     instead of parsing prose.
 */

export type ApiErrorBody = { error?: string; code?: string; traceId?: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId?: string;

  constructor(status: number, body: ApiErrorBody, fallback: string) {
    super(body.error || fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code ?? 'unknown';
    this.traceId = body.traceId;
  }

  /** True when the failure is the caller's fault and retrying will not help. */
  get isClientError() {
    return this.status >= 400 && this.status < 500;
  }
}

const ENV_URL = process.env.EXPO_PUBLIC_LURA_API_URL?.replace(/\/$/, '');
const ENV_TOKEN = process.env.EXPO_PUBLIC_LURA_TOKEN;

/** DEFAULT_TOKEN matches the server's Phase 1 default so a fresh clone just works. */
export const DEFAULT_TOKEN = ENV_TOKEN ?? 'lura-dev-token';

/**
 * defaultBaseUrl picks the most likely server for this platform.
 *
 * Web: same origin when the app is served by the Go binary, otherwise the dev
 * server's sibling port. Native: there is no sensible default for a phone (its
 * localhost is itself), so the Settings screen exposes the field — 10.0.2.2 is
 * used on Android emulators, where it is the host machine.
 */
export function defaultBaseUrl(): string {
  if (ENV_URL) return ENV_URL;

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const { origin, port } = window.location;
    // Served by the Go binary (any port but Metro's): talk to the same origin.
    if (port !== '8081' && port !== '19006') return origin;
    return 'http://localhost:8080';
  }
  if (Platform.OS === 'android') return 'http://10.0.2.2:8080';
  return 'http://localhost:8080';
}

export type ClientConfig = { baseUrl: string; token: string };

let config: ClientConfig = { baseUrl: defaultBaseUrl(), token: DEFAULT_TOKEN };

/**
 * The signed-in session's access token, when there is one.
 *
 * Auth is wired in as a *provider* rather than an import so this module stays
 * free of a cycle (the session store needs the client to refresh). The token
 * rotates roughly every 15 minutes, so it is read per request — capturing it
 * once would start 401ing a quarter of an hour after sign-in.
 */
type TokenProvider = () => string | undefined;
let sessionToken: TokenProvider = () => undefined;
let freshSessionToken: () => Promise<string | undefined> = async () => sessionToken();

/** setSessionTokenProvider is called once, during app start-up. */
export function setSessionTokenProvider(current: TokenProvider, fresh?: () => Promise<string | undefined>) {
  sessionToken = current;
  if (fresh) freshSessionToken = fresh;
}

/** bearer prefers a real session and falls back to the development token. */
function bearer(): string {
  return sessionToken() ?? config.token;
}

export function getConfig(): ClientConfig {
  return config;
}

export function setConfig(next: Partial<ClientConfig>) {
  config = {
    baseUrl: (next.baseUrl ?? config.baseUrl).replace(/\/$/, ''),
    token: next.token ?? config.token,
  };
}

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Public endpoints (a share link) must not send the owner's token. */
  anonymous?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** request performs one API call and returns the decoded JSON body. */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { baseUrl } = config;
  const method = opts.method ?? 'GET';

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!opts.anonymous) headers.Authorization = `Bearer ${bearer()}`;

  // A hung request must not hang the UI: every call gets a deadline, and the
  // caller's own signal still wins.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });

    if (response.status === 204) return undefined as T;

    const text = await response.text();
    const parsed: unknown = text ? safeParse(text) : undefined;

    if (!response.ok) {
      throw new ApiError(
        response.status,
        (parsed as ApiErrorBody | undefined) ?? {},
        `${method} ${path} failed with ${response.status}`,
      );
    }
    return parsed as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (controller.signal.aborted && !opts.signal?.aborted) {
      throw new ApiError(0, { code: 'timeout', error: `${method} ${path} timed out` }, 'timeout');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 300) };
  }
}

/** wsUrl converts an API path into a WebSocket URL against the same server. */
export function wsUrl(path: string, opts: { anonymous?: boolean } = {}): string {
  const { baseUrl } = config;
  const scheme = baseUrl.startsWith('https') ? 'wss' : 'ws';
  const host = baseUrl.replace(/^https?:\/\//, '');
  // Browsers cannot attach headers to a WebSocket handshake, so the token has to
  // ride in the query string; the server accepts it there for /ws only.
  const auth = opts.anonymous ? '' : `${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(bearer())}`;
  return `${scheme}://${host}${path}${auth}`;
}

/**
 * wsUrlFresh is wsUrl with a guaranteed-valid token.
 *
 * A WebSocket handshake carries its credential in the query string and cannot
 * retry a 401 the way a fetch can, so it is worth awaiting a refresh first.
 */
export async function wsUrlFresh(path: string, opts: { anonymous?: boolean } = {}): Promise<string> {
  if (!opts.anonymous) await freshSessionToken();
  return wsUrl(path, opts);
}

/** downloadUrl builds an authenticated export link (used by the export buttons). */
export function downloadUrl(path: string): string {
  const { baseUrl } = config;
  const sep = path.includes('?') ? '&' : '?';
  return `${baseUrl}${path}${sep}access_token=${encodeURIComponent(bearer())}`;
}

/** downloadUrlFresh refreshes first, for the same reason as wsUrlFresh. */
export async function downloadUrlFresh(path: string): Promise<string> {
  await freshSessionToken();
  return downloadUrl(path);
}

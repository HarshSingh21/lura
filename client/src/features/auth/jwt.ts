/**
 * Just enough JWT to read the ID token's claims.
 *
 * The client never *verifies* the signature — it cannot, and it must not pretend
 * to: the server is the only party that gets to decide whether a token is valid.
 * This decodes the payload purely so the UI can show a name and an avatar without
 * a second round trip to `/userinfo`.
 *
 * `atob` is not dependable across Hermes, Node and the browser, and neither is
 * `TextDecoder`, so the base64url → UTF-8 path is written out by hand here rather
 * than assuming a global that happens to exist on whichever surface was tested.
 */

export type Profile = {
  sub: string;
  name?: string;
  email?: string;
  /** Keycloak's `preferred_username` — the login name, shown when there is no full name. */
  preferredUsername?: string;
  picture?: string;
};

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64UrlToBytes(input: string): Uint8Array {
  const normalised = input.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = new Uint8Array((normalised.length * 3) >> 2);
  let buffer = 0;
  let bits = 0;
  let out = 0;

  for (const char of normalised) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) continue; // padding and stray whitespace
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (buffer >> bits) & 0xff;
    }
  }

  return bytes.subarray(0, out);
}

/** Percent-escaping every byte lets `decodeURIComponent` do the UTF-8 work. */
function bytesToUtf8(bytes: Uint8Array): string {
  let escaped = '';
  for (const byte of bytes) escaped += `%${byte.toString(16).padStart(2, '0')}`;
  return decodeURIComponent(escaped);
}

type Claims = Record<string, unknown>;

function claimString(claims: Claims, key: string): string | undefined {
  const value = claims[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * decodeIdToken returns the profile claims, or `undefined` for anything it cannot
 * read. A malformed token is not worth throwing over: the access token is what
 * grants access, and a missing display name only costs an avatar.
 */
export function decodeIdToken(idToken: string | undefined): Profile | undefined {
  if (!idToken) return undefined;

  const payload = idToken.split('.')[1];
  if (!payload) return undefined;

  try {
    const parsed: unknown = JSON.parse(bytesToUtf8(base64UrlToBytes(payload)));
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    const claims = parsed as Claims;
    const sub = claimString(claims, 'sub');
    if (!sub) return undefined;

    return {
      sub,
      name: claimString(claims, 'name'),
      email: claimString(claims, 'email'),
      preferredUsername: claimString(claims, 'preferred_username'),
      picture: claimString(claims, 'picture'),
    };
  } catch {
    return undefined;
  }
}

/** initialsFor is the two-letter avatar fallback used by the top bar. */
export function initialsFor(profile: Profile | undefined): string {
  const source = profile?.name ?? profile?.preferredUsername ?? profile?.email;
  if (!source) return '··';

  const words = source.split(/[\s._-]+/).filter(Boolean);
  const first = words[0]?.[0];
  const second = words.length > 1 ? words[words.length - 1]?.[0] : words[0]?.[1];
  return `${first ?? ''}${second ?? ''}`.toUpperCase() || '··';
}

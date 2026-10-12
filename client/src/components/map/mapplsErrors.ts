/**
 * isFatalMapplsError decides whether an `error` event from the Mappls Web SDK
 * means the map will never work (so the caller should hand over to MapLibre),
 * or is one tile having a bad moment.
 *
 * The SDK is MapLibre underneath and reports tile failures the same way: an
 * AJAX error whose message carries the tile URL — and every Mappls tile URL
 * carries `access_token=`. Matching words like "token" or "key" against the raw
 * message therefore turned a single 412 or 408 on one tile into a swap of the
 * whole renderer, seconds after a map that was drawing perfectly well.
 *
 * So: a 401/403 is a rejected key or domain, and fatal wherever it comes from.
 * Any other failure that names a tile or a source, or carries any other HTTP
 * status, is not. What is left is judged on the message with its URLs removed.
 */
export function isFatalMapplsError(event: unknown): boolean {
  const ev = (event ?? {}) as { error?: { message?: unknown; status?: unknown }; tile?: unknown; sourceId?: unknown };
  const raw = typeof ev.error?.message === 'string' ? ev.error.message : '';
  const message = raw.replace(/\bhttps?:\/\/\S+/gi, ' ');
  const status = typeof ev.error?.status === 'number' ? ev.error.status : Number(/\((\d{3})\)/.exec(message)?.[1] ?? NaN);
  if (status === 401 || status === 403) return true;
  if (ev.tile !== undefined || ev.sourceId !== undefined) return false;
  if (Number.isFinite(status)) return false;
  return /unauthori[sz]ed|forbidden|invalid (api )?(key|token)|access token|licen[cs]e|style/i.test(message);
}

/**
 * describeFailure turns whatever made the Mappls renderer give up (an SDK error
 * event, a rejected promise, a timeout) into one line for the console, with the
 * key taken out of any URL in it.
 */
export function describeFailure(reason: unknown): string {
  const ev = reason as { error?: { message?: unknown }; message?: unknown } | null;
  const text =
    typeof reason === 'string'
      ? reason
      : typeof ev?.error?.message === 'string'
        ? ev.error.message
        : typeof ev?.message === 'string'
          ? ev.message
          : String(reason);
  return text.replace(/(access_token|key)=[^&\s]*/gi, '$1=…');
}

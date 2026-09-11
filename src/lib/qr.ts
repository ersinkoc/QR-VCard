/**
 * QR images come from the app server at `/api/qr/<code>` — the same origin as the
 * rest of the app. The browser only names the short code; the server builds the
 * link, calls the provider with its key and caches the PNG (see
 * server/qr-handler.mjs). A plain <img src> is therefore all the client needs.
 */
export type QrStyle = 'standard' | 'art';

export function qrImageUrl(code: string, options?: { style?: QrStyle }): string {
  const base = `/api/qr/${encodeURIComponent(code)}`;
  return options?.style ? `${base}?style=${options.style}` : base;
}

/** Same image, served as an attachment (`qr-<code>.png`). */
export function qrDownloadUrl(code: string, options?: { style?: QrStyle }): string {
  const base = `/api/qr/${encodeURIComponent(code)}?download=1`;
  return options?.style ? `${base}&style=${options.style}` : base;
}

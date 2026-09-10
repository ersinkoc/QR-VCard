/**
 * QR adapter seam — request side for the Art QR generation API.
 *
 * The QR service is called with `POST /QR/create`, an `ApiKey` header and a JSON
 * InputParameters body (Swagger: https://artqrcode.oxog.net/swagger/index.html).
 *
 * Response parsing is deliberately NOT implemented. As of 2026-09-10 the
 * endpoint answers every authenticated request with a bare 500 — no
 * Content-Type, zero bytes — so its success shape (raw PNG, JSON carrying
 * base64, or a URL?) has never been observed. `parseQrResponse()` is the single
 * place that will do it, and until then it throws with the observed evidence
 * rather than encoding a guess. `npm run qr:verify` prints the shape the moment
 * the provider returns a 200.
 *
 * `qrUrl()` keeps its async "resolve to an <img>-usable src" contract, so
 * QrDisplay and PanelPage need no changes when parsing lands.
 */

export interface QrRequest {
  url: string;
  init: RequestInit;
}

const ECC_LEVEL = 'M';
const EXPORT_WIDTH = 512;

/**
 * API base URL, e.g. `https://artqrcode.oxog.net`. A URL is not a secret, so
 * keeping it in the client bundle is fine.
 */
export function qrApiBase(): string {
  const base = import.meta.env.VITE_QR_API_URL?.trim();
  if (!base) throw new Error('VITE_QR_API_URL is not configured (QR API base URL).');
  return base.replace(/\/+$/, '');
}

/**
 * SECURITY: this key is inlined into the client bundle because the call is made
 * from the browser, so it is readable by anyone who loads the app. For anything
 * public, route the request through a server-side proxy instead of shipping the
 * key. The local diagnostic (`npm run qr:verify`) prefers the non-VITE name
 * `QR_API_KEY` for exactly this reason.
 */
function qrApiKey(): string {
  const key = import.meta.env.VITE_QR_API_KEY?.trim();
  if (!key) throw new Error('VITE_QR_API_KEY is not configured (QR API key, sent as the ApiKey header).');
  return key;
}

/** Builds the POST request. Pure, so tests can assert it without a network. */
export function qrRequest(data: string): QrRequest {
  return {
    url: `${qrApiBase()}/QR/create`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ApiKey: qrApiKey() },
      body: JSON.stringify({ inputText: data, exportWidth: EXPORT_WIDTH, exportPNG: true, eccLevel: ECC_LEVEL }),
    },
  };
}

/** Sends the request. Kept separate from qrRequest so both stay testable. */
export async function requestQr(data: string): Promise<Response> {
  const { url, init } = qrRequest(data);
  return fetch(url, init);
}

/**
 * Turns a successful response into an `<img>`-usable src.
 *
 * NOT IMPLEMENTED ON PURPOSE — see the module header. Implement it from a real
 * 200 response, never from a guess: run `npm run qr:verify`, then parse the
 * shape it reports.
 */
export async function parseQrResponse(res: Response): Promise<string> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') ?? '(none)';
  throw new Error(
    `QR API returned 200 with ${bytes.length} bytes and content-type "${contentType}", but response parsing is not implemented yet — run npm run qr:verify and implement it against the reported shape.`,
  );
}

/** Stable async contract: always resolves to an <img>-usable src. */
export async function qrUrl(data: string): Promise<string> {
  const res = await requestQr(data);
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`QR API request failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ' (empty body)'}`);
  }
  return parseQrResponse(res);
}

export async function downloadQr(data: string, filename: string): Promise<void> {
  const src = await qrUrl(data);
  const a = document.createElement('a');
  if (src.startsWith('data:')) {
    a.href = src;
  } else {
    const blob = await (await fetch(src)).blob();
    a.href = URL.createObjectURL(blob);
  }
  a.download = filename;
  a.click();
  if (a.href.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

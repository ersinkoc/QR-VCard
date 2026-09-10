/**
 * QR adapter seam.
 *
 * The product will use an external QR generation API (to be provided).
 * Until then:
 *  - If `VITE_QR_API_URL` is set, it is used as the image URL. A literal
 *    `{data}` in the template is replaced by the URL-encoded target link;
 *    otherwise `data=<encoded>` is appended as a query parameter.
 *  - Otherwise a QR is generated locally with the `qrcode` package
 *    (lazy-loaded so it stays out of the main bundle).
 */

type QrModule = typeof import('qrcode');

let mod: QrModule | null = null;

async function loadQr(): Promise<QrModule> {
  mod ??= await import('qrcode');
  return mod;
}

export function externalQrUrl(data: string): string | null {
  const template = import.meta.env.VITE_QR_API_URL?.trim();
  if (!template) return null;
  if (template.includes('{data}')) return template.replace('{data}', encodeURIComponent(data));
  return `${template}${template.includes('?') ? '&' : '?'}data=${encodeURIComponent(data)}`;
}

export async function qrDataUrl(data: string): Promise<string> {
  const qr = await loadQr();
  return qr.toDataURL(data, { margin: 1, width: 512, color: { dark: '#191921', light: '#ffffff' } });
}

/** Stable async contract: always resolves to an <img>-usable src. */
export async function qrUrl(data: string): Promise<string> {
  return externalQrUrl(data) ?? qrDataUrl(data);
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

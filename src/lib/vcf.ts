/** Minimal contact shape for building a vCard file (subset of `VCard`). */
export interface VCardContact {
  firstName?: string | null;
  lastName?: string | null;
  organization?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  note?: string | null;
}

/** RFC 6350 escaping; also valid for the VALUE text lists of VERSION:3.0. */
const esc = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

export function buildVcf(c: VCardContact): string {
  const fn = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || 'Contact';
  const lines: string[] = ['BEGIN:VCARD', 'VERSION:3.0', `N:${esc(c.lastName ?? '')};${esc(c.firstName ?? '')};;;`, `FN:${esc(fn)}`];
  if (c.organization) lines.push(`ORG:${esc(c.organization)}`);
  if (c.jobTitle) lines.push(`TITLE:${esc(c.jobTitle)}`);
  if (c.phone) lines.push(`TEL;TYPE=CELL:${esc(c.phone)}`);
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${esc(c.email)}`);
  if (c.website) lines.push(`URL:${esc(c.website)}`);
  if (c.address) lines.push(`ADR;TYPE=HOME:;;${esc(c.address)};;;;`);
  if (c.note) lines.push(`NOTE:${esc(c.note)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}

export function fileNameFor(c: VCardContact): string {
  const base = [c.firstName, c.lastName].filter(Boolean).join('-').trim();
  const cleaned = base.replace(/[^A-Za-z0-9 -]+/g, '').trim().replaceAll(' ', '-');
  return (cleaned || 'contact') + '.vcf';
}

/** "Add to contacts": a .vcf download is the one method that works on iOS Safari and Android alike. */
export function downloadVcf(c: VCardContact): void {
  const blob = new Blob([buildVcf(c)], { type: 'text/vcard;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileNameFor(c);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

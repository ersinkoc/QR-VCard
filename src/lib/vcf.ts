/** Minimal contact shape for building a vCard file. */
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
  /** Embedded photo: base64 without prefix. */
  photo?: { base64: string; type: 'JPEG' | 'PNG' } | null;
}

/** The card fields as the API returns them (snake_case). */
export interface CardFields {
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
  job_title: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  note: string | null;
}

/**
 * Card -> contact. The API speaks snake_case and this module camelCase; passing a
 * card straight to buildVcf once produced a vCard without name, organization or
 * title, because the camelCase keys were simply absent.
 */
export function contactFromCard(card: CardFields): VCardContact {
  return {
    firstName: card.first_name,
    lastName: card.last_name,
    organization: card.organization,
    jobTitle: card.job_title,
    phone: card.phone,
    email: card.email,
    website: card.website,
    address: card.address,
    note: card.note,
  };
}

/** RFC 6350 escaping; also valid for the VALUE text lists of VERSION:3.0. */
const esc = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Folds a long ASCII line at 75 octets (RFC 2425 §5.8.1) — needed for PHOTO. */
export function fold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
  return parts.join('\r\n');
}

export function buildVcf(c: VCardContact): string {
  const fn = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.organization || 'Contact';
  const lines: string[] = ['BEGIN:VCARD', 'VERSION:3.0', `N:${esc(c.lastName ?? '')};${esc(c.firstName ?? '')};;;`, `FN:${esc(fn)}`];
  if (c.organization) lines.push(`ORG:${esc(c.organization)}`);
  if (c.jobTitle) lines.push(`TITLE:${esc(c.jobTitle)}`);
  if (c.phone) lines.push(`TEL;TYPE=CELL:${esc(c.phone)}`);
  if (c.email) lines.push(`EMAIL;TYPE=INTERNET:${esc(c.email)}`);
  if (c.website) lines.push(`URL:${esc(c.website)}`);
  if (c.address) lines.push(`ADR;TYPE=WORK:;;${esc(c.address)};;;;`);
  if (c.note) lines.push(`NOTE:${esc(c.note)}`);
  if (c.photo) lines.push(fold(`PHOTO;ENCODING=b;TYPE=${c.photo.type}:${c.photo.base64}`));
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}

export function fileNameFor(c: VCardContact): string {
  const base = [c.firstName, c.lastName].filter(Boolean).join('-').trim() || c.organization || '';
  const cleaned = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^A-Za-z0-9 -]+/g, '')
    .trim()
    .replaceAll(' ', '-');
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

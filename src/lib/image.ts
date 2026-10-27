/**
 * Scales a picked photo down before upload: phones produce 3–12 MB originals, the
 * card shows 512 px. Falls back to the original file when the browser cannot
 * decode it (the server then validates the type itself).
 */
export async function shrinkImage(file: File, maxEdge = 1024): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

/** Base64 of a blob, without the data: prefix (for the vCard PHOTO property). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function mixWithWhite(hex: string, white = 0.18): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return '#5277f7';
  const value = Number.parseInt(match[1]!, 16);
  const channel = (shift: number) => Math.round(((value >> shift) & 0xff) * (1 - white) + 255 * white);
  return `#${[channel(16), channel(8), channel(0)].map((part) => part.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Generates the address-book photo when a card has no uploaded image. The
 * square JPEG is deliberately self-contained: iOS and Android import it from
 * the vCard without needing a network URL later.
 */
export async function generateContactPhoto({
  name,
  organization,
  accent = '#2457f5',
  design = 'executive',
}: {
  name: string;
  organization?: string | null;
  accent?: string | null;
  design?: CardDesign | null;
}): Promise<Blob> {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');

  const dark = new Set<CardDesign>(['signal', 'noir', 'monolith', 'midnight', 'cobalt', 'aurora', 'ember', 'copper', 'terminal', 'blueprint', 'orbit', 'forest']).has(design ?? 'executive');
  const editorial = new Set<CardDesign>(['editorial', 'atelier', 'archive', 'gallery', 'studio', 'ivory']).has(design ?? 'executive');
  const technical = new Set<CardDesign>(['terminal', 'blueprint', 'grid', 'kinetic', 'orbit']).has(design ?? 'executive');
  const ink = dark ? '#f7f8fb' : '#151821';
  const background = dark ? '#07101f' : editorial ? '#f1e4cd' : '#f8f5ee';
  const brand = mixWithWhite(accent || '#2457f5', dark ? 0.24 : 0.08);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size, size);

  if (editorial) {
    ctx.fillStyle = brand;
    ctx.beginPath();
    ctx.arc(470, 42, 150, 0, Math.PI * 2);
    ctx.fill();
  } else if (dark || technical) {
    ctx.strokeStyle = `${brand}40`;
    ctx.lineWidth = 1;
    for (let p = 0; p <= size; p += 48) {
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
    }
    ctx.fillStyle = brand;
    ctx.fillRect(0, 0, 14, size);
  } else {
    ctx.fillStyle = brand;
    ctx.fillRect(0, 0, size, 18);
  }

  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toLocaleUpperCase() || 'QR';
  ctx.fillStyle = dark ? `${brand}2f` : `${brand}22`;
  ctx.beginPath();
  ctx.arc(256, 226, 138, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = brand;
  ctx.lineWidth = editorial ? 3 : 7;
  ctx.stroke();

  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${editorial ? '500' : '750'} 142px ${editorial ? 'Georgia, serif' : technical ? 'monospace' : 'Arial, sans-serif'}`;
  ctx.fillText(initials, 256, 226);

  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 21px Arial, sans-serif';
  ctx.fillStyle = brand;
  const label = (organization || name).toLocaleUpperCase().slice(0, 34);
  ctx.fillText(label, 256, 440);
  ctx.fillStyle = ink;
  ctx.font = '700 14px monospace';
  ctx.fillText('DIGITAL CONTACT / QR—VCARD', 256, 474);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) throw new Error('contact photo rendering failed');
  return blob;
}
import type { CardDesign } from './card-designs';

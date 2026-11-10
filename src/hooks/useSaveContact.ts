import { useState } from 'react';
import type { PublicCard } from '../lib/api';
import { publicLogoUrl, publicPhotoUrl } from '../lib/api';
import { blobToBase64, generateContactPhoto } from '../lib/image';
import { contactFromCard, downloadVcf } from '../lib/vcf';

/**
 * Builds and downloads the card's .vcf, with an image embedded so it lands in
 * the address book too: the photo, else the logo, else a generated brand tile.
 */
export function useSaveContact(card: PublicCard, name: string) {
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const contact = contactFromCard(card);
      let photo: Blob | null = null;
      for (const url of [publicPhotoUrl(card, 'jpg'), publicLogoUrl(card, 'jpg')]) {
        if (photo || !url) continue;
        try {
          const res = await fetch(url);
          if (res.ok) photo = await res.blob();
        } catch {
          /* next source, then the generated fallback */
        }
      }
      photo ??= await generateContactPhoto({ name, organization: card.organization, accent: card.accent_color, design: card.design_style });
      contact.photo = { base64: await blobToBase64(photo), type: 'JPEG' };
      downloadVcf(contact);
    } finally {
      setBusy(false);
    }
  }

  return { save, busy };
}

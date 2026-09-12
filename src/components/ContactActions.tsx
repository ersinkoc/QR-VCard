import { useState } from 'react';
import { useI18n } from '../i18n';
import type { PublicCard } from '../lib/api';
import { displayName, publicPhotoUrl } from '../lib/api';
import { blobToBase64 } from '../lib/image';
import { contactFromCard, downloadVcf } from '../lib/vcf';

export default function ContactActions({ card }: { card: PublicCard }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const tel = card.phone?.replace(/[^\d+]/g, '') ?? null;
  // The stored value IS the canonical wa.me link when set; only fall back to
  // deriving it from the phone for cards saved before the social fields.
  const wa = card.whatsapp ?? (card.phone ? `https://wa.me/${card.phone.replace(/[^\d]/g, '')}` : null);
  const name = displayName(card) || card.organization || t('scan.contact');

  async function addToContacts() {
    setBusy(true);
    try {
      const contact = contactFromCard(card);
      // Embed the photo so it lands in the address book too; a failure just
      // leaves it out rather than blocking the contact.
      const photoUrl = publicPhotoUrl(card, 'jpg');
      if (photoUrl) {
        try {
          const res = await fetch(photoUrl);
          if (res.ok) contact.photo = { base64: await blobToBase64(await res.blob()), type: 'JPEG' };
        } catch {
          /* photo optional */
        }
      }
      downloadVcf(contact);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <button type="button" className="btn btn-primary col-span-2" disabled={busy} onClick={() => void addToContacts()}>
        {t('scan.addContact')}
      </button>
      {tel && (
        <a className="btn btn-secondary" href={`tel:${tel}`}>
          {t('scan.call')}
        </a>
      )}
      {card.email && (
        <a className="btn btn-secondary" href={`mailto:${card.email}`}>
          {t('scan.email')}
        </a>
      )}
      {wa && (
        <a className="btn btn-secondary" href={wa} target="_blank" rel="noreferrer">
          {t('scan.whatsapp')}
        </a>
      )}
      {card.telegram && (
        <a className="btn btn-secondary" href={card.telegram} target="_blank" rel="noreferrer">
          {t('scan.telegram')}
        </a>
      )}
      {card.linkedin && (
        <a className="btn btn-secondary" href={card.linkedin} target="_blank" rel="noreferrer">
          {t('scan.linkedin')}
        </a>
      )}
      {card.instagram && (
        <a className="btn btn-secondary" href={card.instagram} target="_blank" rel="noreferrer">
          {t('scan.instagram')}
        </a>
      )}
      {card.website && (
        <a className="btn btn-secondary" href={card.website} target="_blank" rel="noreferrer">
          {t('scan.website')}
        </a>
      )}
      {/* Web Share API: the OS share sheet on phones; hidden where unsupported. */}
      {typeof navigator.share === 'function' && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            void navigator.share({ title: name, url: window.location.href }).catch(() => {
              // user dismissed the share sheet — nothing to do
            });
          }}
        >
          {t('scan.share')}
        </button>
      )}
    </div>
  );
}

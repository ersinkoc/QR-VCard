import { useState } from 'react';
import { useI18n } from '../i18n';
import type { PublicCard } from '../lib/api';
import { displayName, publicLogoUrl, publicPhotoUrl } from '../lib/api';
import { blobToBase64, generateContactPhoto } from '../lib/image';
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
      let photo: Blob | null = null;
      if (photoUrl) {
        try {
          const res = await fetch(photoUrl);
          if (res.ok) photo = await res.blob();
        } catch {
          /* generated fallback below */
        }
      }
      if (!photo) {
        const logoUrl = publicLogoUrl(card, 'jpg');
        if (logoUrl) {
          try {
            const res = await fetch(logoUrl);
            if (res.ok) photo = await res.blob();
          } catch {
            /* generated fallback below */
          }
        }
      }
      photo ??= await generateContactPhoto({ name, organization: card.organization, accent: card.accent_color, design: card.design_style });
      contact.photo = { base64: await blobToBase64(photo), type: 'JPEG' };
      downloadVcf(contact);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card-actions">
      <button type="button" className="card-action card-action-primary col-span-2" disabled={busy} onClick={() => void addToContacts()}>
        <span className="card-action-mark" aria-hidden="true">+</span>{t('scan.addContact')}
      </button>
      {tel && (
        <a className="card-action card-action-secondary" href={`tel:${tel}`}>
          <span className="card-action-mark" aria-hidden="true">T</span>{t('scan.call')}
        </a>
      )}
      {card.email && (
        <a className="card-action card-action-secondary" href={`mailto:${card.email}`}>
          <span className="card-action-mark" aria-hidden="true">@</span>{t('scan.email')}
        </a>
      )}
      {wa && (
        <a className="card-action card-action-secondary" href={wa} target="_blank" rel="noreferrer">
          <span className="card-action-mark" aria-hidden="true">W</span>{t('scan.whatsapp')}
        </a>
      )}
      {card.telegram && (
        <a className="card-action card-action-secondary" href={card.telegram} target="_blank" rel="noreferrer">
          <span className="card-action-mark" aria-hidden="true">Tg</span>{t('scan.telegram')}
        </a>
      )}
      {card.linkedin && (
        <a className="card-action card-action-secondary" href={card.linkedin} target="_blank" rel="noreferrer">
          <span className="card-action-mark" aria-hidden="true">in</span>{t('scan.linkedin')}
        </a>
      )}
      {card.instagram && (
        <a className="card-action card-action-secondary" href={card.instagram} target="_blank" rel="noreferrer">
          <span className="card-action-mark" aria-hidden="true">ig</span>{t('scan.instagram')}
        </a>
      )}
      {card.website && (
        <a className="card-action card-action-secondary" href={card.website} target="_blank" rel="noreferrer">
          <span className="card-action-mark" aria-hidden="true">↗</span>{t('scan.website')}
        </a>
      )}
      {/* Web Share API: the OS share sheet on phones; hidden where unsupported. */}
      {typeof navigator.share === 'function' && (
        <button
          type="button"
          className="card-action card-action-secondary"
          onClick={() => {
            void navigator.share({ title: name, url: window.location.href }).catch(() => {
              // user dismissed the share sheet — nothing to do
            });
          }}
        >
          <span className="card-action-mark" aria-hidden="true">↗</span>{t('scan.share')}
        </button>
      )}
    </div>
  );
}

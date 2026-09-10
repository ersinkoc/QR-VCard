import type { VCard } from '../lib/directus';
import { downloadVcf, fileNameFor } from '../lib/vcf';

export default function ContactActions({ card }: { card: VCard }) {
  const tel = card.phone?.replace(/\s+/g, '') ?? null;
  const wa = card.phone ? `https://wa.me/${card.phone.replace(/[^\d]/g, '')}` : null;
  return (
    <div className="grid grid-cols-2 gap-2">
      <button type="button" className="btn btn-primary col-span-2" onClick={() => downloadVcf(card)}>
        Add to contacts
      </button>
      {tel && (
        <a className="btn btn-secondary" href={`tel:${tel}`}>
          Call
        </a>
      )}
      {card.email && (
        <a className="btn btn-secondary" href={`mailto:${card.email}`}>
          Email
        </a>
      )}
      {wa && (
        <a className="btn btn-secondary" href={wa} target="_blank" rel="noreferrer">
          WhatsApp
        </a>
      )}
      {card.website && (
        <a className="btn btn-secondary" href={card.website} target="_blank" rel="noreferrer">
          Website
        </a>
      )}
    </div>
  );
}

export { fileNameFor };

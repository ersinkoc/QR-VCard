import type { CardContent, Institution } from './api';

type ContactFields = Pick<CardContent, 'organization' | 'website' | 'phone' | 'email'>;

/**
 * A card as recipients see it once its institution applies — the same merge
 * the server does for the public card: the institution's name is live, its
 * website / phone / email fill only what the card leaves empty. The card's
 * address is never replaced (institution addresses are copied in the form).
 */
export function withInstitution<T extends ContactFields>(card: T, inst: Pick<Institution, 'name' | 'website' | 'phone' | 'email'> | null | undefined): T {
  if (!inst) return card;
  return {
    ...card,
    organization: inst.name || card.organization,
    website: card.website || inst.website || null,
    phone: card.phone || inst.phone || null,
    email: card.email || inst.email || null,
  };
}

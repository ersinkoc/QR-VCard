import type { CSSProperties } from 'react';
import type { CardDesign, CardContent } from '../lib/api';
import Avatar from './Avatar';

type IdentityCard = Pick<CardContent, 'first_name' | 'last_name' | 'organization' | 'job_title' | 'accent_color' | 'photo_style' | 'design_style'>;

export const cardDesign = (card: Pick<CardContent, 'design_style'>): CardDesign => card.design_style ?? 'executive';

export default function CardIdentity({ card, name, photoUrl, logoUrl, compact = false }: { card: IdentityCard; name: string; photoUrl: string | null; logoUrl?: string | null; compact?: boolean }) {
  const design = cardDesign(card);
  const accent = card.accent_color ?? '#2457f5';
  const subtitle = [card.job_title, name !== card.organization ? card.organization : null].filter(Boolean).join(' · ');
  const designClasses = design === 'grid' ? 'identity-design-grid' : `identity-${design} identity-design-${design}`;
  return (
    <div className={`identity ${designClasses} ${compact ? 'identity-compact' : ''}`} style={{ '--identity-accent': accent } as CSSProperties}>
      <div className="identity-grid" aria-hidden="true" />
      <div className="identity-kicker">{card.organization || 'QR—VCARD'}</div>
      <div className="identity-avatar">
        <Avatar name={name} photoUrl={photoUrl} accent={accent} logo={card.photo_style === 'logo'} size={compact ? 58 : 92} />
      </div>
      <div className="identity-copy">
        <h1>{name}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {logoUrl ? <img src={logoUrl} alt="" className="identity-logo" /> : <span className="identity-index" aria-hidden="true">01</span>}
    </div>
  );
}

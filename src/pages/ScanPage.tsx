import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ContactActions from '../components/ContactActions';
import CopyButton from '../components/CopyButton';
import QrDisplay from '../components/QrDisplay';
import type { VCard } from '../lib/directus';
import { fetchPublishedByCode, shortUrl } from '../lib/directus';

function Initials({ text }: { text: string }) {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  const initials = (parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1]![0] : '');
  return (
    <div className="flex h-20 w-20 items-center justify-center rounded-full text-xl font-medium" style={{ backgroundColor: 'color-mix(in oklab, var(--color-accent) 15%, transparent)' }}>
      <span className="text-accent" aria-hidden>
        {initials.toUpperCase()}
      </span>
    </div>
  );
}

export default function ScanPage() {
  const { code = '' } = useParams();
  // 'loading' sentinel distinguishes "still fetching" from "not found".
  const [card, setCard] = useState<VCard | null | 'loading'>('loading');
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    let alive = true;
    setCard('loading');
    fetchPublishedByCode(code)
      .then((c) => {
        if (alive) setCard(c);
      })
      .catch(() => {
        if (alive) setCard(null);
      });
    return () => {
      alive = false;
    };
  }, [code]);

  if (card === 'loading') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg px-4 page-pad">
        <p className="text-muted">Loading…</p>
      </main>
    );
  }

  if (!card) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg px-4 page-pad">
        <div className="card max-w-sm p-8 text-center">
          <p className="font-semibold tracking-tight">Card not available</p>
          <p className="mt-2 text-sm text-muted">This link is either wrong or the card is not published.</p>
          <Link to="/" className="btn btn-ghost mt-4">
            Go home
          </Link>
        </div>
      </main>
    );
  }

  const name = [card.first_name, card.last_name].filter(Boolean).join(' ').trim() || 'Contact';
  const url = shortUrl(card.code);
  const accent = card.accent_color ?? 'var(--color-accent)';

  return (
    <main className="min-h-dvh bg-bg px-4 page-pad">
      <div className="mx-auto w-full max-w-md">
        <div className="card overflow-hidden rise">
          {/* Accent stripe: a soft fade from the card's own colour instead of a
              flat bar — the one flourish the visitor page carries. */}
          <div
            className="h-1.5 w-full"
            style={{ background: `linear-gradient(90deg, ${accent}, color-mix(in oklab, ${accent} 55%, white))` }}
          />
          <div className="p-6">
            <div className="flex items-center gap-4">
              <Initials text={name} />
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold tracking-tight">{name}</h1>
                <p className="truncate text-sm text-muted">
                  {[card.job_title, card.organization].filter(Boolean).join(' · ')}
                </p>
              </div>
            </div>

            {card.address && <p className="mt-4 text-sm text-muted">{card.address}</p>}
            {card.note && <p className="mt-2 text-sm text-muted">{card.note}</p>}

            <div className="mt-6">
              <ContactActions card={card} />
            </div>

            <div className="mt-6 border-t border-line pt-4">
              {showQr ? (
                <div className="flex flex-col items-center gap-3 rise">
                  <QrDisplay data={url} size={200} />
                  <p className="code text-muted">{url}</p>
                  <CopyButton text={url} />
                </div>
              ) : (
                <button type="button" className="btn btn-ghost w-full" onClick={() => setShowQr(true)}>
                  Show QR code
                </button>
              )}
            </div>
          </div>
        </div>
        <p className="mt-6 text-center text-xs text-muted">Powered by QR-VCard</p>
      </div>
    </main>
  );
}

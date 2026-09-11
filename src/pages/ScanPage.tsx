import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Avatar from '../components/Avatar';
import ContactActions from '../components/ContactActions';
import CopyButton from '../components/CopyButton';
import LanguageSwitch from '../components/LanguageSwitch';
import QrDisplay from '../components/QrDisplay';
import { useI18n } from '../i18n';
import type { PublicCard } from '../lib/api';
import { displayName, fetchPublicCard, publicPhotoUrl, shortUrl } from '../lib/api';

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'failed' } | { kind: 'ready'; card: PublicCard };

export default function ScanPage() {
  const { t } = useI18n();
  const { code = '' } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    fetchPublicCard(code)
      .then((card) => {
        if (alive) setState(card ? { kind: 'ready', card } : { kind: 'missing' });
      })
      .catch(() => {
        // A network or server failure is not "not found": say so, and offer a retry.
        if (alive) setState({ kind: 'failed' });
      });
    return () => {
      alive = false;
    };
  }, [code, attempt]);

  const name = state.kind === 'ready' ? displayName(state.card) || state.card.organization || t('scan.contact') : '';
  useEffect(() => {
    document.title = name ? `${name} · QR-VCard` : 'QR-VCard';
  }, [name]);

  if (state.kind === 'loading') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg px-4 page-pad">
        <p className="text-muted">{t('common.loading')}</p>
      </main>
    );
  }

  if (state.kind !== 'ready') {
    return (
      <main className="relative flex min-h-dvh items-center justify-center bg-bg px-4 page-pad">
        <LanguageSwitch className="absolute top-4 right-4" />
        <div className="card max-w-sm p-8 text-center rise">
          <p className="font-semibold tracking-tight">{state.kind === 'missing' ? t('scan.notFoundTitle') : t('errors.NETWORK')}</p>
          <p className="mt-2 text-sm text-muted">{state.kind === 'missing' ? t('scan.notFoundBody') : t('scan.loadFailed')}</p>
          <div className="mt-4 flex justify-center gap-2">
            {state.kind === 'failed' && (
              <button type="button" className="btn btn-secondary" onClick={() => setAttempt((n) => n + 1)}>
                {t('common.retry')}
              </button>
            )}
            <Link to="/" className="btn btn-ghost">
              {t('scan.goHome')}
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const { card } = state;
  const url = shortUrl(card.code);
  const accent = card.accent_color ?? 'var(--color-accent)';
  const subtitle = [card.job_title, displayName(card) ? card.organization : null].filter(Boolean).join(' · ');

  return (
    <main className="min-h-dvh bg-bg px-4 page-pad">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-3 flex justify-end">
          <LanguageSwitch />
        </div>
        <div className="card overflow-hidden rise">
          {/* Accent band: the card's own colour, the one flourish the visitor page carries. */}
          <div className="h-20 w-full" style={{ background: `linear-gradient(120deg, ${accent}, color-mix(in oklab, ${accent} 45%, white))` }} />
          <div className="px-6 pb-6">
            <div className="-mt-10 flex items-end gap-4">
              <div className={`${card.photo_style === 'logo' ? 'rounded-2xl' : 'rounded-full'} border-4 border-surface bg-surface`}>
                <Avatar name={name} photoUrl={publicPhotoUrl(card)} accent={card.accent_color} logo={card.photo_style === 'logo'} size={88} />
              </div>
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight break-words">{name}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}

            {(card.phone || card.email || card.website || card.address) && (
              <dl className="mt-4 space-y-1.5 text-sm">
                {card.phone && <dd className="break-words">{card.phone}</dd>}
                {card.email && <dd className="break-words">{card.email}</dd>}
                {card.website && <dd className="break-words">{card.website.replace(/^https?:\/\//, '')}</dd>}
                {card.address && <dd className="whitespace-pre-line text-muted">{card.address}</dd>}
              </dl>
            )}
            {card.note && <p className="mt-4 whitespace-pre-line rounded-lg bg-fg/5 p-3 text-sm">{card.note}</p>}

            <div className="mt-6">
              <ContactActions card={card} />
            </div>

            <div className="mt-6 border-t border-line pt-4">
              {showQr ? (
                <div className="flex flex-col items-center gap-3 rise">
                  <QrDisplay code={card.code} label={url} size={200} />
                  <p className="code text-muted">{url}</p>
                  <CopyButton text={url} />
                </div>
              ) : (
                <button type="button" className="btn btn-ghost w-full" onClick={() => setShowQr(true)}>
                  {t('qr.show')}
                </button>
              )}
            </div>
          </div>
        </div>
        <p className="mt-6 text-center text-xs text-muted">
          <Link to="/">{t('scan.poweredBy')}</Link>
        </p>
      </div>
    </main>
  );
}

import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import CardIdentity, { cardDesign } from '../components/CardIdentity';
import ContactActions from '../components/ContactActions';
import CopyButton from '../components/CopyButton';
import LanguageSwitch from '../components/LanguageSwitch';
import QrDisplay from '../components/QrDisplay';
import { useI18n } from '../i18n';
import type { PublicCard } from '../lib/api';
import { displayName, fetchPublicCard, fetchPublicUserCard, publicLogoUrl, publicPhotoUrl, shortUrl } from '../lib/api';
import type { QrStyle } from '../lib/qr';
import { qrDownloadUrl } from '../lib/qr';

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'failed' } | { kind: 'ready'; card: PublicCard };

/**
 * The public card page. Rendered for both short-URL shapes: `/c/<code>` (the
 * QR target, unique per card) and `/<username>` (the owner's primary card).
 */
export default function ScanPage({ byUsername = false }: { byUsername?: boolean }) {
  const { t } = useI18n();
  const { code = '', username = '' } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [showQr, setShowQr] = useState(false);
  const [qrStyle, setQrStyle] = useState<QrStyle>('standard');

  useEffect(() => {
    let alive = true;
    setState({ kind: 'loading' });
    const load = byUsername ? fetchPublicUserCard(username) : fetchPublicCard(code);
    load
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
  }, [byUsername, code, username, attempt]);

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
  const design = cardDesign(card);
  const contactRows = [card.phone, card.email, card.website?.replace(/^https?:\/\//, ''), card.address].filter(Boolean) as string[];

  return (
    <main
      className={`public-card-page public-card-page-${design} min-h-dvh px-4 page-pad`}
      style={{ '--card-accent': card.accent_color ?? '#2457f5' } as CSSProperties}
    >
      <div className="mx-auto w-full max-w-md">
        <div className="mb-3 flex justify-end">
          <LanguageSwitch themed className="public-language-switch" />
        </div>
        <div className="public-card-shell rise">
          <CardIdentity card={card} name={name} photoUrl={publicPhotoUrl(card)} logoUrl={publicLogoUrl(card)} />
          <div className="public-card-body px-6 pb-6 pt-5">

            {contactRows.length > 0 && (
              <dl className="contact-ledger">
                {contactRows.map((value, index) => <dd key={`${index}-${value}`} className="break-words whitespace-pre-line"><span>{String(index + 1).padStart(2, '0')}</span>{value}</dd>)}
              </dl>
            )}
            {card.note && <p className="brand-note">{card.note}</p>}

            <div className="mt-6">
              <ContactActions card={card} />
            </div>

            <div className="qr-section">
              {showQr ? (
                <div className="qr-panel rise">
                  <div className="qr-style-switch">
                    <button
                      type="button"
                      className={`qr-style-option ${qrStyle === 'standard' ? 'is-active' : ''}`}
                      onClick={() => setQrStyle('standard')}
                    >
                      {t('qr.styleStandard')}
                    </button>
                    <button
                      type="button"
                      className={`qr-style-option ${qrStyle === 'art' ? 'is-active' : ''}`}
                      onClick={() => setQrStyle('art')}
                    >
                      {t('qr.styleArt')}
                    </button>
                  </div>
                  <QrDisplay code={card.code} label={url} size={200} style={qrStyle} className="public-qr" />
                  <p className="qr-link">{url}</p>
                  <div className="qr-actions">
                    <CopyButton text={url} className="card-action card-action-secondary card-action-small" />
                    <a className="card-action card-action-secondary card-action-small" href={qrDownloadUrl(card.code, { style: qrStyle })} download={`qr-${card.code}-${qrStyle}.png`}>
                      {t('qr.download')}
                    </a>
                  </div>
                </div>
              ) : (
                <button type="button" className="qr-reveal" onClick={() => setShowQr(true)}>
                  <span aria-hidden="true">⌗</span>{t('qr.show')}<span aria-hidden="true">↗</span>
                </button>
              )}
            </div>
          </div>
        </div>
        <p className="public-card-footer">
          <Link to="/">{t('scan.poweredBy')}</Link>
        </p>
      </div>
    </main>
  );
}

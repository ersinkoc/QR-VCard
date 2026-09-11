import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { qrImageUrl } from '../lib/qr';

/**
 * The QR for a card's short link. `label` is the link it encodes (shown and read
 * out); the image itself comes from the same-origin /api/qr/<code>.
 */
export default function QrDisplay({ code, label, size = 240, className }: { code: string; label: string; size?: number; className?: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const src = `${qrImageUrl(code)}${attempt ? `?retry=${attempt}` : ''}`;

  useEffect(() => {
    setState('loading');
    setExpanded(false);
  }, [code, attempt]);

  // Enlarged view: Escape closes, Tab stays inside, the page behind cannot
  // scroll, and focus returns to the thumbnail that opened it.
  useEffect(() => {
    if (!expanded) return;
    const trigger = triggerRef.current;
    closeRef.current?.focus();

    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') {
        // Stop here: an enclosing dialog would otherwise close on the same key.
        ev.stopImmediatePropagation();
        setExpanded(false);
        return;
      }
      if (ev.key === 'Tab') {
        ev.preventDefault();
        closeRef.current?.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [expanded]);

  if (state === 'failed') {
    return (
      <div className={`flex flex-col items-center justify-center gap-2 rounded-lg border border-line p-4 text-center ${className ?? ''}`} style={{ width: size, height: size }}>
        <p className="text-sm text-danger">{t('qr.failed')}</p>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAttempt((n) => n + 1)}>
          {t('common.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className={className}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t('qr.enlarge')}
        disabled={state !== 'ready'}
        onClick={() => setExpanded(true)}
        className="relative block cursor-zoom-in rounded-lg focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
        style={{ width: size, height: size }}
      >
        {state === 'loading' && <span className="absolute inset-0 animate-pulse rounded-lg border border-line bg-surface" />}
        <img
          key={src}
          src={src}
          width={size}
          height={size}
          alt={t('qr.dialog', { url: label })}
          onLoad={() => setState('ready')}
          onError={() => setState('failed')}
          className={`block rounded-lg border border-line bg-white p-2 transition-opacity ${state === 'ready' ? 'opacity-100' : 'opacity-0'}`}
        />
      </button>

      {/* An overlay rather than the Fullscreen API: iOS Safari refuses
          requestFullscreen() on anything but a <video>. */}
      {expanded &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('qr.dialog', { url: label })}
            onClick={() => setExpanded(false)}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
          >
            <div className="flex max-h-full flex-col items-center gap-4" onClick={(ev) => ev.stopPropagation()}>
              {/* The provider renders 1000 px, so it stays sharp enlarged. */}
              <img src={src} alt="" className="max-h-[75vh] max-w-[88vw] rounded-xl border border-line bg-white p-3" />
              <p className="code max-w-[88vw] truncate text-white/90">{label}</p>
              <button ref={closeRef} type="button" className="btn btn-secondary" onClick={() => setExpanded(false)}>
                {t('common.close')}
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

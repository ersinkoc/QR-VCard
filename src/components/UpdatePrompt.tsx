import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

const UPDATE_EVENT = 'qrv:update-ready';
/** Kept here too: the update can be announced before the prompt has mounted. */
let pending: (() => void) | null = null;

/** Called by main.tsx when a new app version is installed and waiting. */
export function announceUpdate(apply: () => void) {
  pending = apply;
  window.dispatchEvent(new Event(UPDATE_EVENT));
}

/**
 * "A new version is ready — Reload". The service worker no longer reloads
 * open tabs on its own: a deploy must never throw away a half-filled card
 * form or an unsaved signature design. The person reloads when they are done.
 */
export default function UpdatePrompt() {
  const { t } = useI18n();
  const [apply, setApply] = useState<(() => void) | null>(() => pending);

  useEffect(() => {
    const onReady = () => setApply(() => pending);
    window.addEventListener(UPDATE_EVENT, onReady);
    return () => window.removeEventListener(UPDATE_EVENT, onReady);
  }, []);

  if (!apply) return null;
  return (
    <div role="status" className="fixed inset-x-4 bottom-4 z-[60] mx-auto flex max-w-md items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-card sm:inset-x-auto sm:right-4" style={{ marginBottom: 'env(safe-area-inset-bottom)' }}>
      <p className="min-w-0 flex-1 text-sm">{t('common.updateReady')}</p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setApply(null)}>
        {t('common.later')}
      </button>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => apply()}>
        {t('common.reload')}
      </button>
    </div>
  );
}

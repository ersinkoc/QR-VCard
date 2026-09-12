import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { fieldErrorTexts, useI18n } from '../../i18n';
import type { Card, Collaborator } from '../../lib/api';
import { addCardShare, listCardShares, removeCardShare, setCardShareExpiry } from '../../lib/api';

/**
 * Who a card is shared with. The card's owner (or an admin/editor) manages the
 * list; collaborators can open and edit the card but cannot delete it or
 * change who it is shared with — the server enforces this, the modal reflects it.
 */
export default function ShareModal({ card, canManage, onClose, onSaved }: {
  card: Card;
  /** Whether the viewer may change the list (owner / privileged). */
  canManage: boolean;
  onClose: () => void;
  onSaved: (card: Card) => void;
}) {
  const { t } = useI18n();
  const [people, setPeople] = useState<Collaborator[] | null>(null);
  const [email, setEmail] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldErrors = fieldErrorTexts(t, error);

  useEffect(() => {
    listCardShares(card.id)
      .then(setPeople)
      .catch((e) => {
        setError(e);
        setPeople([]);
      });
  }, [card.id]);

  async function onAdd(ev: FormEvent) {
    ev.preventDefault();
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setPeople(await addCardShare(card.id, email.trim().toLowerCase(), expiresOn || null));
      onSaved({ ...card, collaborator_count: (card.collaborator_count ?? 0) + 1 });
      setEmail('');
      setExpiresOn('');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function onExpiry(userId: string, value: string) {
    setBusy(true);
    setError(null);
    try {
      setPeople(await setCardShareExpiry(card.id, userId, value || null));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(userId: string) {
    setBusy(true);
    setError(null);
    try {
      setPeople(await removeCardShare(card.id, userId));
      onSaved({ ...card, collaborator_count: Math.max(0, (card.collaborator_count ?? 1) - 1) });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t('shares.title', { name: card.first_name || card.organization || card.code })} onClose={onClose}>
      {people === null ? (
        <p className="text-sm text-muted">{t('common.loading')}</p>
      ) : people.length === 0 ? (
        <p className="text-sm text-muted">{t('shares.empty')}</p>
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {people.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                {p.name || p.email || p.id.slice(0, 8)}
                {p.email && p.name && <span className="text-muted"> · {p.email}</span>}
                {p.expires_on && <span className="text-muted"> · {t('shares.until', { day: p.expires_on })}</span>}
              </span>
              {canManage && (
                <span className="flex shrink-0 items-center gap-1">
                  <input
                    type="date"
                    className="input w-auto px-2 py-1 text-xs"
                    aria-label={t('shares.expiryLabel')}
                    title={t('shares.expiryLabel')}
                    value={p.expires_on ?? ''}
                    onChange={(e) => void onExpiry(p.id, e.target.value)}
                  />
                  <button type="button" className="btn btn-ghost btn-sm text-danger" disabled={busy} onClick={() => void onRemove(p.id)}>
                    {t('shares.remove')}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <form onSubmit={onAdd} className="mt-4 space-y-3 border-t border-line pt-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <Field id="share-email" label={t('shares.emailLabel')} error={fieldErrors.email} hint={t('shares.emailHint')}>
              <input
                id="share-email"
                type="email"
                className="input"
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ada@example.com"
                required
              />
            </Field>
            <Field id="share-expiry" label={t('shares.expiryLabel')} error={fieldErrors.expires_on} hint={t('shares.expiryHint')}>
              <input
                id="share-expiry"
                type="date"
                className="input"
                min={new Date().toISOString().slice(0, 10)}
                value={expiresOn}
                onChange={(e) => setExpiresOn(e.target.value)}
              />
            </Field>
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={busy || !email.trim()}>
            {busy ? t('common.saving') : t('shares.add')}
          </button>
        </form>
      )}

      {error !== null && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {fieldErrors.email ?? t('errors.UNKNOWN')}
        </p>
      )}
      {!canManage && <p className="mt-4 border-t border-line pt-3 text-xs text-muted">{t('shares.readOnlyHint')}</p>}
    </Modal>
  );
}

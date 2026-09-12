import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorText, useI18n } from '../../i18n';
import type { AuditEntry } from '../../lib/api';
import { listAudit } from '../../lib/api';

/** The human sentence for an audit action, and how the badge is coloured. */
function actionInfo(t: (key: string) => string, action: string): { text: string; tone: 'danger' | 'accent' | '' } {
  switch (action) {
    case 'user.create':
      return { text: t('audit.actionUserCreate'), tone: '' };
    case 'user.update':
      return { text: t('audit.actionUserUpdate'), tone: '' };
    case 'user.delete':
      return { text: t('audit.actionUserDelete'), tone: 'danger' };
    case 'card.delete':
      return { text: t('audit.actionCardDelete'), tone: 'danger' };
    case 'password.set':
    case 'password.change':
      return { text: t('audit.actionPassword'), tone: 'accent' };
    default:
      return { text: action, tone: '' };
  }
}

export default function AuditView() {
  const { t, formatDate } = useI18n();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    document.title = `${t('audit.title')} · QR-VCard`;
  }, [t]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setEntries(await listAudit());
    } catch (e) {
      setLoadError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    if (!needle) return entries ?? [];
    return (entries ?? []).filter((e) =>
      [e.action, e.target, e.actor_email, e.detail].filter(Boolean).some((v) => String(v).toLocaleLowerCase().includes(needle)),
    );
  }, [entries, q]);

  return (
    <div>
      <div className="rise flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('audit.title')}</h1>
          <p className="mt-1 text-sm text-muted">{t('audit.subtitle')}</p>
        </div>
        <input
          type="search"
          className="input max-w-sm flex-1 sm:flex-none"
          placeholder={t('audit.searchPlaceholder')}
          aria-label={t('common.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div className="mt-6">
        {loadError !== null ? (
          <div className="card p-6 text-center">
            <p className="text-sm text-danger">{errorText(t, loadError)}</p>
            <button type="button" className="btn btn-secondary mt-3" onClick={() => void load()}>
              {t('common.retry')}
            </button>
          </div>
        ) : entries === null ? (
          <p className="text-muted">{t('common.loading')}</p>
        ) : visible.length === 0 ? (
          <div className="card p-10 text-center text-sm text-muted">{entries.length === 0 ? t('audit.empty') : t('cards.emptyFiltered')}</div>
        ) : (
          <ul className="card rise divide-y divide-[var(--color-line)]">
            {visible.map((e) => {
              const info = actionInfo(t, e.action);
              return (
                <li key={e.id} className="flex flex-col gap-1 p-4 sm:flex-row sm:items-start sm:gap-4">
                  <p className="w-44 shrink-0 text-xs text-muted tabular-nums">{e.date_created ? formatDate(e.date_created) : '—'}</p>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{e.actor_email ?? t('audit.unknownActor')}</span>
                      <span className="text-muted">→</span>
                      <span className={`badge ${info.tone === 'danger' ? 'badge-danger' : info.tone === 'accent' ? 'badge-accent' : ''}`}>{info.text}</span>
                      <span className="truncate font-mono text-xs text-muted">{e.target ?? '—'}</span>
                    </p>
                    {e.detail && <p className="mt-0.5 break-words text-sm text-muted">{e.detail}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

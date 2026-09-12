import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Avatar from '../../components/Avatar';
import CopyButton from '../../components/CopyButton';
import Modal from '../../components/Modal';
import { errorText, useI18n } from '../../i18n';
import type { Card, ViewTrend } from '../../lib/api';
import { cardPhotoUrl, deleteCard, displayName, fetchViewTrend, isPrivileged, listCards, shortUrl, updateCard } from '../../lib/api';
import CardForm from './CardForm';
import QrModal from './QrModal';
import ShareModal from './ShareModal';
import TrendChart from './TrendChart';
import { useSession } from './session';

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
    </div>
  );
}

export default function CardsView() {
  const { me } = useSession();
  const { t } = useI18n();
  const privileged = isPrivileged(me);
  const [params, setParams] = useSearchParams();
  const ownerFilter = params.get('owner') ?? '';

  const [cards, setCards] = useState<Card[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<'new' | Card | null>(null);
  const [qrCard, setQrCard] = useState<Card | null>(null);
  const [deleting, setDeleting] = useState<Card | null>(null);
  const [sharing, setSharing] = useState<Card | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [trend, setTrend] = useState<ViewTrend | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = `${privileged ? t('cards.titleAll') : t('cards.titleOwn')} · QR-VCard`;
  }, [privileged, t]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setCards(await listCards());
    } catch (e) {
      setLoadError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The 30-day scan trend (admins and editors only). A failed or unsupported
  // series is never an error surface — the gauge just stays hidden.
  useEffect(() => {
    if (!privileged || cards === null || cards.length === 0) return;
    let alive = true;
    fetchViewTrend(30)
      .then((t) => {
        if (alive) setTrend(t);
      })
      .catch(() => {
        if (alive) setTrend(null);
      });
    return () => {
      alive = false;
    };
  }, [privileged, cards === null, cards?.length]);

  useEffect(() => {
    if (editing) formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [editing]);

  const upsert = (card: Card) => setCards((list) => (list ? (list.some((c) => c.id === card.id) ? list.map((c) => (c.id === card.id ? card : c)) : [card, ...list]) : [card]));

  const owners = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of cards ?? []) if (c.owner) map.set(c.owner.id, c.owner.name ? `${c.owner.name} · ${c.owner.email ?? ''}` : (c.owner.email ?? c.owner.id));
    return [...map].sort((a, b) => a[1].localeCompare(b[1]));
  }, [cards]);

  const visible = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return (cards ?? []).filter((c) => {
      if (ownerFilter && c.owner?.id !== ownerFilter) return false;
      if (!needle) return true;
      return [c.first_name, c.last_name, c.organization, c.job_title, c.code, c.email, c.phone, c.owner?.email, c.owner?.name]
        .filter(Boolean)
        .some((v) => String(v).toLocaleLowerCase().includes(needle));
    });
  }, [cards, q, ownerFilter]);

  const scoped = (cards ?? []).filter((c) => !ownerFilter || c.owner?.id === ownerFilter);
  const published = scoped.filter((c) => c.status === 'published').length;

  async function togglePublish(card: Card) {
    setBusyId(card.id);
    setActionError(null);
    try {
      const next = card.status === 'published' ? 'draft' : 'published';
      upsert(await updateCard(card.id, { status: next }));
      setNotice(next === 'published' ? t('cards.publishedNotice') : t('cards.unpublishedNotice'));
    } catch (e) {
      setActionError(e);
    } finally {
      setBusyId(null);
    }
  }

  async function togglePrimary(card: Card) {
    if (card.is_primary) return;
    setBusyId(card.id);
    setActionError(null);
    try {
      upsert(await updateCard(card.id, { is_primary: true }));
      setCards((list) => list?.map((c) => (c.owner === card.owner && c.id !== card.id ? { ...c, is_primary: false } : c)) ?? null);
      setNotice(t('cards.primaryNotice'));
    } catch (e) {
      setActionError(e);
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete(card: Card) {
    setBusyId(card.id);
    setActionError(null);
    try {
      await deleteCard(card.id);
      setCards((list) => list?.filter((c) => c.id !== card.id) ?? null);
      setNotice(t('cards.deleted'));
      setDeleting(null);
    } catch (e) {
      setActionError(e);
      setDeleting(null);
    } finally {
      setBusyId(null);
    }
  }

  /** Only the owner (or a privileged actor) may change a card's share list. */
  const canShare = (card: Card) => privileged || card.owner?.id === me.id;

  const ownerText = (card: Card) => {
    if (!card.owner) return t('cards.unowned');
    if (card.owner.id === me.id) return t('common.you');
    return card.owner.name || card.owner.email || card.owner.id.slice(0, 8);
  };

  return (
    <div>
      <div className="rise flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{privileged ? t('cards.titleAll') : t('cards.titleOwn')}</h1>
          <p className="mt-1 text-sm text-muted">{privileged ? t('cards.subtitleAll') : t('cards.subtitleOwn')}</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setNotice(null);
            setEditing('new');
          }}
        >
          + {t('cards.new')}
        </button>
      </div>

      {cards && cards.length > 0 && (
        <div className="rise rise-2 mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t('cards.statTotal')} value={scoped.length} />
          <Stat label={t('cards.statPublished')} value={published} />
          <Stat label={t('cards.statDraft')} value={scoped.length - published} />
          <Stat label={t('cards.statViews')} value={scoped.reduce((sum, c) => sum + (c.qrv_views || 0), 0)} />
        </div>
      )}

      {privileged && trend && trend.series.length > 0 && (
        <div className="rise mt-3">
          <TrendChart points={trend.series} total={trend.total} />
        </div>
      )}

      {editing && (
        <div ref={formRef} className="mt-6 scroll-mt-24">
          <CardForm
            key={editing === 'new' ? 'new' : editing.id}
            initial={editing === 'new' ? null : editing}
            onCancel={() => setEditing(null)}
            onSaved={(card, warning) => {
              upsert(card);
              setEditing(null);
              setNotice(warning ? t('cards.photoWarning', { reason: errorText(t, warning) }) : t('cards.saved'));
            }}
          />
        </div>
      )}

      {notice && (
        <p role="status" className="mt-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      {actionError !== null && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {errorText(t, actionError)}
        </p>
      )}

      {cards && cards.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2">
          <input
            type="search"
            className="input max-w-sm flex-1"
            placeholder={t('cards.searchPlaceholder')}
            aria-label={t('common.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {privileged && owners.length > 1 && (
            <select
              className="input w-auto max-w-xs"
              aria-label={t('cards.ownerFilter')}
              value={ownerFilter}
              onChange={(e) => setParams(e.target.value ? { owner: e.target.value } : {})}
            >
              <option value="">{t('cards.allOwners')}</option>
              {owners.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          )}
          {ownerFilter && (
            <button type="button" className="btn btn-ghost" onClick={() => setParams({})}>
              {t('cards.clearFilter')}
            </button>
          )}
        </div>
      )}

      <div className="mt-4">
        {loadError !== null ? (
          <div className="card p-6 text-center">
            <p className="text-sm text-danger">{errorText(t, loadError)}</p>
            <button type="button" className="btn btn-secondary mt-3" onClick={() => void load()}>
              {t('common.retry')}
            </button>
          </div>
        ) : cards === null ? (
          <p className="text-muted">{t('common.loading')}</p>
        ) : visible.length === 0 ? (
          <div className="card p-10 text-center text-sm text-muted">{cards.length === 0 ? t('cards.empty') : t('cards.emptyFiltered')}</div>
        ) : (
          <ul className="card rise divide-y divide-[var(--color-line)]">
            {visible.map((card) => {
              const name = displayName(card) || card.organization || card.code;
              const url = shortUrl(card.code);
              const busy = busyId === card.id;
              return (
                <li key={card.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar name={name} photoUrl={cardPhotoUrl(card)} accent={card.accent_color} logo={card.photo_style === 'logo'} size={44} />
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-medium tracking-tight">
                        <span className="truncate">{name}</span>
                        <span className={`badge ${card.status === 'published' ? 'badge-success' : ''}`}>{card.status === 'published' ? t('cards.published') : t('cards.draft')}</span>
                      </p>                      <p className="truncate text-sm text-muted">{[card.job_title, displayName(card) ? card.organization : null].filter(Boolean).join(' · ') || ' '}</p>
                      <p className="code truncate text-xs text-muted">
                        {url.replace(/^https?:\/\//, '')}
                        {card.is_primary && <span className="font-sans"> · {t('cards.primary')}</span>}
                        {(card.collaborator_count ?? 0) > 0 && (
                          <button type="button" className="font-sans underline decoration-dotted underline-offset-2" title={t('shares.titleHint')} onClick={() => setSharing(card)}>
                             · {t('cards.sharedWith', { count: card.collaborator_count ?? 0 })}
                          </button>
                        )}
                        <span className="font-sans"> · {t('cards.views', { count: card.qrv_views || 0 })}</span>
                        {privileged && <span className="font-sans"> · {t('cards.owner', { name: ownerText(card) })}</span>}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setQrCard(card)}>
                      {t('cards.qr')}
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSharing(card)}>
                      {t('cards.share')}
                    </button>
                    <CopyButton text={url} label={t('common.copyUrl')} className="btn btn-secondary btn-sm" />
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void togglePublish(card)}>
                      {card.status === 'published' ? t('cards.unpublish') : t('cards.publish')}
                    </button>
                    {card.status === 'published' && (
                      <a className="btn btn-ghost btn-sm" href={`/c/${encodeURIComponent(card.code)}`} target="_blank" rel="noreferrer">
                        {t('cards.view')}
                      </a>
                    )}
                    {!card.is_primary && (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} title={t('cards.primaryHint')} onClick={() => void togglePrimary(card)}>
                        {t('cards.makePrimary')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setNotice(null);
                        setEditing(card);
                      }}
                    >
                      {t('common.edit')}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm text-danger" disabled={busy} onClick={() => setDeleting(card)}>
                      {t('common.delete')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {qrCard && <QrModal card={qrCard} onClose={() => setQrCard(null)} />}

      {sharing && <ShareModal card={sharing} canManage={canShare(sharing)} onClose={() => setSharing(null)} onSaved={upsert} />}

      {deleting && (
        <Modal
          title={t('cards.deleteTitle')}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setDeleting(null)}>
                {t('common.cancel')}
              </button>
              <button type="button" className="btn btn-danger" disabled={busyId === deleting.id} onClick={() => void confirmDelete(deleting)}>
                {busyId === deleting.id ? t('common.deleting') : t('common.delete')}
              </button>
            </>
          }
        >
          <p className="text-sm">{t('cards.deleteBody', { name: displayName(deleting) || deleting.organization || deleting.code })}</p>
        </Modal>
      )}
    </div>
  );
}

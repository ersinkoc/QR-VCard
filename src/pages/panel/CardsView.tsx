import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Avatar from '../../components/Avatar';
import Icon from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import Menu from '../../components/Menu';
import Modal from '../../components/Modal';
import { errorText, useI18n } from '../../i18n';
import type { Card, ViewTrend } from '../../lib/api';
import { cardPhotoUrl, deleteCard, displayName, fetchViewTrend, isPrivileged, listCards, shortUrl, updateCard } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import CardForm from './CardForm';
import QrModal from './QrModal';
import ShareModal from './ShareModal';
import SignatureModal from './SignatureModal';
import TrendChart from './TrendChart';
import { useSession } from './session';

function Stat({ label, value, icon, tone = 'muted' }: { label: string; value: number; icon: IconName; tone?: 'accent' | 'success' | 'muted' }) {
  const toneClass = tone === 'accent' ? 'bg-accent/10 text-accent' : tone === 'success' ? 'bg-success/10 text-success' : 'bg-fg/6 text-muted';
  return (
    <div className="card flex items-center gap-3 px-4 py-3.5">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${toneClass}`}>
        <Icon name={icon} size={20} />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-muted">{label}</p>
        <p className="text-xl leading-tight font-semibold tracking-tight tabular-nums">{value.toLocaleString()}</p>
      </div>
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
  const [signatureCard, setSignatureCard] = useState<Card | null>(null);
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
          <Icon name="plus" />
          {t('cards.new')}
        </button>
      </div>

      {cards && cards.length > 0 && (
        <div className="rise rise-2 mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon="cards" tone="accent" label={t('cards.statTotal')} value={scoped.length} />
          <Stat icon="send" tone="success" label={t('cards.statPublished')} value={published} />
          <Stat icon="draft" label={t('cards.statDraft')} value={scoped.length - published} />
          <Stat icon="eye" tone="accent" label={t('cards.statViews')} value={scoped.reduce((sum, c) => sum + (c.qrv_views || 0), 0)} />
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
              setNotice(warning ? t('cards.assetWarning', { reason: errorText(t, warning) }) : t('cards.saved'));
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
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <input
            type="search"
            className="input sm:max-w-sm sm:flex-1"
            placeholder={t('cards.searchPlaceholder')}
            aria-label={t('common.search')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {privileged && owners.length > 1 && (
            <select
              className="input sm:w-auto sm:max-w-xs"
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
                <li key={card.id} className="flex flex-col gap-3 p-4 transition-colors hover:bg-fg/[0.02] md:flex-row md:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3.5">
                    <Avatar name={name} photoUrl={cardPhotoUrl(card)} accent={card.accent_color} logo={card.photo_style === 'logo'} size={48} />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold tracking-tight">
                        <span className="break-words">{name}</span>
                        <span className={`badge ${card.status === 'published' ? 'badge-success' : ''}`}>{card.status === 'published' ? t('cards.published') : t('cards.draft')}</span>
                        {card.is_primary && (
                          <span className="badge badge-accent" title={t('cards.primaryHint')}>
                            <Icon name="star" size={11} className="mr-1" />
                            {t('cards.primary')}
                          </span>
                        )}
                      </p>
                      {(card.job_title || (displayName(card) && card.organization)) && (
                        <p className="text-sm text-muted">{[card.job_title, displayName(card) ? card.organization : null].filter(Boolean).join(' · ')}</p>
                      )}
                      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                        <span className="code text-xs">{url.replace(/^https?:\/\//, '')}</span>
                        <span className="inline-flex items-center gap-1">
                          <Icon name="eye" size={13} />
                          {t('cards.views', { count: card.qrv_views || 0 })}
                        </span>
                        {(card.collaborator_count ?? 0) > 0 && (
                          <button type="button" className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2" title={t('shares.titleHint')} onClick={() => setSharing(card)}>
                            <Icon name="users" size={13} />
                            {t('cards.sharedWith', { count: card.collaborator_count ?? 0 })}
                          </button>
                        )}
                        {privileged && (
                          <span className="inline-flex items-center gap-1">
                            <Icon name="user" size={13} />
                            {t('cards.owner', { name: ownerText(card) })}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 md:justify-end">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setNotice(null);
                        setEditing(card);
                      }}
                    >
                      <Icon name="edit" size={16} />
                      {t('common.edit')}
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setQrCard(card)}>
                      <Icon name="qr" size={16} />
                      {t('cards.qr')}
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSharing(card)}>
                      <Icon name="share" size={16} />
                      {t('cards.share')}
                    </button>
                    <button type="button" className={`btn btn-sm ${card.status === 'published' ? 'btn-ghost' : 'btn-primary'}`} disabled={busy} onClick={() => void togglePublish(card)}>
                      {card.status === 'published' ? t('cards.unpublish') : t('cards.publish')}
                    </button>
                    <Menu
                      label={t('cards.moreActions')}
                      items={[
                        { label: t('cards.signature'), icon: 'signature', onSelect: () => setSignatureCard(card) },
                        {
                          label: t('common.copyUrl'),
                          icon: 'link',
                          onSelect: () => {
                            void copyText(url).then(() => setNotice(t('cards.urlCopied')));
                          },
                        },
                        card.status === 'published' && { label: t('cards.view'), icon: 'external', onSelect: () => window.open(`/c/${encodeURIComponent(card.code)}`, '_blank', 'noopener') },
                        !card.is_primary && { label: t('cards.makePrimary'), icon: 'star', hint: t('cards.primaryHint'), disabled: busy, onSelect: () => void togglePrimary(card) },
                        { label: t('common.delete'), icon: 'trash', danger: true, disabled: busy, onSelect: () => setDeleting(card) },
                      ]}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {qrCard && <QrModal card={qrCard} onClose={() => setQrCard(null)} />}

      {sharing && <ShareModal card={sharing} canManage={canShare(sharing)} onClose={() => setSharing(null)} onSaved={upsert} />}

      {signatureCard && <SignatureModal card={signatureCard} onClose={() => setSignatureCard(null)} onSaved={(saved) => { upsert(saved); setSignatureCard(saved); }} />}

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

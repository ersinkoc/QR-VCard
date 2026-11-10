import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useSaveContact } from '../../hooks/useSaveContact';
import { useI18n } from '../../i18n';
import type { PublicCard } from '../../lib/api';
import { displayName, shortUrl } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import type { Background, Block, ContactField, PageDesign, ThemeMode } from '../../lib/page-design';
import { backgroundLayers, designVars, paletteFor } from '../../lib/page-design';
import type { QrStyle } from '../../lib/qr';
import { qrDownloadUrl, qrImageUrl } from '../../lib/qr';
import LanguageSwitch from '../LanguageSwitch';
import PageIcon from './PageIcon';
import type { PageIconName } from './PageIcon';

export interface PageAssets {
  photo: string | null;
  logo: string | null;
  background: string | null;
}

const THEME_KEY = 'qrv.page-theme';

/** The colour mode a visitor sees: their own toggle choice, else the design's (auto = OS). */
function useThemeMode(design: PageDesign, forced: ThemeMode | undefined): [ThemeMode, () => void] {
  const systemDark = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const initial = (): ThemeMode => {
    if (design.theme.toggle) {
      try {
        const saved = localStorage.getItem(THEME_KEY);
        if (saved === 'light' || saved === 'dark') return saved;
      } catch {
        /* storage blocked: design default below */
      }
    }
    if (design.theme.mode === 'auto') return systemDark() ? 'dark' : 'light';
    return design.theme.mode;
  };
  const [mode, setMode] = useState<ThemeMode>(initial);

  useEffect(() => {
    setMode(initial());
    if (design.theme.mode !== 'auto' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setMode(initial());
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
    // `initial` reads only the two inputs listed here.
  }, [design.theme.mode, design.theme.toggle]);

  const toggle = useCallback(() => {
    setMode((m) => {
      const next = m === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* the choice just won't persist */
      }
      return next;
    });
  }, []);
  return [forced ?? mode, toggle];
}

interface ContactRow {
  field: ContactField;
  icon: PageIconName;
  value: string;
  href: string;
  external: boolean;
}

const strip = (url: string) => url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/+$/, '');

function contactRows(card: PublicCard, fields: ContactField[]): ContactRow[] {
  const rows: ContactRow[] = [];
  for (const field of fields) {
    switch (field) {
      case 'phone':
        if (card.phone) rows.push({ field, icon: 'phone', value: card.phone, href: `tel:${card.phone.replace(/[^\d+]/g, '')}`, external: false });
        break;
      case 'whatsapp': {
        const wa = card.whatsapp ?? (card.phone ? `https://wa.me/${card.phone.replace(/\D/g, '')}` : null);
        if (wa) rows.push({ field, icon: 'whatsapp', value: strip(wa), href: wa, external: true });
        break;
      }
      case 'email':
        if (card.email) rows.push({ field, icon: 'email', value: card.email, href: `mailto:${card.email}`, external: false });
        break;
      case 'website':
        if (card.website) rows.push({ field, icon: 'website', value: strip(card.website), href: card.website, external: true });
        break;
      case 'linkedin':
        if (card.linkedin) rows.push({ field, icon: 'linkedin', value: strip(card.linkedin), href: card.linkedin, external: true });
        break;
      case 'instagram':
        if (card.instagram) rows.push({ field, icon: 'instagram', value: `@${strip(card.instagram).replace(/^instagram\.com\//i, '')}`, href: card.instagram, external: true });
        break;
      case 'telegram':
        if (card.telegram) rows.push({ field, icon: 'telegram', value: `@${strip(card.telegram).replace(/^t\.me\//i, '')}`, href: card.telegram, external: true });
        break;
      case 'address':
        if (card.address) rows.push({ field, icon: 'address', value: card.address, href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(card.address)}`, external: true });
        break;
      default:
        break;
    }
  }
  return rows;
}

/** A background: the base layer, then the pattern, then the veil. Purely decorative. */
function BackgroundLayer({ bg, design, mode, imageUrl, className }: { bg: Background; design: PageDesign; mode: ThemeMode; imageUrl: string | null; className: string }) {
  const { base, veil, pattern } = backgroundLayers(bg, paletteFor(design, mode), imageUrl);
  if (!base && !veil) return null;
  return (
    <div className={className} aria-hidden="true">
      {base && <div className={`pc-bg-base ${pattern ? `pc-pattern pc-pattern-${pattern}` : ''}`} style={base} />}
      {veil && <div className="pc-bg-veil" style={veil} />}
    </div>
  );
}

function Initials({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toLocaleUpperCase();
  return <span className="pc-avatar pc-avatar-initials">{initials}</span>;
}

/**
 * A card page built from a page-designer document. The public page and the
 * editor's live preview both render this, so what the owner sees is what a
 * visitor gets. `preview` keeps it inside its frame (no storage, no window
 * scroll) and `forcedMode` lets the editor show either colour scheme.
 */
export default function PageCard({
  card,
  design,
  assets,
  preview = false,
  forcedMode,
  footerLink,
}: {
  card: PublicCard;
  design: PageDesign;
  assets: PageAssets;
  preview?: boolean;
  forcedMode?: ThemeMode;
  /** Rendered after the last block (the public page's "made with" link). */
  footerLink?: ReactNode;
}) {
  const { t } = useI18n();
  const [mode, toggleMode] = useThemeMode(design, forcedMode);
  const name = displayName(card) || card.organization || t('scan.contact');
  const { save, busy } = useSaveContact(card, name);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrStyle, setQrStyle] = useState<QrStyle>('standard');
  const [dockVisible, setDockVisible] = useState(preview);
  const url = card.code ? shortUrl(card.code) : '';
  const vars = useMemo(() => designVars(design, mode), [design, mode]);

  const say = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // The public page owns the whole window: overscroll and any space below
  // the card show the card's background, not the app's.
  const pageBg = paletteFor(design, mode).bg;
  useEffect(() => {
    if (preview) return;
    const root = document.documentElement;
    const previous = root.style.backgroundColor;
    root.style.backgroundColor = pageBg;
    document.body.style.backgroundColor = pageBg;
    return () => {
      root.style.backgroundColor = previous;
      document.body.style.backgroundColor = '';
    };
  }, [preview, pageBg]);

  // The dock slides in once the hero's own buttons have scrolled away.
  useEffect(() => {
    if (preview || !design.dock) return;
    const update = () => setDockVisible(document.documentElement.scrollHeight <= window.innerHeight + 120 || window.scrollY > 220);
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [preview, design.dock]);

  const tel = card.phone?.replace(/[^\d+]/g, '') ?? null;
  const wa = card.whatsapp ?? (card.phone ? `https://wa.me/${card.phone.replace(/\D/g, '')}` : null);

  async function onSave() {
    if (preview) return say(t('page.previewOnly'));
    say(t('page.downloading'));
    await save();
  }

  async function onShare() {
    if (preview) return say(t('page.previewOnly'));
    const shareUrl = window.location.href;
    if (typeof navigator.share === 'function') {
      await navigator.share({ title: name, text: [name, card.job_title, card.organization].filter(Boolean).join(' · '), url: shareUrl }).catch(() => {});
      return;
    }
    say((await copyText(shareUrl)) ? t('page.linkCopied') : t('page.copyFailed'));
  }

  const blocks = design.blocks.filter((block) => !block.hidden);
  const showActions = blocks.some((block) => block.type === 'hero' && block.actions);
  const heroInk = design.hero.text === 'light' ? '#ffffff' : design.hero.text === 'dark' ? '#111111' : null;

  const avatar = design.avatar.show ? (
    <div className="pc-avatar-wrap">
      {assets.photo ? <img className={`pc-avatar ${card.photo_style === 'logo' ? 'pc-avatar-logo' : ''}`} src={assets.photo} alt="" /> : <Initials name={name} />}
      {design.avatar.status && <span className="pc-status" title={t('page.online')} />}
    </div>
  ) : null;

  const subtitle = card.job_title;
  const org = card.organization && card.organization !== name ? card.organization : null;

  function heroActions(): ReactNode {
    return (
      <div className="pc-actions">
        <button type="button" className="pc-btn pc-btn-primary" onClick={() => void onSave()} disabled={busy}>
          <PageIcon name="download" />
          {t('page.save')}
        </button>
        <button type="button" className="pc-btn pc-btn-ghost" onClick={() => void onShare()}>
          <PageIcon name="share" />
          {t('scan.share')}
        </button>
      </div>
    );
  }

  function renderBlock(block: Block): ReactNode {
    switch (block.type) {
      case 'header':
        return (
          <header key={block.id} className="pc-header pc-rise">
            {assets.logo ? <img className="pc-logo" src={assets.logo} alt={card.organization ?? ''} /> : <span className="pc-brand">{card.organization || name}</span>}
            {block.tag && <span className="pc-tag">{block.tag}</span>}
          </header>
        );
      case 'hero': {
        const { layout, framed, height, background } = design.hero;
        const style = heroInk ? ({ '--pc-hero-ink': heroInk } as CSSProperties) : undefined;
        const copy = (
          <div className="pc-hero-copy">
            <h1 className="pc-name">{name}</h1>
            {subtitle && <p className="pc-role">{subtitle}</p>}
            {org && <p className="pc-org">{org}</p>}
          </div>
        );
        const bg = <BackgroundLayer bg={background} design={design} mode={mode} imageUrl={assets.background} className="pc-hero-bg" />;
        if (layout === 'banner') {
          return (
            <section key={block.id} className={`pc-hero pc-hero-banner ${framed ? 'pc-framed' : ''} pc-rise`}>
              <div className={`pc-banner pc-banner-${height}`} style={style}>{bg}</div>
              <div className="pc-hero-body">
                {avatar}
                {copy}
                {block.actions && heroActions()}
              </div>
            </section>
          );
        }
        return (
          <section key={block.id} className={`pc-hero pc-hero-${layout} pc-hero-h-${height} ${framed ? 'pc-framed' : ''} ${heroInk ? 'pc-hero-inked' : ''} pc-rise`} style={style}>
            {bg}
            <div className="pc-hero-inner">
              {avatar}
              {copy}
            </div>
            {block.actions && heroActions()}
          </section>
        );
      }
      case 'contacts': {
        const rows = contactRows(card, block.fields);
        if (!rows.length) return null;
        return (
          <section key={block.id} className={`pc-contacts pc-contacts-${block.style} pc-rise`} aria-label={block.title || t('page.contactsTitle')}>
            <p className="pc-label">{block.title || t('page.contactsTitle')}</p>
            <div className="pc-contact-list">
              {rows.map((row) => (
                <a
                  key={row.field}
                  className="pc-contact"
                  href={row.href}
                  {...(row.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  <span className="pc-contact-icon"><PageIcon name={row.icon} /></span>
                  <span className="pc-contact-label">{t(`page.fields.${row.field}`)}</span>
                  <span className="pc-contact-value">{row.value}</span>
                  <span className="pc-contact-arrow" aria-hidden="true">↗</span>
                </a>
              ))}
            </div>
          </section>
        );
      }
      case 'note':
        if (!card.note) return null;
        return (
          <section key={block.id} className="pc-panel pc-rise">
            <p className="pc-label">{block.title || t('page.noteTitle')}</p>
            <p className="pc-body">{card.note}</p>
          </section>
        );
      case 'text':
        if (!block.title && !block.body) return null;
        return (
          <section key={block.id} className="pc-panel pc-rise">
            {block.title && <h2 className="pc-panel-title">{block.title}</h2>}
            {block.body && <p className="pc-body">{block.body}</p>}
          </section>
        );
      case 'link': {
        // Stored values are https already; the editor preview shows unsaved
        // input, so a bare host gets https:// and anything else renders nothing.
        const href = /^https:\/\//i.test(block.url) ? block.url : /^[a-z][a-z0-9+.-]*:/i.test(block.url) || !block.url ? null : `https://${block.url}`;
        if (!href) return null;
        return (
          <a key={block.id} className="pc-link pc-rise" href={href} target="_blank" rel="noopener noreferrer">
            <span className="pc-contact-icon"><PageIcon name="link" /></span>
            <span className="pc-link-label">{block.label || strip(block.url)}</span>
            <span className="pc-contact-arrow" aria-hidden="true">↗</span>
          </a>
        );
      }
      case 'qr':
        return (
          <button key={block.id} type="button" className="pc-qr-card pc-rise" aria-haspopup="dialog" onClick={() => setQrOpen(true)}>
            <span className="pc-qr-box" aria-hidden="true">{card.code ? <img src={qrImageUrl(card.code)} alt="" /> : <PageIcon name="qr" />}</span>
            <span className="pc-qr-text">
              <span className="pc-qr-title">{block.title || t('page.qrTitle')}</span>
              <span className="pc-qr-body">{block.body || t('page.qrBody')}</span>
              <span className="pc-qr-hint"><PageIcon name="zoom" />{t('page.qrHint')}</span>
            </span>
          </button>
        );
      case 'divider':
        return <hr key={block.id} className="pc-divider" />;
      case 'footer':
        return (
          <footer key={block.id} className="pc-footer">
            {block.text || `© ${new Date().getFullYear()} ${card.organization || name}`}
          </footer>
        );
      default:
        return null;
    }
  }

  return (
    <div
      className={`pc pc-${mode} pc-align-${design.theme.align} pc-surface-${design.theme.surface} ${design.avatar.ring ? 'pc-ring' : ''} ${preview ? 'pc-preview' : ''} ${design.dock ? 'pc-has-dock' : ''}`}
      style={vars}
      data-theme={mode}
    >
      <BackgroundLayer bg={design.page.background} design={design} mode={mode} imageUrl={assets.background} className="pc-page-bg" />

      <div className="pc-topbar">
        <LanguageSwitch themed className="pc-language" />
        {design.theme.toggle && (
          <button type="button" className="pc-round" aria-label={t('page.themeToggle')} onClick={forcedMode ? undefined : toggleMode} disabled={!!forcedMode}>
            <PageIcon name={mode === 'dark' ? 'sun' : 'moon'} />
          </button>
        )}
      </div>

      <div className="pc-page">
        {blocks.map(renderBlock)}
        {footerLink}
      </div>

      {design.dock && (
        <nav className={`pc-dock ${dockVisible || !showActions ? 'is-visible' : ''}`} aria-label={t('page.dock')}>
          {tel && (
            <a className="pc-dock-item" href={tel ? `tel:${tel}` : undefined}>
              <PageIcon name="phone" />
              {t('scan.call')}
            </a>
          )}
          {wa && (
            <a className="pc-dock-item" href={wa} target="_blank" rel="noopener noreferrer">
              <PageIcon name="whatsapp" />
              {t('scan.whatsapp')}
            </a>
          )}
          {card.email && (
            <a className="pc-dock-item" href={`mailto:${card.email}`}>
              <PageIcon name="email" />
              {t('scan.email')}
            </a>
          )}
          {(tel || wa || card.email) && <span className="pc-dock-sep" aria-hidden="true" />}
          <button type="button" className="pc-dock-item" onClick={() => setQrOpen(true)}>
            <PageIcon name="qr" />
            QR
          </button>
          <button type="button" className="pc-dock-item" onClick={() => void onSave()} disabled={busy}>
            <PageIcon name="download" />
            {t('page.dockSave')}
          </button>
        </nav>
      )}

      {qrOpen && (
        <QrDialog
          code={card.code}
          url={url}
          style={qrStyle}
          onStyle={setQrStyle}
          title={blocks.find((block): block is Extract<Block, { type: 'qr' }> => block.type === 'qr')?.title || t('page.qrTitle')}
          body={blocks.find((block): block is Extract<Block, { type: 'qr' }> => block.type === 'qr')?.body || t('page.qrBody')}
          onClose={() => setQrOpen(false)}
          onCopied={(ok) => say(ok ? t('page.linkCopied') : t('page.copyFailed'))}
        />
      )}

      <div className={`pc-toast ${toast ? 'is-shown' : ''}`} role="status" aria-live="polite">
        {toast}
      </div>
    </div>
  );
}

function QrDialog({
  code,
  url,
  style,
  onStyle,
  title,
  body,
  onClose,
  onCopied,
}: {
  code: string;
  url: string;
  style: QrStyle;
  onStyle: (style: QrStyle) => void;
  title: string;
  body: string;
  onClose: () => void;
  onCopied: (ok: boolean) => void;
}) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    function onKeyDown(ev: KeyboardEvent) {
      if (ev.key === 'Escape') onCloseRef.current();
      if (ev.key === 'Tab' && panelRef.current) {
        const items = [...panelRef.current.querySelectorAll<HTMLElement>('button, a[href]')];
        const first = items[0];
        const last = items[items.length - 1];
        if (ev.shiftKey && document.activeElement === first) {
          ev.preventDefault();
          last?.focus();
        } else if (!ev.shiftKey && document.activeElement === last) {
          ev.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div className="pc-modal" role="dialog" aria-modal="true" aria-labelledby="pc-qr-title">
      <div className="pc-modal-backdrop" onClick={onClose} />
      <div className="pc-modal-panel" ref={panelRef}>
        <button ref={closeRef} type="button" className="pc-modal-close" aria-label={t('page.close')} onClick={onClose}>
          <PageIcon name="close" />
        </button>
        <div className="pc-qr-large">{code ? <img src={qrImageUrl(code, { style })} alt={url} /> : <PageIcon name="qr" />}</div>
        <h2 id="pc-qr-title" className="pc-modal-title">{title}</h2>
        <p className="pc-modal-body">{body}</p>
        {code && (
          <>
            <div className="pc-segment" role="group" aria-label={t('qr.styleStandard')}>
              {(['standard', 'art'] as const).map((s) => (
                <button key={s} type="button" aria-pressed={style === s} className={style === s ? 'is-active' : ''} onClick={() => onStyle(s)}>
                  {s === 'standard' ? t('qr.styleStandard') : t('qr.styleArt')}
                </button>
              ))}
            </div>
            <p className="pc-modal-url">{url}</p>
            <div className="pc-modal-actions">
              <button type="button" className="pc-btn pc-btn-ghost pc-btn-sm" onClick={async () => onCopied(await copyText(url))}>
                {t('common.copyLink')}
              </button>
              <a className="pc-btn pc-btn-primary pc-btn-sm" href={qrDownloadUrl(code, { style })} download={`qr-${code}-${style}.png`}>
                {t('qr.download')}
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

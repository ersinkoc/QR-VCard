import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import Modal from '../../components/Modal';
import { errorText, useI18n } from '../../i18n';
import type { Card } from '../../lib/api';
import { cardLogoUrl, cardPhotoUrl, displayName, institutionLogoUrl, publicLogoUrl, publicPhotoUrl, shortUrl, updateCard } from '../../lib/api';
import { withInstitution } from '../../lib/card-view';
import { qrImageUrl } from '../../lib/qr';
import type { SignatureData, SignatureDesign, SignatureField, SignatureImage, SignatureTemplate } from '../../lib/signature';
import { checkCustomHtml, CUSTOM_HTML_MAX, CUSTOM_HTML_STARTER, GMAIL_SIGNATURE_LIMIT, layoutToCustomHtml, normalizeSignature, renderSignature, resolveSignature, SIGNATURE_TEMPLATES, SIGNATURE_TOKENS, signatureSizes, signatureText, templateSignature } from '../../lib/signature';

const FIELDS: SignatureField[] = ['phone', 'email', 'website', 'address'];
const FONTS: SignatureDesign['font'][] = ['arial', 'helvetica', 'verdana', 'tahoma', 'trebuchet', 'georgia', 'times'];
/** Wider than this, phone mail apps (iOS Mail, Gmail) shrink the signature to fit and small text gets hard to read. */
const MOBILE_WIDTH = 500;

/** Quick colours next to the card's and the organization's own. */
const SWATCHES = ['#2457f5', '#0f766e', '#dc2626', '#7c3aed', '#d97706', '#0f172a', '#db2777', '#059669'];
const SOCIAL_LABELS = { linkedin: 'LinkedIn', instagram: 'Instagram', whatsapp: 'WhatsApp', telegram: 'Telegram' } as const;
const FONT_NAMES: Record<SignatureDesign['font'], string> = { arial: 'Arial', helvetica: 'Helvetica', verdana: 'Verdana', tahoma: 'Tahoma', trebuchet: 'Trebuchet MS', georgia: 'Georgia', times: 'Times New Roman' };

/** Natural size of an image, null when it does not load (e.g. a vector logo without its PNG rendition). */
function useImageSize(src: string | null) {
  const [size, setSize] = useState<{ w: number; h: number } | null | undefined>(undefined);
  useEffect(() => {
    if (!src) {
      setSize(null);
      return;
    }
    let alive = true;
    const img = new Image();
    img.onload = () => alive && setSize(img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null);
    img.onerror = () => alive && setSize(null);
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return size;
}

/** Fits `natural` inside a `box`×`box` square (or to `height` when wide), as integers mail clients accept. */
function fit(src: string, natural: { w: number; h: number }, height: number, maxWidth: number): SignatureImage {
  let h = height;
  let w = Math.round((natural.w / natural.h) * h);
  if (w > maxWidth) {
    w = maxWidth;
    h = Math.max(1, Math.round((natural.h / natural.w) * w));
  }
  return { src, width: w, height: h };
}

const frameDoc = (html: string, dark = false) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#ffffff}body{padding:20px}${dark ? 'html{filter:invert(1) hue-rotate(180deg)}img{filter:invert(1) hue-rotate(180deg)}' : ''}</style></head><body>${html}</body></html>`;

/**
 * The signature in a sandboxed frame (no scripts; same origin, so a draft
 * card's private images still load): the panel's own CSS cannot leak in, so
 * what is shown is exactly what gets copied.
 */
const SignatureFrame = memo(function SignatureFrame({ html, title, frameRef, scale = 1, height, dark = false, onWidth }: { html: string; title: string; frameRef?: RefObject<HTMLIFrameElement | null>; scale?: number; height?: number; dark?: boolean; onWidth?: (px: number) => void }) {
  const local = useRef<HTMLIFrameElement>(null);
  const ref = frameRef ?? local;
  const [h, setH] = useState(height ?? 180);
  const measure = () => {
    const doc = ref.current?.contentDocument;
    if (doc && !height) setH(Math.max(120, doc.documentElement.scrollHeight));
    // The signature's own width (its outer table), to warn when it will not fit a phone.
    const table = doc?.body.firstElementChild as HTMLElement | null;
    if (table && onWidth) onWidth(Math.ceil(table.getBoundingClientRect().width));
  };
  const frame = (
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-same-origin"
      srcDoc={frameDoc(html, dark)}
      onLoad={measure}
      className="block w-full border-0 bg-transparent"
      style={scale === 1 ? { height: h } : { width: `${100 / scale}%`, height: h, transform: `scale(${scale})`, transformOrigin: 'top left', pointerEvents: 'none' }}
      tabIndex={scale === 1 ? undefined : -1}
    />
  );
  return scale === 1 ? frame : <div style={{ height: h * scale, overflow: 'hidden' }} aria-hidden="true">{frame}</div>;
});

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="inline-flex flex-wrap rounded-lg border border-line bg-surface p-0.5 text-xs font-medium" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} className={`h-8 rounded-md px-2.5 ${value === o.value ? 'bg-accent/10 text-accent' : 'text-muted hover:text-fg'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** A 1×1 transparent GIF: keeps each image's box in the layout pass. */
const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function SignatureModal({ card, onClose, onSaved }: { card: Card; onClose: () => void; onSaved?: (card: Card) => void }) {
  const { t, lang } = useI18n();
  const initial = useMemo(() => resolveSignature(card.signature_config) ?? templateSignature('classic', { lang }), [card.signature_config, lang]);
  const [design, setDesign] = useState<SignatureDesign>(initial);
  // A never-designed card starts from a default that is not stored yet: savable, but nothing is "unsaved".
  const [savedJson, setSavedJson] = useState(() => JSON.stringify(initial));
  const [stored, setStored] = useState(Boolean(card.signature_config));
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<'save' | 'png' | null>(null);
  const [tab, setTab] = useState<'template' | 'style' | 'content' | 'extras' | 'html'>(() => (initial.template === 'custom' ? 'html' : 'template'));
  const htmlRef = useRef<HTMLTextAreaElement>(null);
  const [convertFrom, setConvertFrom] = useState<Exclude<SignatureTemplate, 'custom'>>('classic');
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [scheme, setScheme] = useState<'light' | 'dark'>('light');
  const [sigWidth, setSigWidth] = useState(0);
  const [client, setClient] = useState<'gmail' | 'outlook' | 'apple'>('gmail');
  const previewRef = useRef<HTMLIFrameElement>(null);
  const set = <K extends keyof SignatureDesign>(key: K, value: SignatureDesign[K]) => setDesign((d) => ({ ...d, [key]: value }));

  // Two sets of image URLs. What recipients load is ALWAYS the card's public,
  // absolute URL (it starts working once the card is published). The preview
  // and the PNG use the panel's own URLs, which also load for a draft.
  const origin = window.location.origin;
  const published = card.status === 'published';
  const abs = (path: string | null) => (path ? new URL(path, origin).href : null);
  const logoTag = card.institution?.logo ?? card.logo;
  const publicPhoto = card.photo ? abs(publicPhotoUrl({ code: card.code, photo: card.photo }, 'jpg')) : null;
  // Logos as PNG: their transparency survives on coloured bands (JPEG would add a white box).
  const publicLogo = logoTag ? abs(publicLogoUrl({ code: card.code, logo: logoTag }, 'png')) : null;
  const previewPhoto = published ? publicPhoto : card.photo ? abs(`${cardPhotoUrl(card)}&format=jpg`) : null;
  const previewLogo = published ? publicLogo : logoTag ? abs(card.institution?.logo ? institutionLogoUrl(card.institution, 'png') : `${cardLogoUrl(card)}&format=png`) : null;
  // The plain QR: mail clients (and Gmail's image proxy) fetch it for every
  // reader, and a small art QR scans poorly.
  const qrSrc = abs(qrImageUrl(card.code, { style: 'standard' }));
  const photoSize = useImageSize(previewPhoto);
  const logoSize = useImageSize(previewLogo);
  const qrSize = useImageSize(qrSrc);

  const eff = withInstitution(card, card.institution);
  const person = displayName(card);
  const sz = signatureSizes(design);
  const build = (photoSrc: string | null, logoSrc: string | null): SignatureData => ({
    name: person || eff.organization || card.code,
    title: card.job_title,
    organization: person ? eff.organization : null,
    phone: eff.phone,
    email: eff.email,
    website: eff.website,
    address: card.address,
    socials: (['linkedin', 'instagram', 'whatsapp', 'telegram'] as const).filter((k) => card[k]).map((k) => ({ key: k, url: card[k]! })),
    cardUrl: shortUrl(card.code),
    accent: card.accent_color ?? '#2457f5',
    // Sizes are measured on the preview image: a draft's public URL is not served yet.
    photo: photoSrc && photoSize ? (card.photo_style === 'logo' ? fit(photoSrc, photoSize, sz.photo, sz.photo) : { src: photoSrc, width: sz.photo, height: sz.photo }) : null,
    logo: logoSrc && logoSize ? fit(logoSrc, logoSize, sz.logo, 200) : null,
    qr: qrSrc && qrSize ? { src: qrSrc, width: sz.qr, height: sz.qr } : null,
  });
  const depKey = [person, eff.organization, eff.phone, eff.email, eff.website, card.job_title, card.address, card.code, card.accent_color, card.linkedin, card.instagram, card.whatsapp, card.telegram, card.photo_style, JSON.stringify(photoSize), JSON.stringify(logoSize), JSON.stringify(qrSize), sz.photo, sz.logo, sz.qr].join('|');
  const data = useMemo(() => build(previewPhoto, previewLogo), [depKey, previewPhoto, previewLogo]);
  const exportData = useMemo(() => build(publicPhoto, publicLogo), [depKey, publicPhoto, publicLogo]);
  const html = useMemo(() => renderSignature(design, data), [design, data]);
  /** What is copied / downloaded: identical layout, public image URLs. */
  const exportHtml = useMemo(() => renderSignature(design, exportData), [design, exportData]);
  const dirty = JSON.stringify(design) !== savedJson;
  const extraUrlInvalid = design.extraUrl !== '' && normalizeSignature({ extraUrl: design.extraUrl }).errors.includes('extraUrl');
  // The renderer only links https targets; show the normalised form as soon as it is valid.
  useEffect(() => {
    if (!design.extraUrl || extraUrlInvalid || /^https:\/\//i.test(design.extraUrl)) return;
    const timer = setTimeout(() => setDesign((d) => ({ ...d, extraUrl: normalizeSignature({ extraUrl: d.extraUrl }).value.extraUrl || d.extraUrl })), 600);
    return () => clearTimeout(timer);
  }, [design.extraUrl, extraUrlInvalid]);
  const loading = photoSize === undefined || logoSize === undefined || qrSize === undefined;

  // Template thumbnails: the same card in every layout. Free texts are left
  // out, so typing a disclaimer does not reload ten frames per keystroke.
  const layoutKey = JSON.stringify({ ...design, disclaimer: '', ctaText: '' });
  const thumbs = useMemo(
    () => SIGNATURE_TEMPLATES.map((tpl) => ({ tpl, html: renderSignature({ ...templateSignature(tpl, { ...design, disclaimer: '', ctaText: '' }), customHtml: design.customHtml || CUSTOM_HTML_STARTER }, data) })),
    [layoutKey, design.customHtml, data],
  );
  const htmlProblem = design.template === 'custom' ? checkCustomHtml(design.customHtml) : null;
  const problemText = htmlProblem ? t(`signature.htmlErrors.${htmlProblem.code}`, { detail: htmlProblem.detail, max: CUSTOM_HTML_MAX }) : '';

  async function save() {
    setBusy('save');
    setStatus(null);
    try {
      if (htmlProblem) {
        setStatus({ tone: 'error', text: problemText });
        return;
      }
      const clean = normalizeSignature(design);
      if (clean.errors.length) throw new Error(clean.errors.join(', '));
      const updated = await updateCard(card.id, { signature_config: clean.value });
      setDesign(clean.value);
      setSavedJson(JSON.stringify(clean.value));
      setStored(true);
      onSaved?.(updated);
      setStatus({ tone: 'ok', text: t('signature.saved') });
    } catch (e) {
      setStatus({ tone: 'error', text: errorText(t, e) });
    } finally {
      setBusy(null);
    }
  }

  async function copyRich() {
    setStatus(null);
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([exportHtml], { type: 'text/html' }), 'text/plain': new Blob([signatureText(design, exportData)], { type: 'text/plain' }) })]);
      } else {
        await navigator.clipboard.writeText(exportHtml);
      }
      setStatus({ tone: 'ok', text: t('signature.copied') });
    } catch {
      setStatus({ tone: 'error', text: t('signature.failed') });
    }
  }

  async function copySource() {
    try {
      await navigator.clipboard.writeText(exportHtml);
      setStatus({ tone: 'ok', text: t('signature.sourceCopied') });
    } catch {
      setStatus({ tone: 'error', text: t('signature.failed') });
    }
  }

  /**
   * PNG from the very same HTML, in two passes so every engine agrees:
   *  1. the layout and text — the preview cloned into SVG <foreignObject>,
   *     with its images swapped for transparent placeholders of the same size;
   *  2. each image drawn on top at the position the preview measured,
   *     clipped to its rounded corners.
   * (WebKit drops images nested in foreignObject; drawing them directly works
   * everywhere.) A browser that taints the canvas gets a clear message.
   */
  async function downloadPng() {
    setBusy('png');
    setStatus(null);
    try {
      const doc = previewRef.current?.contentDocument;
      const root = doc?.body.firstElementChild as HTMLElement | null;
      if (!doc || !root) throw new Error('no preview');
      const PAD = 20;
      const box = root.getBoundingClientRect();
      const width = Math.ceil(box.width) + PAD * 2;
      const height = Math.ceil(box.height) + PAD * 2;
      const placed = [...root.querySelectorAll('img')].map((img) => {
        const r = img.getBoundingClientRect();
        const radius = doc.defaultView?.getComputedStyle(img).borderTopLeftRadius ?? '0px';
        return { src: img.currentSrc || img.src, x: r.left - box.left + PAD, y: r.top - box.top + PAD, w: r.width, h: r.height, radius };
      });
      const clone = root.cloneNode(true) as HTMLElement;
      for (const img of [...clone.querySelectorAll('img')]) img.setAttribute('src', TRANSPARENT_GIF);
      const xhtml = new XMLSerializer().serializeToString(clone);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="padding:${PAD}px;background:#ffffff">${xhtml}</div></foreignObject></svg>`;
      const layout = new Image();
      layout.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await layout.decode();
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas');
      ctx.scale(2, 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(layout, 0, 0);
      for (const p of placed) {
        const res = await fetch(p.src, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`image ${res.status}`);
        const bitmap = await createImageBitmap(await res.blob());
        const r = p.radius.endsWith('%') ? (Math.min(p.w, p.h) * Number.parseFloat(p.radius)) / 100 : Number.parseFloat(p.radius) || 0;
        ctx.save();
        ctx.beginPath();
        if (r > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(p.x, p.y, p.w, p.h, Math.min(r, p.w / 2, p.h / 2));
        else ctx.rect(p.x, p.y, p.w, p.h);
        ctx.clip();
        ctx.drawImage(bitmap, p.x, p.y, p.w, p.h);
        ctx.restore();
        bitmap.close();
      }
      const blob = await new Promise<Blob | null>((resolve, reject) => {
        try {
          canvas.toBlob(resolve, 'image/png');
        } catch (e) {
          reject(e);
        }
      });
      if (!blob) throw new Error('png');
      download(blob, `email-signature-${card.code}.png`);
      setStatus({ tone: 'ok', text: t('signature.ready') });
    } catch {
      setStatus({ tone: 'error', text: t('signature.pngFailed') });
    } finally {
      setBusy(null);
    }
  }

  const orderedFields = [...design.fields, ...FIELDS.filter((f) => !design.fields.includes(f))];
  function moveField(field: SignatureField, dir: -1 | 1) {
    const list = [...design.fields];
    const at = list.indexOf(field);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= list.length) return;
    [list[at], list[to]] = [list[to]!, list[at]!];
    set('fields', list);
  }

  const sectionTitle = 'mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase';
  const count = exportHtml.length;
  const availableSocials = (['linkedin', 'instagram', 'whatsapp', 'telegram'] as const).filter((k) => card[k]);
  const swatches = [...new Set([card.accent_color, card.institution?.accent_color, ...SWATCHES].filter((c): c is string => Boolean(c)).map((c) => c.toLowerCase()))].slice(0, 10);
  const currentAccent = (design.accent ?? card.accent_color ?? '#2457f5').toLowerCase();
  // Free HTML decides its own look: only the template list and the editor apply.
  const TABS: { id: typeof tab; label: string }[] =
    design.template === 'custom'
      ? [
          { id: 'template', label: t('signature.tabTemplate') },
          { id: 'html', label: t('signature.tabHtml') },
        ]
      : [
          { id: 'template', label: t('signature.tabTemplate') },
          { id: 'style', label: t('signature.tabStyle') },
          { id: 'content', label: t('signature.tabContent') },
          { id: 'extras', label: t('signature.tabExtras') },
        ];

  /** Inserts text at the editor's cursor (or replaces the selection). */
  function insertAtCursor(text: string) {
    const el = htmlRef.current;
    const value = design.customHtml;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    set('customHtml', value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = start + text.length;
    });
  }

  return (
    <Modal
      xl
      title={t('signature.title')}
      onClose={onClose}
      footer={
        <>
          {dirty && <span className="mr-auto self-center text-xs text-muted">{t('signature.unsaved')}</span>}
          <button type="button" className="btn btn-ghost" onClick={() => setDesign(templateSignature(design.template, { lang: design.lang }))} title={t('signature.resetHint')}>
            {t('signature.reset')}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.close')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy !== null || (stored && !dirty)} onClick={() => void save()}>
            {busy === 'save' ? t('common.saving') : t('signature.save')}
          </button>
        </>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[23rem_1fr]">
        <div className="min-w-0">
          <div role="tablist" aria-label={t('signature.title')} className={`mb-4 grid gap-1 rounded-lg border border-line bg-surface p-1 ${TABS.length === 2 ? 'grid-cols-2' : 'grid-cols-4'}`}>
            {TABS.map((tb) => (
              <button
                key={tb.id}
                type="button"
                role="tab"
                aria-selected={tab === tb.id}
                onClick={() => setTab(tb.id)}
                className={`h-8 rounded-md text-xs font-semibold ${tab === tb.id ? 'bg-accent/10 text-accent' : 'text-muted hover:text-fg'}`}
              >
                {tb.label}
              </button>
            ))}
          </div>

          {tab === 'template' && (
            <section role="tabpanel" aria-label={t('signature.tabTemplate')}>
              <div className="grid grid-cols-2 gap-2">
                {thumbs.map(({ tpl, html: thumb }) => (
                  <button
                    key={tpl}
                    type="button"
                    aria-pressed={design.template === tpl}
                    onClick={() => {
                      if (tpl === 'custom') {
                        setDesign((d) => ({ ...templateSignature('custom', d), customHtml: d.customHtml || CUSTOM_HTML_STARTER }));
                        setTab('html');
                      } else setDesign((d) => templateSignature(tpl as SignatureTemplate, d));
                    }}
                    className={`overflow-hidden rounded-lg border text-left transition-shadow hover:shadow-md ${design.template === tpl ? 'border-accent ring-2 ring-accent/30' : 'border-line'}`}
                  >
                    <SignatureFrame html={thumb} title={t(`signature.templates.${tpl}`)} scale={0.3} height={260} />
                    <span className="block border-t border-line px-2 py-1.5 text-xs font-medium">{t(`signature.templates.${tpl}`)}</span>
                  </button>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted">{t('signature.templateHint')}</p>
            </section>
          )}

          {tab === 'style' && (
            <section role="tabpanel" aria-label={t('signature.tabStyle')} className="space-y-4">
              <div>
                <span className="label">{t('signature.accent')}</span>
                <div className="flex flex-wrap items-center gap-2">
                  {swatches.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={c === card.institution?.accent_color?.toLowerCase() ? t('signature.accentInstitution') : c}
                      title={c === card.institution?.accent_color?.toLowerCase() ? t('signature.accentInstitution') : c === card.accent_color?.toLowerCase() ? t('signature.accentCard') : c}
                      aria-pressed={currentAccent === c}
                      onClick={() => set('accent', c === card.accent_color?.toLowerCase() ? null : c)}
                      className={`h-7 w-7 rounded-full border-2 transition-transform ${currentAccent === c ? 'scale-110 border-fg' : 'border-transparent'}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <input type="color" aria-label={t('signature.accentCustom')} value={currentAccent} onChange={(e) => set('accent', e.target.value)} className="h-7 w-9 cursor-pointer rounded border border-line bg-surface" />
                </div>
              </div>
              <div>
                <span className="label">{t('signature.nameColor')}</span>
                <Segmented label={t('signature.nameColor')} value={design.nameColor} onChange={(v) => set('nameColor', v)} options={[{ value: 'ink', label: t('signature.nameInk') }, { value: 'accent', label: t('signature.nameAccent') }]} />
              </div>
              <label className="block">
                <span className="label">{t('signature.font')}</span>
                <select className="input" value={design.font} onChange={(e) => set('font', e.target.value as SignatureDesign['font'])}>
                  {FONTS.map((f) => (
                    <option key={f} value={f} style={{ fontFamily: FONT_NAMES[f] }}>
                      {FONT_NAMES[f]}
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-muted">{t('signature.fontHint')}</span>
              </label>
              <div className="flex flex-wrap gap-x-6 gap-y-4">
                <div>
                  <span className="label">{t('signature.size')}</span>
                  <Segmented label={t('signature.size')} value={design.size} onChange={(v) => set('size', v)} options={[{ value: 's', label: t('signature.sizeS') }, { value: 'm', label: t('signature.sizeM') }, { value: 'l', label: t('signature.sizeL') }]} />
                </div>
                <div>
                  <span className="label">{t('signature.spacing')}</span>
                  <Segmented label={t('signature.spacing')} value={design.spacing} onChange={(v) => set('spacing', v)} options={[{ value: 'compact', label: t('signature.spacingCompact') }, { value: 'normal', label: t('signature.spacingNormal') }, { value: 'relaxed', label: t('signature.spacingRelaxed') }]} />
                </div>
              </div>
              <div className="space-y-3 border-t border-line pt-4">
                <span className="label">{t('signature.image')}</span>
                <Segmented label={t('signature.image')} value={design.image} onChange={(v) => set('image', v)} options={[{ value: 'photo', label: t('signature.imagePhoto') }, { value: 'logo', label: t('signature.imageLogo') }, { value: 'none', label: t('signature.imageNone') }]} />
                {design.image === 'photo' && (
                  <div>
                    <span className="label">{t('signature.shape')}</span>
                    <Segmented label={t('signature.shape')} value={design.shape} onChange={(v) => set('shape', v)} options={[{ value: 'circle', label: t('signature.shapeCircle') }, { value: 'rounded', label: t('signature.shapeRounded') }, { value: 'square', label: t('signature.shapeSquare') }]} />
                  </div>
                )}
                {design.image !== 'logo' && <Toggle checked={design.logo} onChange={(v) => set('logo', v)} label={t('signature.secondLogo')} />}
                {((design.image === 'photo' && !previewPhoto) || ((design.image === 'logo' || design.logo) && !previewLogo)) && <p className="text-xs text-muted">{t('signature.imageMissing')}</p>}
              </div>
              <div className="space-y-2 border-t border-line pt-4">
                <Toggle checked={design.divider} onChange={(v) => set('divider', v)} label={t('signature.divider')} />
                <div>
                  <span className="label">{t('signature.labels')}</span>
                  <Segmented label={t('signature.labels')} value={design.labels} onChange={(v) => set('labels', v)} options={[{ value: 'none', label: t('signature.labelsNone') }, { value: 'short', label: t('signature.labelsShort') }, { value: 'full', label: t('signature.labelsFull') }]} />
                </div>
              </div>
            </section>
          )}

          {tab === 'content' && (
            <section role="tabpanel" aria-label={t('signature.tabContent')} className="space-y-4">
              <label className="block">
                <span className="label">{t('signature.tagline')}</span>
                <input className="input" maxLength={80} value={design.tagline} placeholder={t('signature.taglinePlaceholder')} onChange={(e) => set('tagline', e.target.value)} />
              </label>
              <div>
                <span className="label">{t('signature.fields')}</span>
                <ul className="space-y-1.5">
                  {orderedFields.map((field) => {
                    const on = design.fields.includes(field);
                    const at = design.fields.indexOf(field);
                    const empty = !(field === 'address' ? card.address : eff[field]);
                    return (
                      <li key={field} className="flex items-center gap-2">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
                          <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={on} onChange={(e) => set('fields', e.target.checked ? [...design.fields, field] : design.fields.filter((f) => f !== field))} />
                          <span className={on ? '' : 'text-muted'}>{t(`form.${field}`)}</span>
                          {empty && <span className="text-[11px] text-muted">({t('signature.fieldEmpty')})</span>}
                        </label>
                        {on && (
                          <>
                            <button type="button" className="btn btn-ghost btn-sm h-7 px-2" disabled={at === 0} aria-label={t('signature.moveUp', { field: t(`form.${field}`) })} onClick={() => moveField(field, -1)}>
                              ↑
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm h-7 px-2" disabled={at === design.fields.length - 1} aria-label={t('signature.moveDown', { field: t(`form.${field}`) })} onClick={() => moveField(field, 1)}>
                              ↓
                            </button>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="space-y-2 border-t border-line pt-4">
                <span className="label">{t('signature.social')}</span>
                <Segmented label={t('signature.social')} value={design.social} onChange={(v) => set('social', v)} options={[{ value: 'none', label: t('signature.socialNone') }, { value: 'text', label: t('signature.socialText') }, { value: 'badges', label: t('signature.socialBadges') }]} />
                {design.social !== 'none' &&
                  (availableSocials.length ? (
                    <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
                      {availableSocials.map((k) => (
                        <Toggle key={k} checked={design.socials.includes(k)} onChange={(on) => set('socials', on ? [...design.socials, k] : design.socials.filter((s) => s !== k))} label={SOCIAL_LABELS[k]} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted">{t('signature.noSocials')}</p>
                  ))}
              </div>
              <div className="border-t border-line pt-4">
                <span className="label">{t('signature.lang')}</span>
                <Segmented label={t('signature.lang')} value={design.lang} onChange={(v) => set('lang', v)} options={[{ value: 'tr', label: 'Türkçe' }, { value: 'en', label: 'English' }]} />
                <p className="mt-1 text-xs text-muted">{t('signature.langHint')}</p>
              </div>
            </section>
          )}

          {tab === 'html' && design.template === 'custom' && (
            <section role="tabpanel" aria-label={t('signature.tabHtml')} className="space-y-3">
              <label className="block">
                <span className="label">{t('signature.htmlLabel')}</span>
                <textarea
                  ref={htmlRef}
                  className="input min-h-[22rem] font-mono text-xs leading-relaxed"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  maxLength={CUSTOM_HTML_MAX}
                  value={design.customHtml}
                  aria-invalid={htmlProblem ? true : undefined}
                  onChange={(e) => set('customHtml', e.target.value)}
                />
              </label>
              <p role={htmlProblem ? 'alert' : 'status'} className={`text-xs ${htmlProblem ? 'text-danger' : 'text-success'}`}>
                {htmlProblem ? problemText : t('signature.htmlOk')} · {design.customHtml.length.toLocaleString()} / {CUSTOM_HTML_MAX.toLocaleString()}
              </p>
              <div>
                <span className="label">{t('signature.tokensTitle')}</span>
                <div className="flex flex-wrap gap-1.5">
                  {SIGNATURE_TOKENS.map((tok) => (
                    <button key={tok} type="button" className="rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px] hover:border-accent hover:text-accent" title={t(`signature.tokens.${tok}`)} onClick={() => insertAtCursor(`{{${tok}}}`)}>
                      {`{{${tok}}}`}
                    </button>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted">{t('signature.sectionHint')}</p>
              </div>
              <div className="space-y-2 border-t border-line pt-3">
                <span className="label">{t('signature.fromLayout')}</span>
                <div className="flex flex-wrap gap-2">
                  <select className="input w-auto" aria-label={t('signature.fromLayout')} value={convertFrom} onChange={(e) => setConvertFrom(e.target.value as Exclude<SignatureTemplate, 'custom'>)}>
                    {SIGNATURE_TEMPLATES.filter((x) => x !== 'custom').map((x) => (
                      <option key={x} value={x}>
                        {t(`signature.templates.${x}`)}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn btn-secondary btn-sm h-auto" onClick={() => set('customHtml', layoutToCustomHtml(templateSignature(convertFrom, design), data))}>
                    {t('signature.fromLayoutApply')}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm h-auto" onClick={() => set('customHtml', CUSTOM_HTML_STARTER)}>
                    {t('signature.starter')}
                  </button>
                </div>
                <p className="text-xs text-muted">{t('signature.fromLayoutHint')}</p>
              </div>
              <div className="border-t border-line pt-3">
                <span className="label">{t('signature.accent')}</span>
                <div className="flex flex-wrap items-center gap-2">
                  {swatches.map((c) => (
                    <button key={c} type="button" aria-label={c} aria-pressed={currentAccent === c} onClick={() => set('accent', c === card.accent_color?.toLowerCase() ? null : c)} className={`h-6 w-6 rounded-full border-2 ${currentAccent === c ? 'scale-110 border-fg' : 'border-transparent'}`} style={{ backgroundColor: c }} />
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted">{t('signature.accentToken')}</p>
              </div>
              <p className="rounded-lg border border-line bg-fg/5 p-3 text-xs text-muted">{t('signature.htmlRules')}</p>
            </section>
          )}

          {tab === 'extras' && (
            <section role="tabpanel" aria-label={t('signature.tabExtras')} className="space-y-4">
              <div className="space-y-2">
                <Toggle checked={design.cta} onChange={(v) => set('cta', v)} label={t('signature.cta')} />
                {design.cta && <input className="input" maxLength={40} value={design.ctaText} placeholder={design.lang === 'en' ? 'My digital card' : 'Dijital kartvizitim'} aria-label={t('signature.ctaText')} onChange={(e) => set('ctaText', e.target.value)} />}
              </div>
              <Toggle checked={design.qr} onChange={(v) => set('qr', v)} label={t('signature.qr')} />
              <div className="space-y-2 border-t border-line pt-4">
                <span className="label">{t('signature.extraLink')}</span>
                <div className="grid gap-2 sm:grid-cols-[9rem_1fr]">
                  <input className="input" maxLength={30} value={design.extraLabel} placeholder={t('signature.extraLabelPlaceholder')} aria-label={t('signature.extraLabel')} onChange={(e) => set('extraLabel', e.target.value)} />
                  <input
                    className="input"
                    inputMode="url"
                    maxLength={300}
                    value={design.extraUrl}
                    placeholder="https://cal.com/…"
                    aria-label={t('signature.extraUrl')}
                    aria-invalid={extraUrlInvalid ? true : undefined}
                    onChange={(e) => set('extraUrl', e.target.value)}
                  />
                </div>
                <p className={`text-xs ${extraUrlInvalid ? 'text-danger' : 'text-muted'}`}>{extraUrlInvalid ? t('signature.extraUrlInvalid') : t('signature.extraHint')}</p>
              </div>
              <label className="block border-t border-line pt-4">
                <span className="label">{t('signature.disclaimer')}</span>
                <textarea className="input min-h-24" maxLength={600} value={design.disclaimer} placeholder={t('signature.disclaimerPlaceholder')} onChange={(e) => set('disclaimer', e.target.value)} />
                <span className="mt-1 block text-right text-[11px] text-muted">{design.disclaimer.length} / 600</span>
              </label>
            </section>
          )}
        </div>

        <div className="min-w-0 space-y-3 lg:sticky lg:top-0 lg:self-start">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className={`${sectionTitle} mb-0`}>{t('signature.preview')}</h3>
            <div className="flex flex-wrap gap-2">
              <Segmented label={t('signature.device')} value={device} onChange={setDevice} options={[{ value: 'desktop', label: t('signature.desktop') }, { value: 'mobile', label: t('signature.mobile') }]} />
              <Segmented label={t('signature.theme')} value={scheme} onChange={setScheme} options={[{ value: 'light', label: t('signature.light') }, { value: 'dark', label: t('signature.dark') }]} />
            </div>
          </div>
          {!published && <p className="rounded-lg border border-line bg-fg/5 p-3 text-sm">{t('signature.draftWarning')}</p>}
          <div className={`overflow-hidden rounded-xl border shadow-card ${scheme === 'dark' ? 'border-[#3a3a3a] bg-[#1f1f1f] text-[#e8e8e8]' : 'border-line bg-white text-[#1f2937]'}`}>
            {/* A mail-compose frame around the signature: how it sits under a real message. */}
            <div className={`flex items-center gap-2 border-b px-4 py-2.5 text-xs ${scheme === 'dark' ? 'border-[#3a3a3a] text-[#b0b0b0]' : 'border-[#eceef2] text-[#6b7280]'}`}>
              <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" aria-hidden="true" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" aria-hidden="true" />
              <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" aria-hidden="true" />
              <span className="ml-2 font-semibold">{t('signature.mockTitle')}</span>
            </div>
            <div className={`space-y-1 border-b px-4 py-2 text-xs ${scheme === 'dark' ? 'border-[#3a3a3a] text-[#b0b0b0]' : 'border-[#eceef2] text-[#6b7280]'}`}>
              <p>
                <span className="inline-block w-14">{t('signature.mockTo')}</span>
                {t('signature.mockToValue')}
              </p>
              <p>
                <span className="inline-block w-14">{t('signature.mockSubject')}</span>
                {t('signature.mockSubjectValue')}
              </p>
            </div>
            <div className={`mx-auto transition-[max-width] ${device === 'mobile' ? 'max-w-[375px] border-x border-dashed border-[#d0d4dc]/40' : 'max-w-none'}`}>
              <p className="px-5 pt-4 text-sm whitespace-pre-line" style={{ fontFamily: 'Arial, sans-serif' }}>
                {design.lang === 'en' ? 'Hello,\n\nPlease find the notes from today attached.\n\nBest regards,' : 'Merhaba,\n\nBugünkü toplantının notlarını ekte bulabilirsiniz.\n\nİyi çalışmalar,'}
              </p>
              {loading ? <p className="p-6 text-sm text-muted">{t('common.loading')}</p> : <SignatureFrame html={html} title={t('signature.preview')} frameRef={previewRef} dark={scheme === 'dark'} onWidth={setSigWidth} />}
            </div>
          </div>
          {sigWidth > MOBILE_WIDTH && <p className="rounded-lg border border-line bg-fg/5 p-3 text-sm">{t(design.template === 'custom' ? 'signature.tooWideHtml' : 'signature.tooWide', { width: sigWidth, max: MOBILE_WIDTH })}</p>}
          {scheme === 'dark' && <p className="text-xs text-muted">{t('signature.darkHint')}</p>}
          <p className={`text-xs ${count > GMAIL_SIGNATURE_LIMIT ? 'text-danger' : 'text-muted'}`}>
            {t('signature.chars', { count: count.toLocaleString(), max: GMAIL_SIGNATURE_LIMIT.toLocaleString() })} · {count > GMAIL_SIGNATURE_LIMIT ? t('signature.tooLong') : t('signature.charsHint')}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={loading} onClick={() => void copyRich()}>
              {t('signature.copyHtml')}
            </button>
            <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => void copySource()}>
              {t('signature.copySource')}
            </button>
            <button type="button" className="btn btn-secondary" disabled={loading} onClick={() => download(new Blob([frameDoc(exportHtml)], { type: 'text/html;charset=utf-8' }), `email-signature-${card.code}.html`)}>
              {t('signature.downloadHtml')}
            </button>
            <button type="button" className="btn btn-secondary" disabled={loading || busy !== null} onClick={() => void downloadPng()}>
              {busy === 'png' ? t('signature.generating') : t('signature.download')}
            </button>
          </div>
          {status && (
            <p role={status.tone === 'error' ? 'alert' : 'status'} className={`text-sm ${status.tone === 'error' ? 'text-danger' : 'text-success'}`}>
              {status.text}
            </p>
          )}

          <div className="rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className={`${sectionTitle} mb-0`}>{t('signature.guideTitle')}</h3>
              <Segmented label={t('signature.guideTitle')} value={client} onChange={setClient} options={[{ value: 'gmail', label: 'Gmail' }, { value: 'outlook', label: 'Outlook' }, { value: 'apple', label: 'Apple Mail' }]} />
            </div>
            <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm">
              {[1, 2, 3, 4].map((n) => (
                <li key={n}>{t(`signature.guide.${client}${n}`)}</li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </Modal>
  );
}

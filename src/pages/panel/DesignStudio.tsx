import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import PageCard from '../../components/page/PageCard';
import type { PageAssets } from '../../components/page/PageCard';
import PagePreview from '../../components/page/PagePreview';
import { useI18n } from '../../i18n';
import type { PublicCard } from '../../lib/api';
import type { Background, Block, BlockType, ContactField, FontId, PageDesign, PageTemplate, Palette, ThemeMode } from '../../lib/page-design';
import { BLOCK_TYPES, CONTACT_FIELDS, FONTS, FONT_LABELS, FONT_STACKS, PAGE_TEMPLATES, PATTERNS, applyTemplate, defaultBlock, newBlockId, templateDesign, validateDesignConfig } from '../../lib/page-design';
import './studio.css';

const SINGLE: BlockType[] = ['header', 'hero', 'footer'];
const MAX_BLOCKS = 20;
type Tab = 'templates' | 'blocks' | 'style' | 'background' | 'preview';

export interface StudioBackground {
  /** What the preview shows: a new local file, the stored image, or none. */
  url: string | null;
  file: File | null;
  removed: boolean;
}

/** Fills an empty header tag with the default text when a header first appears. */
export function withHeaderTag(design: PageDesign, previous: PageDesign | null, tag: string): PageDesign {
  const hadHeader = previous?.blocks.some((block) => block.type === 'header') ?? false;
  if (hadHeader) return design;
  return { ...design, blocks: design.blocks.map((block) => (block.type === 'header' && !block.tag ? { ...block, tag } : block)) };
}

/**
 * The page designer: pick a template, then rearrange blocks, restyle and set
 * backgrounds freely, with a live phone preview of the real card data. Edits
 * stay local until "Apply"; "Cancel" leaves the form untouched.
 */
export default function DesignStudio({
  initial,
  card,
  assets,
  background,
  accent,
  onApply,
  onClose,
}: {
  initial: PageDesign;
  card: PublicCard;
  assets: Omit<PageAssets, 'background'>;
  background: StudioBackground;
  accent: string;
  onApply: (design: PageDesign, background: StudioBackground) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [design, setDesign] = useState<PageDesign>(initial);
  const [history, setHistory] = useState<PageDesign[]>([]);
  const lastPush = useRef(0);
  const [tab, setTab] = useState<Tab>('templates');
  const [previewMode, setPreviewMode] = useState<ThemeMode>(initial.theme.mode === 'dark' ? 'dark' : 'light');
  const [bg, setBg] = useState<StudioBackground>(background);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!bg.file) {
      setLocalUrl(null);
      return;
    }
    const url = URL.createObjectURL(bg.file);
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [bg.file]);
  const backgroundUrl = localUrl ?? (bg.removed ? null : bg.url);
  const fullAssets: PageAssets = useMemo(() => ({ ...assets, background: backgroundUrl }), [assets, backgroundUrl]);

  // Esc closes (discarding), the page behind does not scroll.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape' && !document.querySelector('.pc-modal')) closeRef.current();
    }
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  /** Applies a change; bursts (a slider drag) collapse into one undo step. */
  function update(mutate: (draft: PageDesign) => void) {
    const next = structuredClone(design);
    mutate(next);
    const now = Date.now();
    if (now - lastPush.current > 600) setHistory((h) => [...h.slice(-49), design]);
    lastPush.current = now;
    setDesign(next);
  }
  function replace(next: PageDesign) {
    setHistory((h) => [...h.slice(-49), design]);
    lastPush.current = 0;
    setDesign(next);
  }
  function undo() {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory(history.slice(0, -1));
    setDesign(prev);
    lastPush.current = 0;
  }

  const check = useMemo(() => validateDesignConfig(design), [design]);
  const badPaths = new Set(check.paths ?? []);

  const tabs: Tab[] = ['templates', 'blocks', 'style', 'background', 'preview'];

  return createPortal(
    <div className="studio" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="studio-bar">
        <h2 id={titleId} className="studio-title">{t('studio.title')}</h2>
        <div className="studio-bar-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={undo} disabled={!history.length}>
            ↶ {t('studio.undo')}
          </button>
          <div className="studio-seg" role="group" aria-label={t('studio.previewLabel')}>
            {(['light', 'dark'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={previewMode === m} onClick={() => setPreviewMode(m)}>
                {m === 'light' ? t('studio.previewLight') : t('studio.previewDark')}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('studio.cancel')}
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!!check.error} onClick={() => check.value && onApply(check.value, bg)}>
            {t('studio.apply')}
          </button>
        </div>
      </header>
      {check.error && (
        <p role="alert" className="studio-alert">
          {t('studio.invalid')}
        </p>
      )}

      <div className={`studio-main studio-tab-${tab}`}>
        <aside className="studio-side">
          <nav className="studio-tabs" role="tablist">
            {tabs.map((id) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={id === 'preview' ? 'studio-tab-preview-btn' : ''} onClick={() => setTab(id)}>
                {t(`studio.tabs.${id}`)}
              </button>
            ))}
          </nav>
          <div className="studio-panel">
            {tab === 'templates' && (
              <TemplatesTab
                card={card}
                assets={fullAssets}
                current={design.template}
                onPick={(id) => replace(withHeaderTag(applyTemplate(design, id), design, t('page.headerTag')))}
              />
            )}
            {tab === 'blocks' && <BlocksTab design={design} update={update} badPaths={badPaths} />}
            {tab === 'style' && <StyleTab design={design} update={update} accent={accent} />}
            {tab === 'background' && <BackgroundTab design={design} update={update} bg={bg} setBg={setBg} hasImage={!!backgroundUrl} />}
          </div>
        </aside>

        <section className="studio-stage" aria-label={t('studio.previewLabel')}>
          <div className="studio-phone">
            <div className="studio-viewport">
              <div className="studio-screen">
                <PageCard card={card} design={design} assets={fullAssets} preview forcedMode={previewMode} />
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}

// ---- tabs ----------------------------------------------------------------------

function TemplatesTab({ card, assets, current, onPick }: { card: PublicCard; assets: PageAssets; current: PageTemplate; onPick: (id: PageTemplate) => void }) {
  const { t } = useI18n();
  const designs = useMemo(() => Object.fromEntries(PAGE_TEMPLATES.map((id) => [id, templateDesign(id)])) as Record<PageTemplate, PageDesign>, []);
  return (
    <div>
      <p className="studio-hint">{t('studio.templateHint')}</p>
      <div className="studio-templates">
        {PAGE_TEMPLATES.map((id) => (
          <button key={id} type="button" className="studio-template" aria-pressed={current === id} onClick={() => onPick(id)}>
            <PagePreview card={card} design={designs[id]} assets={assets} scale={0.34} height={600} />
            <span className="studio-template-name">{t(`studio.templates.${id}`)}</span>
            <span className="studio-template-note">{t(`studio.templateNotes.${id}`)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

type Update = (mutate: (draft: PageDesign) => void) => void;

function BlocksTab({ design, update, badPaths }: { design: PageDesign; update: Update; badPaths: Set<string> }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<BlockType>('text');
  const present = new Set(design.blocks.map((block) => block.type));
  const addable = BLOCK_TYPES.filter((type) => !(SINGLE.includes(type) && present.has(type)));
  const full = design.blocks.length >= MAX_BLOCKS;

  function move(index: number, delta: number) {
    update((d) => {
      const [block] = d.blocks.splice(index, 1);
      if (block) d.blocks.splice(index + delta, 0, block);
    });
  }

  function add() {
    const type = addable.includes(adding) ? adding : addable[0];
    if (!type || full) return;
    const id = newBlockId();
    update((d) => {
      const footer = d.blocks.findIndex((block) => block.type === 'footer');
      d.blocks.splice(footer < 0 || type === 'footer' ? d.blocks.length : footer, 0, defaultBlock(type, id));
    });
    setOpen(id);
  }

  return (
    <div className="space-y-2">
      {design.blocks.map((block, index) => {
        const expanded = open === block.id;
        const hasError = [...badPaths].some((p) => p.startsWith(`blocks.${index}.`));
        return (
          <div key={block.id} className={`studio-block ${block.hidden ? 'is-hidden' : ''} ${hasError ? 'has-error' : ''}`}>
            <div className="studio-block-head">
              <button type="button" className="studio-block-title" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : block.id)}>
                <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                {t(`studio.blocks.${block.type}`)}
                {block.hidden && <span className="studio-badge">{t('studio.hiddenBadge')}</span>}
              </button>
              <div className="studio-block-tools">
                <IconButton label={t('studio.moveUp')} disabled={index === 0} onClick={() => move(index, -1)}>↑</IconButton>
                <IconButton label={t('studio.moveDown')} disabled={index === design.blocks.length - 1} onClick={() => move(index, 1)}>↓</IconButton>
                <IconButton label={block.hidden ? t('studio.show') : t('studio.hide')} pressed={block.hidden} onClick={() => update((d) => { d.blocks[index]!.hidden = !d.blocks[index]!.hidden; })}>
                  {block.hidden ? '◌' : '◉'}
                </IconButton>
                <IconButton label={t('studio.remove')} danger onClick={() => update((d) => { d.blocks.splice(index, 1); })}>✕</IconButton>
              </div>
            </div>
            {expanded && <BlockEditor block={block} index={index} update={update} badPaths={badPaths} />}
          </div>
        );
      })}

      <div className="studio-add">
        <select className="input" value={addable.includes(adding) ? adding : addable[0]} onChange={(e) => setAdding(e.target.value as BlockType)} aria-label={t('studio.addBlock')}>
          {addable.map((type) => (
            <option key={type} value={type}>
              {t(`studio.blocks.${type}`)}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-secondary" onClick={add} disabled={full || !addable.length}>
          + {t('studio.addBlock')}
        </button>
      </div>
      {full && <p className="studio-hint">{t('studio.blockLimit', { max: MAX_BLOCKS })}</p>}
    </div>
  );
}

function BlockEditor({ block, index, update, badPaths }: { block: Block; index: number; update: Update; badPaths: Set<string> }) {
  const { t } = useI18n();
  const set = (key: string, value: unknown) =>
    update((d) => {
      (d.blocks[index] as unknown as Record<string, unknown>)[key] = value;
    });
  const err = (key: string) => (badPaths.has(`blocks.${index}.${key}`) ? (key === 'url' ? t('studio.invalidUrl') : t('studio.invalid')) : undefined);

  switch (block.type) {
    case 'header':
      return (
        <div className="studio-block-body">
          <TextField label={t('studio.field.tag')} value={block.tag} max={40} placeholder={t('page.headerTag')} onChange={(v) => set('tag', v)} />
        </div>
      );
    case 'hero':
      return (
        <div className="studio-block-body">
          <Check label={t('studio.field.actions')} checked={block.actions} onChange={(v) => set('actions', v)} />
        </div>
      );
    case 'contacts': {
      const order: ContactField[] = [...block.fields, ...CONTACT_FIELDS.filter((f) => !block.fields.includes(f))];
      return (
        <div className="studio-block-body">
          <TextField label={t('studio.field.title')} value={block.title} max={40} placeholder={t('page.contactsTitle')} hint={t('studio.defaultHint')} onChange={(v) => set('title', v)} />
          <Segmented label={t('studio.field.contactStyle')} value={block.style} options={(['rows', 'tiles', 'buttons'] as const).map((v) => ({ value: v, label: t(`studio.contactStyles.${v}`) }))} onChange={(v) => set('style', v)} />
          <div>
            <span className="label">{t('studio.field.contactFields')}</span>
            <ul className="studio-fields">
              {order.map((f) => {
                const on = block.fields.includes(f);
                const at = block.fields.indexOf(f);
                return (
                  <li key={f}>
                    <label>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => set('fields', on ? block.fields.filter((x) => x !== f) : [...block.fields, f])}
                      />
                      {t(`page.fields.${f}`)}
                    </label>
                    {on && (
                      <span className="studio-block-tools">
                        <IconButton label={t('studio.moveUp')} disabled={at === 0} onClick={() => set('fields', swap(block.fields, at, at - 1))}>↑</IconButton>
                        <IconButton label={t('studio.moveDown')} disabled={at === block.fields.length - 1} onClick={() => set('fields', swap(block.fields, at, at + 1))}>↓</IconButton>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      );
    }
    case 'note':
      return (
        <div className="studio-block-body">
          <TextField label={t('studio.field.title')} value={block.title} max={40} placeholder={t('page.noteTitle')} hint={t('studio.defaultHint')} onChange={(v) => set('title', v)} />
        </div>
      );
    case 'text':
      return (
        <div className="studio-block-body">
          <TextField label={t('studio.field.title')} value={block.title} max={80} onChange={(v) => set('title', v)} />
          <TextField label={t('studio.field.body')} value={block.body} max={800} multiline onChange={(v) => set('body', v)} />
        </div>
      );
    case 'link':
      return (
        <div className="studio-block-body">
          <TextField label={t('studio.field.label')} value={block.label} max={60} onChange={(v) => set('label', v)} />
          <TextField label={t('studio.field.url')} value={block.url} max={300} placeholder="ornek.com/menu" error={err('url')} onChange={(v) => set('url', v)} />
        </div>
      );
    case 'qr':
      return (
        <div className="studio-block-body">
          <TextField label={t('studio.field.title')} value={block.title} max={80} placeholder={t('page.qrTitle')} hint={t('studio.defaultHint')} onChange={(v) => set('title', v)} />
          <TextField label={t('studio.field.body')} value={block.body} max={200} placeholder={t('page.qrBody')} onChange={(v) => set('body', v)} />
        </div>
      );
    case 'footer':
      return (
        <div className="studio-block-body">
          <TextField label={t('studio.field.footerText')} value={block.text} max={80} placeholder={`© ${new Date().getFullYear()} …`} hint={t('studio.defaultHint')} onChange={(v) => set('text', v)} />
        </div>
      );
    default:
      return null;
  }
}

function swap<T>(list: T[], a: number, b: number): T[] {
  const next = [...list];
  [next[a], next[b]] = [next[b]!, next[a]!];
  return next;
}

function StyleTab({ design, update, accent }: { design: PageDesign; update: Update; accent: string }) {
  const { t } = useI18n();
  const [which, setWhich] = useState<'light' | 'dark'>('light');
  const { theme, avatar } = design;
  const palette = theme[which];
  return (
    <div className="space-y-5">
      <Section title={t('studio.style.mode')}>
        <Segmented value={theme.mode} options={(['light', 'dark', 'auto'] as const).map((v) => ({ value: v, label: t(`studio.style.modes.${v}`) }))} onChange={(v) => update((d) => { d.theme.mode = v; })} />
        <Check label={t('studio.style.toggle')} checked={theme.toggle} onChange={(v) => update((d) => { d.theme.toggle = v; })} />
      </Section>

      <Section title={t('studio.style.palette')}>
        <Segmented value={which} options={[{ value: 'light', label: t('studio.style.paletteLight') }, { value: 'dark', label: t('studio.style.paletteDark') }]} onChange={setWhich} />
        <div className="studio-colors">
          {(Object.keys(palette) as (keyof Palette)[]).map((key) => (
            <ColorField key={key} label={t(`studio.style.colors.${key}`)} value={palette[key]} onChange={(v) => update((d) => { d.theme[which][key] = v; })} />
          ))}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => update((d) => { d.theme.light.accent = accent; d.theme.dark.accent = accent; })}>
          <span className="studio-dot" style={{ backgroundColor: accent }} /> {t('studio.style.useAccent')}
        </button>
      </Section>

      <Section title={t('studio.style.typography')}>
        <FontField label={t('studio.style.font')} value={theme.font} onChange={(v) => update((d) => { d.theme.font = v; })} />
        <FontField label={t('studio.style.heading')} value={theme.heading} onChange={(v) => update((d) => { d.theme.heading = v; })} />
        <Segmented label={t('studio.style.nameSize')} value={theme.nameSize} options={(['sm', 'md', 'lg', 'xl'] as const).map((v) => ({ value: v, label: v.toUpperCase() }))} onChange={(v) => update((d) => { d.theme.nameSize = v; })} />
      </Section>

      <Section title={t('studio.style.shape')}>
        <Range label={t('studio.style.radius')} value={theme.radius} min={0} max={28} suffix="px" onChange={(v) => update((d) => { d.theme.radius = v; })} />
        <Segmented label={t('studio.style.align')} value={theme.align} options={(['center', 'left'] as const).map((v) => ({ value: v, label: t(`studio.style.aligns.${v}`) }))} onChange={(v) => update((d) => { d.theme.align = v; })} />
        <Segmented label={t('studio.style.buttons')} value={theme.buttons} options={(['pill', 'rounded', 'square'] as const).map((v) => ({ value: v, label: t(`studio.style.buttonShapes.${v}`) }))} onChange={(v) => update((d) => { d.theme.buttons = v; })} />
        <Segmented label={t('studio.style.primary')} value={theme.primary} options={(['ink', 'accent'] as const).map((v) => ({ value: v, label: t(`studio.style.primaries.${v}`) }))} onChange={(v) => update((d) => { d.theme.primary = v; })} />
        <Segmented label={t('studio.style.surface')} value={theme.surface} options={(['card', 'glass', 'flat'] as const).map((v) => ({ value: v, label: t(`studio.style.surfaces.${v}`) }))} onChange={(v) => update((d) => { d.theme.surface = v; })} />
      </Section>

      <Section title={t('studio.style.avatar')}>
        <Check label={t('studio.style.avatarShow')} checked={avatar.show} onChange={(v) => update((d) => { d.avatar.show = v; })} />
        {avatar.show && (
          <>
            <Segmented label={t('studio.style.avatarShape')} value={avatar.shape} options={(['circle', 'rounded', 'square'] as const).map((v) => ({ value: v, label: t(`studio.style.avatarShapes.${v}`) }))} onChange={(v) => update((d) => { d.avatar.shape = v; })} />
            <Range label={t('studio.style.avatarSize')} value={avatar.size} min={64} max={180} step={4} suffix="px" onChange={(v) => update((d) => { d.avatar.size = v; })} />
            <Check label={t('studio.style.avatarStatus')} checked={avatar.status} onChange={(v) => update((d) => { d.avatar.status = v; })} />
            <Check label={t('studio.style.avatarRing')} checked={avatar.ring} onChange={(v) => update((d) => { d.avatar.ring = v; })} />
          </>
        )}
      </Section>

      <Section title={t('studio.style.extras')}>
        <Check label={t('studio.style.dock')} checked={design.dock} onChange={(v) => update((d) => { d.dock = v; })} />
      </Section>
    </div>
  );
}

function BackgroundTab({ design, update, bg, setBg, hasImage }: { design: PageDesign; update: Update; bg: StudioBackground; setBg: (b: StudioBackground) => void; hasImage: boolean }) {
  const { t } = useI18n();
  const { hero } = design;
  const usesImage = hero.background.kind === 'image' || design.page.background.kind === 'image';
  return (
    <div className="space-y-5">
      <Section title={t('studio.bg.image')}>
        <div className="flex flex-wrap gap-2">
          <label className="btn btn-secondary btn-sm cursor-pointer">
            {hasImage ? t('studio.bg.imageChange') : t('studio.bg.imageChoose')}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0] ?? null;
                if (file) {
                  setBg({ ...bg, file, removed: false });
                  // Picking an image means wanting to see it: switch the hero to it.
                  if (!usesImage) update((d) => { d.hero.background.kind = 'image'; if (d.hero.background.overlay === 0) d.hero.background.overlay = 60; });
                }
                e.target.value = '';
              }}
            />
          </label>
          {hasImage && (
            <button type="button" className="btn btn-ghost btn-sm text-danger" onClick={() => setBg({ ...bg, file: null, removed: true })}>
              {t('studio.bg.imageRemove')}
            </button>
          )}
        </div>
        <p className="studio-hint">{t('studio.bg.imageHint')}</p>
        {usesImage && !hasImage && <p className="studio-hint studio-warn">{t('studio.bg.imageMissing')}</p>}
      </Section>

      <Section title={t('studio.bg.hero')}>
        <Segmented label={t('studio.bg.layout')} value={hero.layout} options={(['stack', 'banner', 'split'] as const).map((v) => ({ value: v, label: t(`studio.bg.layouts.${v}`) }))} onChange={(v) => update((d) => { d.hero.layout = v; })} />
        <Check label={t('studio.bg.framed')} checked={hero.framed} onChange={(v) => update((d) => { d.hero.framed = v; })} />
        {hero.layout !== 'split' && (
          <Segmented label={t('studio.bg.height')} value={hero.height} options={(['sm', 'md', 'lg'] as const).map((v) => ({ value: v, label: t(`studio.bg.heights.${v}`) }))} onChange={(v) => update((d) => { d.hero.height = v; })} />
        )}
        {hero.layout !== 'banner' && (
          <Segmented label={t('studio.bg.text')} value={hero.text} options={(['auto', 'light', 'dark'] as const).map((v) => ({ value: v, label: t(`studio.bg.texts.${v}`) }))} onChange={(v) => update((d) => { d.hero.text = v; })} />
        )}
        <BackgroundEditor value={hero.background} onChange={(mutate) => update((d) => mutate(d.hero.background))} />
      </Section>

      <Section title={t('studio.bg.page')}>
        <BackgroundEditor value={design.page.background} onChange={(mutate) => update((d) => mutate(d.page.background))} />
      </Section>
    </div>
  );
}

function BackgroundEditor({ value, onChange }: { value: Background; onChange: (mutate: (bg: Background) => void) => void }) {
  const { t } = useI18n();
  const kinds = ['none', 'color', 'gradient', 'image', 'pattern'] as const;
  return (
    <div className="space-y-3">
      <Segmented label={t('studio.bg.kind')} value={value.kind} options={kinds.map((v) => ({ value: v, label: t(`studio.bg.kinds.${v}`) }))} onChange={(v) => onChange((bg) => { bg.kind = v; })} />
      {(value.kind === 'color' || value.kind === 'gradient' || value.kind === 'pattern') && (
        <div className="studio-colors">
          <ColorField label={t('studio.bg.color')} value={value.color} onChange={(v) => onChange((bg) => { bg.color = v; })} />
          {value.kind === 'gradient' && <ColorField label={t('studio.bg.color2')} value={value.color2} onChange={(v) => onChange((bg) => { bg.color2 = v; })} />}
        </div>
      )}
      {value.kind === 'gradient' && <Range label={t('studio.bg.angle')} value={value.angle} min={0} max={360} step={5} suffix="°" onChange={(v) => onChange((bg) => { bg.angle = v; })} />}
      {value.kind === 'pattern' && (
        <Segmented label={t('studio.bg.pattern')} value={value.pattern} options={PATTERNS.map((v) => ({ value: v, label: t(`studio.bg.patterns.${v}`) }))} onChange={(v) => onChange((bg) => { bg.pattern = v; })} />
      )}
      {(value.kind === 'image' || value.kind === 'pattern' || value.kind === 'gradient') && (
        <Range label={t('studio.bg.overlay')} value={value.overlay} min={0} max={95} suffix="%" onChange={(v) => onChange((bg) => { bg.overlay = v; })} />
      )}
      {value.kind === 'image' && <Range label={t('studio.bg.blur')} value={value.blur} min={0} max={16} suffix="px" onChange={(v) => onChange((bg) => { bg.blur = v; })} />}
    </div>
  );
}

// ---- controls -------------------------------------------------------------------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="studio-section">
      <legend>{title}</legend>
      <div className="space-y-3">{children}</div>
    </fieldset>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label?: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  const id = useId();
  return (
    <div>
      {label && <span id={id} className="label">{label}</span>}
      <div className="studio-seg studio-seg-wide" role="group" aria-labelledby={label ? id : undefined}>
        {options.map((o) => (
          <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="studio-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Range({ label, value, min, max, step = 1, suffix = '', onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="label flex justify-between">
        <span>{label}</span>
        <span className="text-muted tabular-nums">{value}{suffix}</span>
      </label>
      <input id={id} type="range" className="studio-range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <div className="studio-color">
      <input id={id} type="color" value={value} onChange={(e) => onChange(e.target.value.toLowerCase())} aria-label={label} />
      <label htmlFor={id} className="studio-color-label">{label}</label>
      <input
        className="studio-color-hex"
        value={draft}
        maxLength={7}
        spellCheck={false}
        aria-label={`${label} (hex)`}
        onChange={(e) => {
          const v = e.target.value.trim();
          setDraft(v);
          if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v.toLowerCase());
        }}
        onBlur={() => setDraft(value)}
      />
    </div>
  );
}

function FontField({ label, value, onChange }: { label: string; value: FontId; onChange: (value: FontId) => void }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      <div className="flex items-center gap-3">
        <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value as FontId)}>
          {FONTS.map((f) => (
            <option key={f} value={f}>
              {FONT_LABELS[f]}
            </option>
          ))}
        </select>
        <span className="studio-font-sample" style={{ fontFamily: FONT_STACKS[value] }} aria-hidden="true">
          Ağ Şİ
        </span>
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  max,
  placeholder,
  hint,
  error,
  multiline = false,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  placeholder?: string;
  hint?: string;
  error?: string;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const common = {
    id,
    className: multiline ? 'input min-h-24' : 'input',
    value,
    maxLength: max,
    placeholder,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error || hint ? `${id}-msg` : undefined,
  };
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      {multiline ? <textarea {...common} onChange={(e) => onChange(e.target.value)} /> : <input {...common} onChange={(e) => onChange(e.target.value)} />}
      {(error || hint) && (
        <p id={`${id}-msg`} className={`mt-1 text-xs ${error ? 'text-danger' : 'text-muted'}`}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

function IconButton({ label, children, onClick, disabled, pressed, danger }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean; pressed?: boolean; danger?: boolean }) {
  return (
    <button type="button" className={`studio-icon ${danger ? 'is-danger' : ''}`} aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

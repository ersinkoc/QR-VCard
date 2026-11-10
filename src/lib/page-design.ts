/**
 * Page designer: template presets and the helpers that turn a design document
 * into styles. The document schema itself (types, defaults, validation) lives
 * in server/design-config.mjs, shared with the server so both sides agree.
 */
import type { CSSProperties } from 'react';
import { defaultBlock, normalizeDesign } from '../../server/design-config.mjs';
import type { Background, Block, BlockType, FontId, PageDesign, PageTemplate, Palette } from '../../server/design-config.mjs';

export { BLOCK_TYPES, CONTACT_FIELDS, FONTS, PAGE_TEMPLATES, PATTERNS, defaultBlock, defaultDesign, resolveDesign, validateDesignConfig } from '../../server/design-config.mjs';
export type { Background, Block, BlockType, ContactField, FontId, PageDesign, PageTemplate, Palette } from '../../server/design-config.mjs';

export const FONT_STACKS: Record<FontId, string> = {
  onest: "'Onest Variable', 'Segoe UI', system-ui, sans-serif",
  manrope: "'Manrope Variable', 'Segoe UI', system-ui, sans-serif",
  grotesk: "'Space Grotesk Variable', 'Segoe UI', system-ui, sans-serif",
  fraunces: "'Fraunces Variable', Georgia, 'Times New Roman', serif",
  playfair: "'Playfair Display Variable', Georgia, 'Times New Roman', serif",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
};

export const FONT_LABELS: Record<FontId, string> = {
  onest: 'Onest',
  manrope: 'Manrope',
  grotesk: 'Space Grotesk',
  fraunces: 'Fraunces',
  playfair: 'Playfair Display',
  system: 'System',
  serif: 'Georgia',
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };

function merge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (!patch) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)
        ? merge(current, value as DeepPartial<typeof current>)
        : value;
  }
  return out as T;
}

const b = <T extends BlockType>(type: T, id: string, props?: Partial<Extract<Block, { type: T }>>) => ({ ...defaultBlock(type, id), ...props }) as Block;

/**
 * The presets. Each is a patch over the default document — itself the
 * "Porcelain" layout: logo header, an image hero behind a soft veil, a large
 * name, labelled contact rows, a QR card, a footer and the quick-action dock.
 */
const PRESETS: Record<PageTemplate, DeepPartial<PageDesign>> = {
  porcelain: {},
  banner: {
    theme: {
      mode: 'light',
      light: { bg: '#f4f6fb', surface: '#ffffff', ink: '#0f172a', muted: '#526079', line: '#dfe4ee', accent: '#2457f5' },
      dark: { bg: '#0b1120', surface: '#131c31', ink: '#e8edf7', muted: '#93a1bc', line: '#243150', accent: '#6d8dff' },
      font: 'manrope',
      heading: 'manrope',
      align: 'left',
      nameSize: 'lg',
      buttons: 'rounded',
      primary: 'accent',
    },
    hero: { layout: 'banner', framed: true, height: 'md', text: 'auto', background: { kind: 'gradient', color: '#2457f5', color2: '#0f172a', angle: 135, overlay: 0 } },
    avatar: { shape: 'rounded', size: 116, status: false, ring: true },
    blocks: [b('hero', 'hero'), b('contacts', 'contacts', { style: 'tiles' }), b('note', 'note'), b('qr', 'qr'), b('footer', 'footer')],
  },
  aurora: {
    theme: {
      mode: 'dark',
      light: { bg: '#eef6fb', surface: '#ffffff', ink: '#0b1726', muted: '#4d6177', line: '#d3e2ee', accent: '#0891b2' },
      dark: { bg: '#070d1a', surface: '#101a2e', ink: '#eaf4ff', muted: '#9fb3c8', line: '#22324d', accent: '#22d3ee' },
      font: 'grotesk',
      heading: 'grotesk',
      radius: 18,
      surface: 'glass',
      primary: 'accent',
    },
    hero: { layout: 'stack', framed: false, background: { kind: 'none' } },
    page: { background: { kind: 'gradient', color: '#0b1d3a', color2: '#05313a', angle: 160 } },
    avatar: { size: 120, ring: true },
    blocks: [b('header', 'header'), b('hero', 'hero'), b('contacts', 'contacts', { style: 'buttons' }), b('qr', 'qr'), b('footer', 'footer')],
  },
  minimal: {
    theme: {
      mode: 'auto',
      light: { bg: '#ffffff', surface: '#ffffff', ink: '#111111', muted: '#6b6b6b', line: '#ececec', accent: '#111111' },
      dark: { bg: '#0d0d0d', surface: '#0d0d0d', ink: '#f2f2f2', muted: '#9a9a9a', line: '#262626', accent: '#f2f2f2' },
      font: 'manrope',
      heading: 'fraunces',
      radius: 4,
      align: 'left',
      nameSize: 'lg',
      buttons: 'square',
      surface: 'flat',
    },
    hero: { layout: 'split', framed: false, background: { kind: 'none' } },
    avatar: { size: 88, status: false },
    dock: false,
    blocks: [b('hero', 'hero'), b('contacts', 'contacts'), b('note', 'note'), b('qr', 'qr'), b('footer', 'footer')],
  },
  bold: {
    theme: {
      mode: 'light',
      light: { bg: '#f5f3ff', surface: '#ffffff', ink: '#1e1b4b', muted: '#5b5794', line: '#e3e0fb', accent: '#4f46e5' },
      dark: { bg: '#110f2a', surface: '#1b1840', ink: '#eeecff', muted: '#a7a3d8', line: '#2e2a63', accent: '#8b85ff' },
      font: 'onest',
      heading: 'onest',
      radius: 22,
      buttons: 'pill',
      primary: 'accent',
    },
    hero: { layout: 'stack', framed: false, height: 'lg', text: 'light', background: { kind: 'color', color: '#4f46e5' } },
    avatar: { size: 128, ring: true, status: false },
    blocks: [b('hero', 'hero'), b('contacts', 'contacts', { style: 'tiles' }), b('note', 'note'), b('qr', 'qr'), b('footer', 'footer')],
  },
  noir: {
    theme: {
      mode: 'dark',
      light: { bg: '#f6f1e7', surface: '#fffdf8', ink: '#1a1712', muted: '#6b6252', line: '#e4dccb', accent: '#a8842c' },
      dark: { bg: '#0b0b0b', surface: '#151515', ink: '#f1ece1', muted: '#a39c8c', line: '#2a2824', accent: '#d4af37' },
      font: 'manrope',
      heading: 'playfair',
      radius: 2,
      buttons: 'square',
      primary: 'accent',
    },
    hero: { layout: 'stack', framed: true, text: 'auto', background: { kind: 'pattern', pattern: 'rings', color: '#d4af37', overlay: 82 } },
    avatar: { shape: 'circle', size: 124, status: false, ring: true },
  },
  pattern: {
    theme: {
      mode: 'light',
      light: { bg: '#f1f8f4', surface: '#ffffff', ink: '#0f2a1d', muted: '#4d6b5b', line: '#d5e9dd', accent: '#059669' },
      dark: { bg: '#081a12', surface: '#0f261b', ink: '#e6f5ec', muted: '#93b8a3', line: '#1f3d2e', accent: '#34d399' },
      font: 'onest',
      heading: 'grotesk',
      radius: 16,
      buttons: 'rounded',
    },
    hero: { layout: 'stack', framed: true, background: { kind: 'pattern', pattern: 'dots', color: '#059669', overlay: 70 } },
    blocks: [b('header', 'header'), b('hero', 'hero'), b('contacts', 'contacts', { style: 'tiles' }), b('note', 'note'), b('qr', 'qr'), b('footer', 'footer')],
  },
  sunset: {
    theme: {
      mode: 'light',
      light: { bg: '#fff7f2', surface: '#ffffff', ink: '#2b1408', muted: '#7a5646', line: '#f3e1d6', accent: '#e8590c' },
      dark: { bg: '#1a0d07', surface: '#26140b', ink: '#ffeee4', muted: '#c49d88', line: '#3d2316', accent: '#ff8a4c' },
      font: 'manrope',
      heading: 'fraunces',
      radius: 20,
      primary: 'accent',
    },
    hero: { layout: 'banner', framed: false, height: 'lg', text: 'light', background: { kind: 'gradient', color: '#ff7e5f', color2: '#feb47b', angle: 135 } },
    avatar: { size: 128, ring: true, status: false },
    blocks: [b('hero', 'hero'), b('contacts', 'contacts'), b('note', 'note'), b('qr', 'qr'), b('footer', 'footer')],
  },
};

export function templateDesign(id: PageTemplate): PageDesign {
  const base = normalizeDesign({}).value;
  return normalizeDesign({ ...merge(base, PRESETS[id]), template: id }).value;
}

/**
 * Switching template keeps what the owner wrote: block texts and custom
 * blocks carry over, only the layout and styling follow the preset.
 */
export function applyTemplate(current: PageDesign | null, id: PageTemplate): PageDesign {
  const next = templateDesign(id);
  if (!current) return next;
  const own = new Map(current.blocks.map((block) => [block.type, block]));
  const blocks: Block[] = next.blocks.map((block) => {
    const mine = own.get(block.type);
    if (!mine) return block;
    // The owner's words survive; the preset decides presentation (contact style).
    if (block.type === 'contacts' && mine.type === 'contacts') return { ...mine, id: block.id, style: block.style };
    return { ...mine, id: block.id } as Block;
  });
  const custom = current.blocks.filter((block) => block.type === 'text' || block.type === 'link' || block.type === 'divider');
  const footerAt = blocks.findIndex((block) => block.type === 'footer');
  blocks.splice(footerAt < 0 ? blocks.length : footerAt, 0, ...custom.filter((c) => !blocks.some((x) => x.id === c.id)));
  return { ...next, blocks };
}

export function newBlockId(): string {
  return Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, '') || 'b';
}

export type ThemeMode = 'light' | 'dark';

export function paletteFor(design: PageDesign, mode: ThemeMode): Palette {
  return mode === 'dark' ? design.theme.dark : design.theme.light;
}

const NAME_SIZES = { sm: '30px', md: '38px', lg: '46px', xl: '56px' } as const;
const BUTTON_RADII = { pill: '999px', rounded: '12px', square: '4px' } as const;
const AVATAR_RADII = { circle: '50%', rounded: '24%', square: '6px' } as const;

/** Custom properties for the page root. Every value is a validated colour, enum or number. */
export function designVars(design: PageDesign, mode: ThemeMode): CSSProperties {
  const p = paletteFor(design, mode);
  const { theme, avatar } = design;
  return {
    '--pc-bg': p.bg,
    '--pc-surface': p.surface,
    '--pc-ink': p.ink,
    '--pc-muted': p.muted,
    '--pc-line': p.line,
    '--pc-accent': p.accent,
    '--pc-primary': theme.primary === 'accent' ? p.accent : p.ink,
    '--pc-primary-ink': theme.primary === 'accent' ? readableOn(p.accent) : p.bg,
    '--pc-font': FONT_STACKS[theme.font],
    '--pc-heading': FONT_STACKS[theme.heading],
    '--pc-radius': `${theme.radius}px`,
    '--pc-name-size': NAME_SIZES[theme.nameSize],
    '--pc-button-radius': BUTTON_RADII[theme.buttons],
    '--pc-avatar-size': `${avatar.size}px`,
    '--pc-avatar-radius': AVATAR_RADII[avatar.shape],
    colorScheme: mode,
  } as CSSProperties;
}

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
export function readableOn(hex: string): string {
  const [r, g, b2] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  return lum > 0.4 ? '#111111' : '#ffffff';
}

/**
 * The layers of a background: the base (colour, gradient or image) and an
 * optional veil of the palette background on top. `imageUrl` is always one of
 * this app's own image endpoints (or a local object URL in the editor).
 */
export function backgroundLayers(bg: Background, palette: Palette, imageUrl: string | null): { base: CSSProperties | null; veil: CSSProperties | null; pattern: string | null } {
  const veil = (opacity: number): CSSProperties | null => (opacity > 0 ? { backgroundColor: palette.bg, opacity: opacity / 100 } : null);
  switch (bg.kind) {
    case 'color':
      return { base: { backgroundColor: bg.color }, veil: null, pattern: null };
    case 'gradient':
      return { base: { backgroundImage: `linear-gradient(${bg.angle}deg, ${bg.color}, ${bg.color2})` }, veil: veil(bg.overlay), pattern: null };
    case 'pattern':
      return { base: { backgroundColor: palette.surface, color: bg.color }, veil: veil(bg.overlay), pattern: bg.pattern };
    case 'image':
      if (!imageUrl) {
        // No upload yet: a quiet wash of the palette instead of a broken image.
        return { base: { backgroundImage: `linear-gradient(${bg.angle}deg, ${palette.line}, ${palette.surface})` }, veil: null, pattern: null };
      }
      return {
        base: {
          backgroundImage: `url("${imageUrl.replace(/["\\\n\r]/g, '')}")`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          filter: bg.blur ? `blur(${bg.blur}px)` : undefined,
          transform: bg.blur ? 'scale(1.08)' : undefined,
        },
        veil: veil(bg.overlay),
        pattern: null,
      };
    default:
      return { base: null, veil: null, pattern: null };
  }
}

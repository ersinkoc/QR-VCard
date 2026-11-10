// Types for design-config.mjs, which the browser bundle imports too.

export type PageTemplate = 'porcelain' | 'banner' | 'aurora' | 'minimal' | 'bold' | 'noir' | 'pattern' | 'sunset';
export type FontId = 'onest' | 'manrope' | 'grotesk' | 'fraunces' | 'playfair' | 'system' | 'serif';
export type BlockType = 'header' | 'hero' | 'contacts' | 'note' | 'text' | 'link' | 'qr' | 'divider' | 'footer';
export type ContactField = 'phone' | 'whatsapp' | 'email' | 'website' | 'linkedin' | 'instagram' | 'telegram' | 'address';
export type BackgroundKind = 'none' | 'color' | 'gradient' | 'image' | 'pattern';
export type PatternId = 'dots' | 'grid' | 'diagonal' | 'waves' | 'rings';

export interface Palette {
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  line: string;
  accent: string;
}

export interface Background {
  kind: BackgroundKind;
  color: string;
  color2: string;
  angle: number;
  pattern: PatternId;
  /** Percent of the palette background laid over an image or pattern. */
  overlay: number;
  /** Image blur in px. */
  blur: number;
}

interface BlockBase {
  id: string;
  hidden: boolean;
}

export type Block =
  | (BlockBase & { type: 'header'; tag: string })
  | (BlockBase & { type: 'hero'; actions: boolean })
  | (BlockBase & { type: 'contacts'; title: string; style: 'rows' | 'tiles' | 'buttons'; fields: ContactField[] })
  | (BlockBase & { type: 'note'; title: string })
  | (BlockBase & { type: 'text'; title: string; body: string })
  | (BlockBase & { type: 'link'; label: string; url: string })
  | (BlockBase & { type: 'qr'; title: string; body: string })
  | (BlockBase & { type: 'divider' })
  | (BlockBase & { type: 'footer'; text: string });

export interface PageDesign {
  v: 1;
  template: PageTemplate;
  theme: {
    mode: 'light' | 'dark' | 'auto';
    toggle: boolean;
    light: Palette;
    dark: Palette;
    font: FontId;
    heading: FontId;
    radius: number;
    align: 'center' | 'left';
    nameSize: 'sm' | 'md' | 'lg' | 'xl';
    buttons: 'pill' | 'rounded' | 'square';
    primary: 'ink' | 'accent';
    surface: 'card' | 'glass' | 'flat';
  };
  hero: {
    layout: 'stack' | 'banner' | 'split';
    framed: boolean;
    height: 'sm' | 'md' | 'lg';
    text: 'auto' | 'light' | 'dark';
    background: Background;
  };
  page: { background: Background };
  avatar: { show: boolean; shape: 'circle' | 'rounded' | 'square'; size: number; status: boolean; ring: boolean };
  dock: boolean;
  blocks: Block[];
}

export const DESIGN_VERSION: 1;
export const DESIGN_MAX_BYTES: number;
export const DESIGN_MAX_BLOCKS: number;
export const PAGE_TEMPLATES: PageTemplate[];
export const FONTS: FontId[];
export const BLOCK_TYPES: BlockType[];
export const CONTACT_FIELDS: ContactField[];
export const BACKGROUND_KINDS: BackgroundKind[];
export const PATTERNS: PatternId[];
export const DEFAULT_LIGHT: Palette;
export const DEFAULT_DARK: Palette;

export function defaultBlock<T extends BlockType>(type: T, id: string): Extract<Block, { type: T }>;
export function defaultDesign(): PageDesign;
export function normalizeDesign(input: unknown): { value: PageDesign; errors: string[] };
export function validateDesignConfig(input: unknown): { value: PageDesign | null; error: string | null; paths?: string[] };
export function resolveDesign(raw: unknown): PageDesign | null;

// Types for signature-config.mjs, which the browser bundle imports too.

export type SignatureTemplate = 'classic' | 'stacked' | 'compact' | 'corporate' | 'banner' | 'sidebar' | 'minimal' | 'bold' | 'boxed' | 'modern' | 'custom';
export type SignatureFont = 'arial' | 'helvetica' | 'verdana' | 'tahoma' | 'trebuchet' | 'georgia' | 'times';
export type SignatureSize = 's' | 'm' | 'l';
export type SignatureImage = 'photo' | 'logo' | 'none';
export type SignatureShape = 'circle' | 'rounded' | 'square';
export type SignatureField = 'phone' | 'email' | 'website' | 'address';
export type SignatureLabels = 'none' | 'short' | 'full';
export type SignatureSocial = 'none' | 'text' | 'badges';
export type SignatureLang = 'tr' | 'en';
export type SignatureSocialKey = 'linkedin' | 'instagram' | 'whatsapp' | 'telegram';
export type SignatureSpacing = 'compact' | 'normal' | 'relaxed';

export interface SignatureDesign {
  v: 1;
  template: SignatureTemplate;
  font: SignatureFont;
  size: SignatureSize;
  /** null = the card's accent colour. */
  accent: string | null;
  image: SignatureImage;
  shape: SignatureShape;
  /** The organisation logo as a second image (where the layout has room). */
  logo: boolean;
  fields: SignatureField[];
  labels: SignatureLabels;
  social: SignatureSocial;
  qr: boolean;
  cta: boolean;
  /** '' = the default "My digital card" text in the signature's language. */
  ctaText: string;
  divider: boolean;
  disclaimer: string;
  /** Language of the words recipients read (labels, CTA), not of the panel. */
  lang: SignatureLang;
  /** A short line under the title (slogan, department…). */
  tagline: string;
  /** Which of the card's social profiles to show. */
  socials: SignatureSocialKey[];
  spacing: SignatureSpacing;
  nameColor: 'ink' | 'accent';
  /** One extra link: its text and its https target ('' = none). */
  extraLabel: string;
  extraUrl: string;
  /** Free-HTML template markup with {{tokens}} and {{#section}}…{{/section}}. */
  customHtml: string;
}

export const SIGNATURE_VERSION: 1;
export const SIGNATURE_MAX_BYTES: number;
export const SIGNATURE_TEMPLATES: SignatureTemplate[];
export const SIGNATURE_FONTS: SignatureFont[];
export const SIGNATURE_SIZES: SignatureSize[];
export const SIGNATURE_IMAGES: SignatureImage[];
export const SIGNATURE_SHAPES: SignatureShape[];
export const SIGNATURE_FIELDS: SignatureField[];
export const SIGNATURE_LABELS: SignatureLabels[];
export const SIGNATURE_SOCIAL: SignatureSocial[];
export const SIGNATURE_LANGS: SignatureLang[];
export const SIGNATURE_SOCIAL_KEYS: SignatureSocialKey[];
export const SIGNATURE_SPACING: SignatureSpacing[];
export const TAGLINE_MAX: number;
export const EXTRA_LABEL_MAX: number;
export const EXTRA_URL_MAX: number;
export const CTA_MAX: number;
export const DISCLAIMER_MAX: number;
export const SIGNATURE_PRESETS: Record<SignatureTemplate, Partial<SignatureDesign>>;

export function templateSignature(template?: SignatureTemplate, keep?: Partial<SignatureDesign>): SignatureDesign;
export function normalizeSignature(input: unknown): { value: SignatureDesign; errors: string[] };
export function validateSignatureConfig(input: unknown): { value: SignatureDesign | null; error: string | null; paths?: string[] };
export function resolveSignature(raw: unknown): SignatureDesign | null;

export type SignatureToken = 'photo' | 'logo' | 'qr' | 'name' | 'firstName' | 'lastName' | 'title' | 'organization' | 'phone' | 'phoneHref' | 'email' | 'emailHref' | 'website' | 'websiteUrl' | 'address' | 'cardUrl' | 'qrUrl' | 'photoUrl' | 'logoUrl' | 'accent' | 'linkedin' | 'instagram' | 'whatsapp' | 'telegram';
export const CUSTOM_HTML_MAX: number;
export const SIGNATURE_TOKENS: SignatureToken[];
export const CUSTOM_HTML_STARTER: string;
/** Why the free HTML is refused (code + offending piece), or null when it is fine. */
export function checkCustomHtml(html: unknown): { code: string; detail: string } | null;

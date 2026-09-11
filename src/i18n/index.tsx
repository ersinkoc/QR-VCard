import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { en } from './en';
import { tr } from './tr';
import type { Dict } from './tr';

export type Lang = 'tr' | 'en';
export const LANGS: readonly Lang[] = ['tr', 'en'];
export const dictionaries: Record<Lang, Dict> = { tr, en };

const STORAGE_KEY = 'qrv.lang';

export type Vars = Record<string, string | number>;
export type Translate = (key: string, vars?: Vars) => string;

export function lookup(dict: unknown, key: string): string | undefined {
  let node: unknown = dict;
  for (const part of key.split('.')) {
    if (node !== null && typeof node === 'object' && part in node) node = (node as Record<string, unknown>)[part];
    else return undefined;
  }
  return typeof node === 'string' ? node : undefined;
}

/** Falls back to Turkish, then to the key itself, so a gap never renders blank. */
export function translate(lang: Lang, key: string, vars?: Vars): string {
  const template = lookup(dictionaries[lang], key) ?? lookup(dictionaries.tr, key) ?? key;
  return vars ? template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : template;
}

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'tr' || saved === 'en') return saved;
  } catch {
    /* storage blocked: default below */
  }
  return 'tr';
}

interface I18n {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: Translate;
  formatDate: (iso: string | null) => string;
}

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* not persisted: fine */
    }
  }, []);

  const value = useMemo<I18n>(() => {
    const dateFormat = new Intl.DateTimeFormat(lang === 'tr' ? 'tr-TR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
    return {
      lang,
      setLang,
      t: (key, vars) => translate(lang, key, vars),
      formatDate: (iso) => (iso ? dateFormat.format(new Date(iso)) : ''),
    };
  }, [lang, setLang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}

/** A user-facing sentence for any thrown value, in the current language. */
export function errorText(t: Translate, err: unknown): string {
  if (err instanceof ApiError) {
    const key = `errors.${err.code}`;
    const text = t(key);
    return text === key ? t('errors.unknown') : text;
  }
  return t('errors.unknown');
}

/** Per-field messages from a VALIDATION (or similar) API error. */
export function fieldErrorTexts(t: Translate, err: unknown): Record<string, string> {
  if (!(err instanceof ApiError) || !err.fields) return {};
  const out: Record<string, string> = {};
  for (const [field, code] of Object.entries(err.fields)) {
    const key = `fieldErrors.${code}`;
    const text = t(key);
    out[field] = text === key ? t('fieldErrors.invalid') : text;
  }
  return out;
}

import { LANGS, useI18n } from '../i18n';

export default function LanguageSwitch({ className = '' }: { className?: string }) {
  const { lang, setLang, t } = useI18n();
  return (
    <div role="group" aria-label={t('common.language')} className={`inline-flex rounded-lg border border-line bg-surface p-0.5 text-xs font-medium ${className}`}>
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
          className={`h-8 min-w-9 rounded-md px-2 transition-colors ${lang === l ? 'bg-fg/10 text-fg' : 'text-muted hover:text-fg'}`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

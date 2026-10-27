import { LANGS, useI18n } from '../i18n';

export default function LanguageSwitch({ className = '', themed = false }: { className?: string; themed?: boolean }) {
  const { lang, setLang, t } = useI18n();
  return (
    <div
      role="group"
      aria-label={t('common.language')}
      className={`language-switch ${themed ? 'language-switch-themed' : 'border-line bg-surface'} inline-flex rounded-lg border p-0.5 text-xs font-medium ${className}`}
    >
      {LANGS.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={lang === l}
          onClick={() => setLang(l)}
          className={`language-option h-8 min-w-9 rounded-md px-2 transition-colors ${lang === l ? `is-active ${themed ? '' : 'bg-fg/10 text-fg'}` : (themed ? '' : 'text-muted hover:text-fg')}`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

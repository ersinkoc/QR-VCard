import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import LanguageSwitch from '../components/LanguageSwitch';
import { useI18n } from '../i18n';

export default function HomePage() {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const navigate = useNavigate();

  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center bg-bg px-4 page-pad">
      <LanguageSwitch className="absolute top-4 right-4" />
      <div className="w-full max-w-sm rise">
        <div className="text-center">
          <img src="/favicon.svg" alt="" width="48" height="48" className="mx-auto" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">{t('common.appName')}</h1>
          <p className="mt-2 text-sm text-muted">{t('home.tagline')}</p>
        </div>

        <div className="card mt-8 p-5">
          <Link to="/panel" className="btn btn-primary w-full">
            {t('home.openPanel')}
          </Link>

          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              const c = code.trim();
              if (c) navigate(`/c/${encodeURIComponent(c)}`);
            }}
          >
            <label className="label" htmlFor="code">
              {t('home.haveCode')}
            </label>
            <div className="flex gap-2">
              <input id="code" className="input font-mono" placeholder={t('home.codePlaceholder')} value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
              <button type="submit" className="btn btn-secondary">
                {t('home.open')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}

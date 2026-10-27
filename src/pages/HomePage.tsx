import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import LanguageSwitch from '../components/LanguageSwitch';
import BrandMark from '../components/BrandMark';
import { useI18n } from '../i18n';

export default function HomePage() {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const navigate = useNavigate();

  return (
    <main className="home-shell relative min-h-dvh overflow-hidden px-4 page-pad">
      <LanguageSwitch className="absolute top-4 right-4 z-20" />
      <div className="home-orbit home-orbit-one" aria-hidden="true" />
      <div className="home-orbit home-orbit-two" aria-hidden="true" />
      <div className="relative mx-auto grid min-h-[calc(100dvh-5rem)] w-full max-w-6xl items-center gap-12 lg:grid-cols-[1.08fr_.92fr]">
        <section className="rise max-w-2xl">
          <div className="flex items-center gap-3 text-sm font-bold tracking-[0.16em] uppercase">
            <BrandMark className="h-11 w-11 text-accent" />
            <span>{t('common.appName')}</span>
          </div>
          <p className="eyebrow mt-12">{t('home.eyebrow')}</p>
          <h1 className="home-title mt-4">{t('home.title')}</h1>
          <p className="mt-6 max-w-xl text-lg leading-8 text-muted">{t('home.tagline')}</p>
          <div className="mt-8 flex flex-wrap gap-2">
            <span className="proof-chip">{t('home.featureCards')}</span>
            <span className="proof-chip">{t('home.featureIdentity')}</span>
            <span className="proof-chip">{t('home.featureSignature')}</span>
          </div>
        </section>

        <div className="home-console rise rise-2">
          <div className="home-console-top">
            <span>IDENTITY / 01</span><span>READY</span>
          </div>
          <div className="p-6 sm:p-8">
            <div className="mb-7">
              <p className="text-xs font-bold tracking-[0.18em] text-accent uppercase">{t('home.consoleLabel')}</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight">{t('home.consoleTitle')}</p>
              <p className="mt-2 text-sm leading-6 text-muted">{t('home.consoleBody')}</p>
            </div>
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
      </div>
    </main>
  );
}

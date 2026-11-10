import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import Avatar from '../../components/Avatar';
import Icon from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import LanguageSwitch from '../../components/LanguageSwitch';
import BrandMark from '../../components/BrandMark';
import { errorText, useI18n } from '../../i18n';
import type { Me } from '../../lib/api';
import { displayName, fetchMe, login, logout, setUnauthenticatedHandler } from '../../lib/api';
import AccountView from './AccountView';
import AuditView from './AuditView';
import CardsView from './CardsView';
import InstitutionsView from './InstitutionsView';
import { SessionContext } from './session';
import UsersView from './UsersView';

function LoginScreen({ expired, onLoggedIn }: { expired: boolean; onLoggedIn: (me: Me) => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    document.title = `${t('auth.title')} · QR-VCard`;
  }, [t]);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await login(email.trim(), password));
    } catch (e) {
      setError(e);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-bg px-4 page-pad">
      <LanguageSwitch className="absolute top-4 right-4" />
      <div className="w-full max-w-sm rise">
        <div className="card p-6">
          <div className="flex items-center gap-3">
            <BrandMark className="h-9 w-9 text-accent" />
            <div>
              <h1 className="text-xl font-semibold tracking-tight">{t('auth.title')}</h1>
              <p className="text-sm text-muted">{t('auth.subtitle')}</p>
            </div>
          </div>
          {expired && !error && <p className="mt-4 rounded-lg bg-fg/5 p-3 text-sm">{t('auth.expired')}</p>}
          <form className="mt-5" onSubmit={onSubmit}>
            <label className="label" htmlFor="email">
              {t('auth.email')}
            </label>
            <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <label className="label mt-3" htmlFor="password">
              {t('auth.password')}
            </label>
            <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error !== null && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {errorText(t, error)}
              </p>
            )}
            <button type="submit" className="btn btn-primary mt-4 w-full" disabled={busy}>
              {busy ? t('auth.signingIn') : t('auth.signIn')}
            </button>
          </form>
          <p className="mt-4 text-center text-xs text-muted">{t('auth.noAccount')}</p>
        </div>
        <p className="mt-4 text-center text-sm">
          <Link to="/" className="text-muted hover:text-fg">
            ← {t('auth.backHome')}
          </Link>
        </p>
      </div>
    </main>
  );
}

/**
 * Desktop: a fixed sidebar (brand, sections with icons, the signed-in person
 * at the foot). Phones and tablets: a compact top bar whose sections scroll
 * sideways on one line instead of wrapping.
 */
function PanelLayout({ me, onSignOut, children }: { me: Me; onSignOut: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const admin = me.role === 'admin';
  const sections: { to: string; label: string; icon: IconName; end?: boolean }[] = [
    { to: '/panel', label: t('nav.cards'), icon: 'cards', end: true },
    ...(admin
      ? ([
          { to: '/panel/institutions', label: t('nav.institutions'), icon: 'building' },
          { to: '/panel/users', label: t('nav.users'), icon: 'users' },
          { to: '/panel/audit', label: t('nav.audit'), icon: 'history' },
        ] as const)
      : []),
    { to: '/panel/account', label: t('nav.account'), icon: 'user' },
  ];
  const side = ({ isActive }: { isActive: boolean }) =>
    `flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors ${isActive ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-fg/5 hover:text-fg'}`;
  const pill = ({ isActive }: { isActive: boolean }) =>
    `inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium whitespace-nowrap transition-colors ${isActive ? 'bg-accent/10 text-accent' : 'text-muted hover:text-fg'}`;
  const name = displayName(me) || me.email;

  return (
    <div className="min-h-dvh bg-bg lg:flex">
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface/70 px-4 py-5 lg:flex">
        <Link to="/panel" className="flex items-center gap-2.5 px-2 font-semibold tracking-tight">
          <BrandMark className="h-8 w-8 text-accent" />
          <span className="text-[15px]">QR-VCard</span>
        </Link>
        <nav className="mt-8 flex flex-col gap-1" aria-label="Panel">
          {sections.map((s) => (
            <NavLink key={s.to} to={s.to} end={s.end} className={side}>
              <Icon name={s.icon} />
              {s.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto space-y-3 border-t border-line pt-4">
          <div className="flex items-center gap-3 px-1">
            <Avatar name={name} size={36} />
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-medium">{name}</p>
              <p className="text-xs text-muted">{t(`roles.${me.role}`)}</p>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <LanguageSwitch />
            <button type="button" className="btn btn-ghost btn-sm" onClick={onSignOut}>
              <Icon name="logout" size={16} />
              {t('auth.signOut')}
            </button>
          </div>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur lg:hidden" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
          <div className="flex items-center gap-3 px-4 pt-3">
            <Link to="/panel" className="flex items-center gap-2 font-semibold tracking-tight">
              <BrandMark className="h-7 w-7 text-accent" />
              <span>QR-VCard</span>
            </Link>
            <div className="ml-auto flex items-center gap-2">
              <LanguageSwitch />
              <button type="button" className="btn btn-ghost btn-sm px-2.5" onClick={onSignOut} aria-label={t('auth.signOut')} title={t('auth.signOut')}>
                <Icon name="logout" />
              </button>
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 py-2 [scrollbar-width:none]" aria-label="Panel">
            {sections.map((s) => (
              <NavLink key={s.to} to={s.to} end={s.end} className={pill}>
                <Icon name={s.icon} size={16} />
                {s.label}
              </NavLink>
            ))}
          </nav>
        </header>
        <main className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6 lg:px-10 lg:pt-10" style={{ paddingBottom: 'max(3rem, env(safe-area-inset-bottom))' }}>
          {children}
        </main>
      </div>
    </div>
  );
}

export default function PanelPage() {
  const { t } = useI18n();
  const [state, setState] = useState<'checking' | 'login' | 'ready' | 'error'>('checking');
  const [me, setMe] = useState<Me | null>(null);
  const [expired, setExpired] = useState(false);
  const [bootError, setBootError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchMe()
      .then((m) => {
        if (!alive) return;
        setMe(m);
        setState(m ? 'ready' : 'login');
      })
      .catch((err) => {
        if (!alive) return;
        setBootError(err);
        setState('error');
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  // Any 401 from a panel call means the session ended (expired, suspended, or a
  // password change elsewhere): drop back to sign-in and say why.
  useEffect(() => {
    setUnauthenticatedHandler(() => {
      setMe(null);
      setExpired(true);
      setState('login');
    });
    return () => setUnauthenticatedHandler(null);
  }, []);

  const signOut = useCallback(async () => {
    await logout().catch(() => {});
    setMe(null);
    setExpired(false);
    setState('login');
  }, []);

  const session = useMemo(() => (me ? { me, setMe, signOut } : null), [me, signOut]);

  if (state === 'checking') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg px-4">
        <p className="text-muted">{t('auth.checking')}</p>
      </main>
    );
  }

  if (state === 'error') {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg px-4">
        <div className="card max-w-sm p-6 text-center">
          <p className="font-semibold tracking-tight">{t('auth.bootFailed')}</p>
          <p className="mt-2 text-sm text-muted">{errorText(t, bootError)}</p>
          <button
            type="button"
            className="btn btn-secondary mt-4"
            onClick={() => {
              setState('checking');
              setAttempt((n) => n + 1);
            }}
          >
            {t('common.retry')}
          </button>
        </div>
      </main>
    );
  }

  if (state === 'login' || !session) {
    return (
      <LoginScreen
        expired={expired}
        onLoggedIn={(m) => {
          setMe(m);
          setExpired(false);
          setState('ready');
        }}
      />
    );
  }

  return (
    <SessionContext.Provider value={session}>
      <PanelLayout me={session.me} onSignOut={() => void signOut()}>
        <Routes>
          <Route index element={<CardsView />} />
          <Route path="institutions" element={session.me.role === 'admin' ? <InstitutionsView /> : <Navigate to="/panel" replace />} />
          <Route path="users" element={session.me.role === 'admin' ? <UsersView /> : <Navigate to="/panel" replace />} />
          <Route path="audit" element={session.me.role === 'admin' ? <AuditView /> : <Navigate to="/panel" replace />} />
          <Route path="account" element={<AccountView />} />
          <Route path="*" element={<Navigate to="/panel" replace />} />
        </Routes>
      </PanelLayout>
    </SessionContext.Provider>
  );
}

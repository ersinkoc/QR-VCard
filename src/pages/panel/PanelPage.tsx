import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import LanguageSwitch from '../../components/LanguageSwitch';
import { errorText, useI18n } from '../../i18n';
import type { Me } from '../../lib/api';
import { displayName, fetchMe, login, logout, setUnauthenticatedHandler } from '../../lib/api';
import AccountView from './AccountView';
import AuditView from './AuditView';
import CardsView from './CardsView';
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
            <img src="/favicon.svg" alt="" width="36" height="36" />
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

function PanelLayout({ me, onSignOut, children }: { me: Me; onSignOut: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const tab = ({ isActive }: { isActive: boolean }) =>
    `inline-flex h-9 items-center rounded-lg px-3 text-sm font-medium transition-colors ${isActive ? 'bg-fg/10 text-fg' : 'text-muted hover:text-fg'}`;

  return (
    <div className="min-h-dvh bg-bg">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link to="/panel" className="flex items-center gap-2 font-semibold tracking-tight">
            <img src="/favicon.svg" alt="" width="26" height="26" />
            <span>QR-VCard</span>
          </Link>
          <nav className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto" aria-label="Panel">
            <NavLink to="/panel" end className={tab}>
              {t('nav.cards')}
            </NavLink>
            {me.role === 'admin' && (
              <NavLink to="/panel/users" className={tab}>
                {t('nav.users')}
              </NavLink>
            )}
            {me.role === 'admin' && (
              <NavLink to="/panel/audit" className={tab}>
                {t('nav.audit')}
              </NavLink>
            )}
            <NavLink to="/panel/account" className={tab}>
              {t('nav.account')}
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <div className="hidden text-right leading-tight md:block">
              <p className="max-w-48 truncate text-sm font-medium">{displayName(me) || me.email}</p>
              <p className="text-xs text-muted">{t(`roles.${me.role}`)}</p>
            </div>
            <LanguageSwitch />
            <button type="button" className="btn btn-ghost btn-sm" onClick={onSignOut}>
              {t('auth.signOut')}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 pt-6" style={{ paddingBottom: 'max(3rem, env(safe-area-inset-bottom))' }}>
        {children}
      </main>
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
          <Route path="users" element={session.me.role === 'admin' ? <UsersView /> : <Navigate to="/panel" replace />} />
          <Route path="audit" element={session.me.role === 'admin' ? <AuditView /> : <Navigate to="/panel" replace />} />
          <Route path="account" element={<AccountView />} />
          <Route path="*" element={<Navigate to="/panel" replace />} />
        </Routes>
      </PanelLayout>
    </SessionContext.Provider>
  );
}

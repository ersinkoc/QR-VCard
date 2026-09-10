import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import CopyButton from '../components/CopyButton';
import QrDisplay from '../components/QrDisplay';
import VCardForm from '../components/VCardForm';
import type { MeInfo, PanelUser, VCard } from '../lib/directus';
import {
  createPanelUser,
  deleteCard,
  fetchMe,
  listAssignableRoles,
  listCards,
  listPanelUsers,
  login,
  logout,
  setPanelUserPassword,
  shortUrl,
  updateCard,
} from '../lib/directus';
import { isPrivileged, ownerLabel } from '../lib/ownership';
import { downloadQr } from '../lib/qr';

function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      onLoggedIn();
    } catch {
      setError('Login failed. Check the email and password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mx-auto max-w-sm p-6">
      <div className="flex items-center gap-3">
        <img src="/favicon.svg" alt="" width="36" height="36" />
        <h1 className="text-xl font-semibold tracking-tight">Panel sign-in</h1>
      </div>
      <form className="mt-5" onSubmit={onSubmit}>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label className="label mt-3" htmlFor="password">
          Password
        </label>
        <input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        <button type="submit" className="btn btn-primary mt-4 w-full" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function QrModal({ card, onClose }: { card: VCard; onClose: () => void }) {
  const url = shortUrl(card.code);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // qrUrl() rejects when the proxy is unconfigured, unreachable, or returns a
  // non-image; without this the button would fail silently and leave an
  // unhandled rejection behind.
  async function onDownload() {
    setDownloadError(null);
    try {
      await downloadQr(url, `qr-${card.code}.png`);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'QR download failed.');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card bg-surface p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-center text-lg font-semibold tracking-tight">QR · {card.code}</h3>
        <QrDisplay data={url} size={280} />
        <p className="code mt-4 text-center text-muted">{url}</p>
        <div className="mt-4 flex justify-center gap-2">
          <CopyButton text={url} />
          <button type="button" className="btn btn-secondary" onClick={() => void onDownload()}>
            Download
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        {downloadError && <p className="mt-3 text-center text-sm text-red-600">{downloadError}</p>}
      </div>
    </div>
  );
}

/**
 * User administration. Rendered for privileged roles only, and the Directus
 * permissions behind these calls are themselves Administrator-only, so a
 * non-admin who reaches this UI still cannot create users.
 */
function UsersPanel() {
  const [users, setUsers] = useState<PanelUser[] | null>(null);
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState('');

  const load = useCallback(async () => {
    try {
      const [list, assignable] = await Promise.all([listPanelUsers(), listAssignableRoles()]);
      setUsers(list);
      setRoles(assignable);
      if (assignable.length === 0) {
        // Otherwise the form is silently inert: no <option> to pick and the
        // submit button stays disabled with nothing explaining why.
        setError('No assignable roles were returned — provision vcard-user or vcard-editor in Directus first.');
        return;
      }
      setRoleId((current) => current || assignable.find((r) => r.name === 'vcard-user')?.id || assignable[0]?.id || '');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await createPanelUser({ email: email.trim(), password, first_name: firstName.trim(), roleId });
      setEmail('');
      setFirstName('');
      setPassword('');
      setNotice('User created. They can sign in with the password you set.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onSetPassword(userId: string) {
    setError(null);
    setNotice(null);
    try {
      await setPanelUserPassword(userId, resetPassword);
      setResetFor(null);
      setResetPassword('');
      setNotice('Password updated.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="card mt-8 p-5">
      <h2 className="text-lg font-semibold tracking-tight">Users</h2>
      <p className="mt-1 text-sm text-muted">
        Create an account per person. Each one signs in with their own password and manages only their own cards.
      </p>

      {users === null ? (
        <p className="mt-4 text-muted">Loading users…</p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--color-line)]">
          {users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium tracking-tight">{u.email}</p>
                <p className="text-sm text-muted">
                  {[u.first_name, u.last_name].filter(Boolean).join(' ') || '—'} · {u.role_name} · {u.status}
                </p>
              </div>
              {resetFor === u.id ? (
                <div className="flex items-center gap-2">
                  <input
                    className="input w-48"
                    type="password"
                    placeholder="New password"
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                  <button type="button" className="btn btn-primary" disabled={resetPassword.length < 8} onClick={() => void onSetPassword(u.id)}>
                    Save
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setResetFor(null);
                      setResetPassword('');
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button type="button" className="btn btn-secondary" onClick={() => setResetFor(u.id)}>
                  Set password
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form className="mt-6 border-t border-line pt-5" onSubmit={onCreate}>
        <h3 className="font-medium tracking-tight">New user</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="new-user-email">
              Email
            </label>
            <input id="new-user-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label" htmlFor="new-user-name">
              First name
            </label>
            <input id="new-user-name" className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="new-user-role">
              Role
            </label>
            <select id="new-user-role" className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="label mt-3" htmlFor="new-user-password">
          Initial password (at least 8 characters)
        </label>
        <input
          id="new-user-password"
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
        />
        <button type="submit" className="btn btn-primary mt-3" disabled={busy || password.length < 8 || !roleId}>
          {busy ? 'Creating…' : 'Create user'}
        </button>
      </form>

      {notice && <p className="mt-3 text-sm text-muted">{notice}</p>}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </section>
  );
}

export default function PanelPage() {
  // checking -> login | ready
  const [authState, setAuthState] = useState<'checking' | 'login' | 'ready'>('checking');
  const [me, setMe] = useState<MeInfo | null>(null);
  const [cards, setCards] = useState<VCard[] | null>(null);
  const [editing, setEditing] = useState<'new' | VCard | null>(null);
  const [qrCard, setQrCard] = useState<VCard | null>(null);
  const [assignableUsers, setAssignableUsers] = useState<PanelUser[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadMe = useCallback(async () => {
    try {
      const m = await fetchMe();
      setMe(m);
      setAuthState('ready');
    } catch {
      setAuthState('login');
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const loadCards = useCallback(async () => {
    if (!me) return;
    try {
      setCards(await listCards(me));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [me]);

  useEffect(() => {
    void loadCards();
  }, [loadCards]);

  // Only Administrators may read accounts — Directus gates /users to admins, so
  // editors skip this request entirely instead of collecting 403s. The
  // create-for-others picker stays hidden for them because the list stays empty.
  useEffect(() => {
    if (!me || me.role_name !== 'Administrator') return;
    void listPanelUsers()
      .then(setAssignableUsers)
      .catch(() => setAssignableUsers([]));
  }, [me]);

  /** Every card mutation goes through the ownership guard in the adapter. */
  async function mutate(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await loadCards();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (authState === 'checking') {
    return <main className="flex min-h-dvh items-center justify-center bg-bg px-4"><p className="text-muted">Checking session…</p></main>;
  }

  if (authState === 'login' || me === null) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-bg px-4">
        <LoginForm
          onLoggedIn={() => {
            void loadMe();
          }}
        />
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-bg px-4 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Your cards</h1>
            <p className="text-sm text-muted">
              {me.email} · {isPrivileged(me) ? 'can see every card' : 'sees only own cards'}
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
              New card
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={async () => {
                await logout();
                setMe(null);
                setCards(null);
                setAuthState('login');
              }}
            >
              Sign out
            </button>
          </div>
        </div>

        {editing && (
          <div className="mt-6">
            <VCardForm
              key={editing === 'new' ? 'new' : editing.id}
              me={me}
              ownerOptions={isPrivileged(me) ? assignableUsers.map((u) => ({ id: u.id, email: u.email })) : undefined}
              initial={editing === 'new' ? null : editing}
              onCancel={() => setEditing(null)}
              onSaved={() => {
                setEditing(null);
                void loadCards();
              }}
            />
          </div>
        )}

        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

        <div className="mt-6">
          {cards === null ? (
            <p className="text-muted">Loading cards…</p>
          ) : cards.length === 0 ? (
            <div className="card p-8 text-center text-sm text-muted">
              No cards yet — create your first one.
            </div>
          ) : (
            <ul className="card divide-y divide-[var(--color-line)]">
              {cards.map((card) => {
                const name = [card.first_name, card.last_name].filter(Boolean).join(' ').trim() || card.code;
                const url = shortUrl(card.code);
                return (
                  <li key={card.id} className="flex flex-wrap items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium tracking-tight">
                        {name}
                        {card.status === 'draft' && <span className="ml-2 rounded-full border border-line px-2 py-0.5 text-xs text-muted">draft</span>}
                      </p>
                      <p className="code truncate text-muted">{url}</p>
                      {isPrivileged(me) && <p className="text-xs text-muted">owner: {ownerLabel(card, me)}</p>}
                    </div>
                    <CopyButton text={url} label="Copy URL" />
                    <button type="button" className="btn btn-secondary" onClick={() => setQrCard(card)}>
                      QR
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void mutate(() => updateCard(me, card, { status: card.status === 'published' ? 'draft' : 'published' }))}
                    >
                      {card.status === 'published' ? 'Unpublish' : 'Publish'}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setEditing(card)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost text-red-600"
                      onClick={() => {
                        if (!window.confirm(`Delete card “${name}”?`)) return;
                        void mutate(() => deleteCard(me, card));
                      }}
                    >
                      Delete
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* User administration is Administrator-only in Directus: editors are
            privileged for cards, but every users call 403s for them. */}
        {me.role_name === 'Administrator' && <UsersPanel />}
      </div>

      {qrCard && <QrModal card={qrCard} onClose={() => setQrCard(null)} />}
    </main>
  );
}

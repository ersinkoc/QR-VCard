import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import CopyButton from '../components/CopyButton';
import QrDisplay from '../components/QrDisplay';
import VCardForm from '../components/VCardForm';
import type { MeInfo, VCard } from '../lib/directus';
import { deleteCard, fetchMe, isPrivileged, listCards, login, logout, shortUrl, updateCard } from '../lib/directus';
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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="card bg-surface p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 text-center text-lg font-semibold tracking-tight">QR · {card.code}</h3>
        <QrDisplay data={url} size={280} />
        <p className="code mt-4 text-center text-muted">{url}</p>
        <div className="mt-4 flex justify-center gap-2">
          <CopyButton text={url} />
          <button type="button" className="btn btn-secondary" onClick={() => void downloadQr(url, `qr-${card.code}.png`)}>
            Download
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PanelPage() {
  // checking -> login | ready
  const [authState, setAuthState] = useState<'checking' | 'login' | 'ready'>('checking');
  const [me, setMe] = useState<MeInfo | null>(null);
  const [cards, setCards] = useState<VCard[] | null>(null);
  const [editing, setEditing] = useState<'new' | VCard | null>(null);
  const [qrCard, setQrCard] = useState<VCard | null>(null);
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
                    </div>
                    <CopyButton text={url} label="Copy URL" />
                    <button type="button" className="btn btn-secondary" onClick={() => setQrCard(card)}>
                      QR
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={async () => {
                        await updateCard(card.id, { status: card.status === 'published' ? 'draft' : 'published' });
                        void loadCards();
                      }}
                    >
                      {card.status === 'published' ? 'Unpublish' : 'Publish'}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setEditing(card)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost text-red-600"
                      onClick={async () => {
                        if (!window.confirm(`Delete card “${name}”?`)) return;
                        await deleteCard(card.id);
                        void loadCards();
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
      </div>

      {qrCard && <QrModal card={qrCard} onClose={() => setQrCard(null)} />}
    </main>
  );
}

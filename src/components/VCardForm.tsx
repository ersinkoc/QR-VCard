import { useState } from 'react';
import type { FormEvent } from 'react';
import type { MeInfo, VCard } from '../lib/directus';
import { createCard, updateCard } from '../lib/directus';
import { generateCode } from '../lib/short-code';

const ACCENTS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777'];

interface Props {
  me: MeInfo; // the signed-in actor; the adapter checks card ownership against it
  initial: VCard | null; // null = create
  /** Present for admins: create the card on behalf of one of these accounts. */
  ownerOptions?: { id: string; email: string }[];
  onCancel: () => void;
  onSaved: (card: VCard) => void;
}

type FieldKey = 'first_name' | 'last_name' | 'organization' | 'job_title' | 'phone' | 'email' | 'website' | 'address' | 'note';
const FIELDS: { key: FieldKey; label: string; placeholder: string; half?: boolean }[] = [
  { key: 'first_name', label: 'First name', placeholder: 'Ada', half: true },
  { key: 'last_name', label: 'Last name', placeholder: 'Lovelace', half: true },
  { key: 'organization', label: 'Organization', placeholder: 'Analytical Engines Ltd', half: true },
  { key: 'job_title', label: 'Job title', placeholder: 'Chief Mathematician', half: true },
  { key: 'phone', label: 'Phone', placeholder: '+90 555 000 00 00', half: true },
  { key: 'email', label: 'Email', placeholder: 'ada@example.com', half: true },
  { key: 'website', label: 'Website', placeholder: 'https://example.com' },
  { key: 'address', label: 'Address', placeholder: '12 St James’s Square, London' },
  { key: 'note', label: 'Note', placeholder: 'Anything you want visitors to read' },
];

export default function VCardForm({ me, initial, ownerOptions, onCancel, onSaved }: Props) {
  const [values, setValues] = useState<Record<FieldKey, string>>(() =>
    Object.fromEntries(FIELDS.map(({ key }) => [key, (initial?.[key] as string | null) ?? ''])) as Record<FieldKey, string>,
  );
  const [accent, setAccent] = useState(initial?.accent_color ?? ACCENTS[0]!);
  const [status, setStatus] = useState<'draft' | 'published'>(initial?.status ?? 'draft');
  // '' means "keep it mine" — the adapter omits user_created then.
  const [ownerId, setOwnerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: FieldKey) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value }));

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: Partial<VCard> = { ...values, accent_color: accent, status };
      const saved = initial
        ? await updateCard(me, initial, payload)
        : await createCard(me, { ...payload, code: generateCode() }, ownerId || undefined);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card rise p-5">
      <h2 className="text-lg font-semibold tracking-tight">{initial ? 'Edit card' : 'New card'}</h2>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {FIELDS.map(({ key, label, placeholder, half }) => (
          <div key={key} className={half ? '' : 'sm:col-span-2'}>
            <label className="label" htmlFor={`f-${key}`}>
              {label}
            </label>
            {key === 'address' || key === 'note' ? (
              <textarea id={`f-${key}`} className="input min-h-20" placeholder={placeholder} value={values[key]} onChange={set(key)} />
            ) : (
              <input id={`f-${key}`} className="input" type={key === 'email' ? 'email' : 'text'} placeholder={placeholder} value={values[key]} onChange={set(key)} />
            )}
          </div>
        ))}

        <div>
          <span className="label">Accent color</span>
          <div className="flex items-center gap-2">
            {ACCENTS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Accent ${c}`}
                onClick={() => setAccent(c)}
                className={`h-7 w-7 rounded-full border-2 ${accent === c ? 'border-fg' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div>
          <label className="label" htmlFor="f-status">
            Status
          </label>
          <select id="f-status" className="input" value={status} onChange={(e) => setStatus(e.target.value === 'published' ? 'published' : 'draft')}>
            <option value="draft">Draft (only panel can see)</option>
            <option value="published">Published (QR page live)</option>
          </select>
        </div>

        {!initial && ownerOptions && ownerOptions.length > 0 && (
          <div>
            <label className="label" htmlFor="f-owner">
              Owner (create on behalf of)
            </label>
            <select id="f-owner" className="input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">Me ({me.email})</option>
              {ownerOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {initial && (
        <p className="code mt-3 text-muted">
          Short URL: {window.location.origin}/c/{initial.code}
        </p>
      )}

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save card'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

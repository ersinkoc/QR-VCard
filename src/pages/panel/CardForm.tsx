import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import Avatar from '../../components/Avatar';
import Field from '../../components/Field';
import { errorText, fieldErrorTexts, isApiError, useI18n } from '../../i18n';
import type { AdminUser, Card, CardInput } from '../../lib/api';
import { cardPhotoUrl, createCard, deleteCardPhoto, displayName, listUsers, shortUrl, updateCard, uploadCardPhoto } from '../../lib/api';
import { shrinkImage } from '../../lib/image';
import { useSession } from './session';

const ACCENTS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#db2777', '#18181b'];

type FieldKey = 'first_name' | 'last_name' | 'organization' | 'job_title' | 'phone' | 'email' | 'website' | 'linkedin' | 'instagram' | 'whatsapp' | 'telegram' | 'address' | 'note';

const INPUTS: Record<FieldKey, { type?: string; inputMode?: 'tel' | 'email' | 'url'; autoComplete?: string; multiline?: boolean; wide?: boolean; placeholder?: string }> = {
  first_name: { autoComplete: 'given-name' },
  last_name: { autoComplete: 'family-name' },
  organization: { autoComplete: 'organization' },
  job_title: { autoComplete: 'organization-title' },
  phone: { type: 'tel', inputMode: 'tel', autoComplete: 'tel', placeholder: '+90 555 000 00 00' },
  email: { type: 'email', inputMode: 'email', autoComplete: 'email', placeholder: 'ad@ornek.com' },
  // type=text: type=url would reject "example.com", which the server accepts and
  // normalises to https://example.com.
  website: { inputMode: 'url', autoComplete: 'url', wide: true, placeholder: 'ornek.com' },
  // The server accepts a full URL or a bare handle and stores the canonical
  // https profile link; placeholders teach that at a glance.
  linkedin: { inputMode: 'url', placeholder: 'linkedin.com/in/ada' },
  instagram: { inputMode: 'url', placeholder: '@ada' },
  whatsapp: { type: 'tel', inputMode: 'tel', placeholder: '+90 555 000 00 00' },
  telegram: { inputMode: 'url', placeholder: '@ada' },
  address: { multiline: true, wide: true },
  note: { multiline: true, wide: true },
};

const SECTIONS: { title: string; fields: FieldKey[] }[] = [
  { title: 'form.sectionPerson', fields: ['first_name', 'last_name', 'organization', 'job_title'] },
  { title: 'form.sectionContact', fields: ['phone', 'email', 'website'] },
  { title: 'form.sectionSocial', fields: ['linkedin', 'instagram', 'whatsapp', 'telegram'] },
  { title: 'form.sectionContact', fields: ['address', 'note'] },
];

export default function CardForm({ initial, onCancel, onSaved }: { initial: Card | null; onCancel: () => void; onSaved: (card: Card, warning?: unknown) => void }) {
  const { me } = useSession();
  const { t } = useI18n();
  const uid = useId();
  const isAdmin = me.role === 'admin';

  const [values, setValues] = useState<Record<FieldKey, string>>(
    () => Object.fromEntries((Object.keys(INPUTS) as FieldKey[]).map((k) => [k, initial?.[k] ?? ''])) as Record<FieldKey, string>,
  );
  const [accent, setAccent] = useState(initial?.accent_color ?? ACCENTS[0]!);
  const [status, setStatus] = useState<Card['status']>(initial?.status ?? 'draft');
  const [code, setCode] = useState('');
  const [ownerId, setOwnerId] = useState(initial?.owner?.id ?? '');
  const [owners, setOwners] = useState<AdminUser[]>([]);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [photoStyle, setPhotoStyle] = useState<'avatar' | 'logo'>(initial?.photo_style === 'logo' ? 'logo' : 'avatar');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!isAdmin) return;
    listUsers()
      .then(setOwners)
      .catch(() => setOwners([]));
  }, [isAdmin]);

  useEffect(() => {
    if (!photoFile) {
      setPhotoPreview(null);
      return;
    }
    const url = URL.createObjectURL(photoFile);
    setPhotoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [photoFile]);

  const fieldErrors = fieldErrorTexts(t, error);
  const shownPhoto = photoPreview ?? (!removePhoto && initial ? cardPhotoUrl(initial) : null);
  const previewName = displayName({ first_name: values.first_name || null, last_name: values.last_name || null }) || values.organization || '—';

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    let saved: Card | null = null;
    try {
      const payload: CardInput = { ...values, accent_color: accent, status, photo_style: photoStyle };
      if (initial) {
        if (isAdmin && ownerId && ownerId !== initial.owner?.id) payload.owner_id = ownerId;
        saved = await updateCard(initial.id, payload);
      } else {
        if (code.trim()) payload.code = code.trim();
        if (isAdmin && ownerId && ownerId !== me.id) payload.owner_id = ownerId;
        saved = await createCard(payload);
      }
    } catch (e) {
      setError(e);
      setBusy(false);
      return;
    }
    // The card itself is saved; a photo failure must not make the form look
    // unsaved (a retry would create a duplicate card).
    try {
      if (photoFile) saved = await uploadCardPhoto(saved.id, await shrinkImage(photoFile));
      else if (removePhoto && saved.photo) saved = await deleteCardPhoto(saved.id);
      onSaved(saved);
    } catch (e) {
      onSaved(saved, e);
    } finally {
      setBusy(false);
    }
  }

  const id = (k: string) => `${uid}-${k}`;

  return (
    <form onSubmit={onSubmit} className="card rise p-5" noValidate>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{initial ? t('form.editTitle') : t('form.newTitle')}</h2>
        {initial && <span className="code text-xs text-muted">{initial.code}</span>}
      </div>

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_15rem]">
        <div className="space-y-6">
          {SECTIONS.map((section) => (
            <fieldset key={section.title}>
              <legend className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{t(section.title)}</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {section.fields.map((key) => {
                  const spec = INPUTS[key];
                  const err = fieldErrors[key];
                  const common = {
                    id: id(key),
                    className: 'input',
                    value: values[key],
                    'aria-invalid': err ? true : undefined,
                    'aria-describedby': err ? `${id(key)}-msg` : undefined,
                    onChange: (e: { target: { value: string } }) => setValues((v) => ({ ...v, [key]: e.target.value })),
                  };
                  return (
                    <Field key={key} id={id(key)} label={t(`form.${key}`)} error={err} className={spec.wide ? 'sm:col-span-2' : ''}>
                      {spec.multiline ? (
                        <textarea {...common} className="input min-h-20" placeholder={key === 'note' ? t('form.notePlaceholder') : t('form.addressPlaceholder')} />
                      ) : (
                        <input {...common} type={spec.type ?? 'text'} inputMode={spec.inputMode} autoComplete={spec.autoComplete} placeholder={spec.placeholder} />
                      )}
                    </Field>
                  );
                })}
              </div>
            </fieldset>
          ))}

          <fieldset>
            <legend className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">{t('form.sectionCard')}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={id('status')} label={t('form.status')}>
                <select id={id('status')} className="input" value={status} onChange={(e) => setStatus(e.target.value === 'published' ? 'published' : 'draft')}>
                  <option value="draft">{t('form.statusDraft')}</option>
                  <option value="published">{t('form.statusPublished')}</option>
                </select>
              </Field>

              {initial ? (
                <Field id={id('code')} label={t('form.shortUrl')} hint={t('form.codeFixed')}>
                  <input id={id('code')} className="input code text-muted" value={shortUrl(initial.code)} readOnly />
                </Field>
              ) : (
                <Field id={id('code')} label={`${t('form.code')} (${t('common.optional')})`} error={fieldErrors.code} hint={t('form.codeHint')}>
                  <input
                    id={id('code')}
                    className="input code"
                    value={code}
                    placeholder={t('form.codePlaceholder')}
                    onChange={(e) => setCode(e.target.value.replace(/\s+/g, '-'))}
                    aria-invalid={fieldErrors.code ? true : undefined}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={32}
                  />
                </Field>
              )}

              {isAdmin && owners.length > 0 && (
                <Field id={id('owner')} label={t('form.owner')} error={fieldErrors.owner_id}>
                  <select id={id('owner')} className="input" value={ownerId || (initial ? '' : me.id)} onChange={(e) => setOwnerId(e.target.value)}>
                    {initial && !initial.owner && <option value="">—</option>}
                    {owners.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.id === me.id ? t('form.ownerMe', { email: u.email }) : displayName(u) ? `${displayName(u)} · ${u.email}` : u.email}
                      </option>
                    ))}
                  </select>
                </Field>
              )}

              <div className="sm:col-span-2">
                <span className="label">{t('form.accent')}</span>
                <div className="flex flex-wrap items-center gap-2">
                  {ACCENTS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={c}
                      aria-pressed={accent === c}
                      onClick={() => setAccent(c)}
                      className={`h-8 w-8 rounded-full border-2 transition-transform ${accent === c ? 'scale-110 border-fg' : 'border-transparent'}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <label className="ml-1 inline-flex items-center gap-2 text-sm text-muted">
                    <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} className="h-8 w-10 cursor-pointer rounded border border-line bg-surface" />
                    {t('form.customColor')}
                  </label>
                </div>
              </div>
            </div>
          </fieldset>
        </div>

        {/* Photo + live preview of how the visitor will see the card header. */}
        <aside className="space-y-3">
          <span className="label">{t('form.photo')}</span>
          <div className="overflow-hidden rounded-xl border border-line bg-bg">
            <div className="h-12" style={{ background: `linear-gradient(120deg, ${accent}, color-mix(in oklab, ${accent} 45%, white))` }} />
            <div className="px-4 pb-4">
              <div className={`-mt-7 inline-block border-4 border-bg ${photoStyle === 'logo' ? 'rounded-2xl' : 'rounded-full'}`}>
                <Avatar name={previewName} photoUrl={shownPhoto} accent={accent} logo={photoStyle === 'logo'} size={60} />
              </div>
              <p className="mt-1 truncate font-medium tracking-tight">{previewName}</p>
              <p className="truncate text-xs text-muted">{[values.job_title, values.organization].filter(Boolean).join(' · ') || t('form.preview')}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="btn btn-secondary btn-sm cursor-pointer">
              {shownPhoto ? t('form.photoChange') : t('form.photoChoose')}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  setPhotoFile(file);
                  if (file) setRemovePhoto(false);
                  e.target.value = '';
                }}
              />
            </label>
            {shownPhoto && (
              <button
                type="button"
                className="btn btn-ghost btn-sm text-danger"
                onClick={() => {
                  setPhotoFile(null);
                  setRemovePhoto(true);
                }}
              >
                {t('form.photoRemove')}
              </button>
            )}
          </div>
          <p className="text-xs text-muted">{t('form.photoHint')}</p>
          <fieldset>
            <legend className="label">{t('form.photoStyle')}</legend>
            <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-xs font-medium">
              {(['avatar', 'logo'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={photoStyle === s}
                  onClick={() => setPhotoStyle(s)}
                  className={`h-8 rounded-md px-3 ${photoStyle === s ? 'bg-fg/10 text-fg' : 'text-muted hover:text-fg'}`}
                >
                  {s === 'avatar' ? t('form.photoStyleAvatar') : t('form.photoStyleLogo')}
                </button>
              ))}
            </div>
          </fieldset>
        </aside>
      </div>

      {error !== null && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {isApiError(error) && error.code === 'CARD_LIMIT' ? t('errors.CARD_LIMIT', { max: error.fields?.max ?? 20 }) : errorText(t, error)}
        </p>
      )}

      <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? t('common.saving') : t('form.saveCard')}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}

import { useEffect, useId, useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import CardIdentity from '../../components/CardIdentity';
import Field from '../../components/Field';
import PagePreview from '../../components/page/PagePreview';
import { errorText, fieldErrorTexts, isApiError, useI18n } from '../../i18n';
import type { AdminUser, Card, CardDesign, CardInput, Institution, PublicCard } from '../../lib/api';
import { cardBackgroundUrl, cardLogoUrl, cardPhotoUrl, createCard, deleteCardBackground, deleteCardLogo, deleteCardPhoto, displayName, institutionLogoUrl, listInstitutions, listUsers, shortUrl, updateCard, uploadCardBackground, uploadCardPhoto } from '../../lib/api';
import { withInstitution } from '../../lib/card-view';
import { shrinkImage } from '../../lib/image';
import { formatFamilyName, formatGivenName } from '../../../server/person-name.mjs';
import { CARD_DESIGNS } from '../../lib/card-designs';
import type { PageDesign } from '../../lib/page-design';
import { resolveDesign, templateDesign } from '../../lib/page-design';
import DesignStudio, { withHeaderTag } from './DesignStudio';
import type { StudioBackground } from './DesignStudio';
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
  // Logos come from the linked institution; a card's own (legacy) logo can
  // only be removed here, no longer replaced.
  const [removeLogo, setRemoveLogo] = useState(false);
  const [institutions, setInstitutions] = useState<Institution[] | null>(null);
  const [institutionId, setInstitutionId] = useState(initial?.institution?.id ?? '');
  const [addressCopied, setAddressCopied] = useState(false);
  const [photoStyle, setPhotoStyle] = useState<'avatar' | 'logo'>(initial?.photo_style === 'logo' ? 'logo' : 'avatar');
  const [designStyle, setDesignStyle] = useState<CardDesign>(initial?.design_style ?? 'executive');
  // The page designer is THE way cards are designed: new cards start on a
  // page template. The ready-made classic skins stay only for cards that
  // already use them (their published look must not change on its own).
  // The page document is kept in memory while classic is selected, so
  // switching back and forth never loses work; it is saved only in page mode.
  const [designMode, setDesignMode] = useState<'classic' | 'page'>(initial && !initial.design_config ? 'classic' : 'page');
  const [pageDesign, setPageDesign] = useState<PageDesign | null>(() => resolveDesign(initial?.design_config) ?? (initial ? null : withHeaderTag(templateDesign('porcelain'), null, t('page.headerTag'))));
  const [studioOpen, setStudioOpen] = useState(false);
  const [backgroundFile, setBackgroundFile] = useState<File | null>(null);
  const [backgroundPreview, setBackgroundPreview] = useState<string | null>(null);
  const [removeBackground, setRemoveBackground] = useState(false);
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

  useEffect(() => {
    listInstitutions()
      .then(setInstitutions)
      .catch(() => setInstitutions([]));
  }, []);

  useEffect(() => {
    if (!backgroundFile) {
      setBackgroundPreview(null);
      return;
    }
    const url = URL.createObjectURL(backgroundFile);
    setBackgroundPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [backgroundFile]);

  const fieldErrors = fieldErrorTexts(t, error);
  const shownPhoto = photoPreview ?? (!removePhoto && initial ? cardPhotoUrl(initial) : null);
  // Until the list arrives, the card's own copy of its institution stands in.
  const institution = institutionId ? (institutions?.find((i) => i.id === institutionId) ?? (initial?.institution?.id === institutionId ? initial.institution : null)) : null;
  const ownLogo = !removeLogo && initial ? cardLogoUrl(initial) : null;
  const shownLogo = institution?.logo ? institutionLogoUrl(institution) : ownLogo;
  const previewName = displayName({ first_name: values.first_name || null, last_name: values.last_name || null }) || institution?.name || values.organization || '—';
  const storedBackground = initial ? cardBackgroundUrl(initial) : null;
  const shownBackground = backgroundPreview ?? (removeBackground ? null : storedBackground);

  // What the visitor would see, built from the unsaved form (page designer previews).
  const previewCard = useMemo<PublicCard>(() => {
    // The same merge the server applies to the public card.
    const text = withInstitution(Object.fromEntries((Object.keys(INPUTS) as FieldKey[]).map((k) => [k, values[k].trim() || null])) as Record<FieldKey, string | null>, institution);
    return { ...text, accent_color: accent, photo_style: photoStyle, design_style: designStyle, design_config: null, code: initial?.code ?? '', photo: null, logo: null, background: null };
  }, [values, accent, photoStyle, designStyle, initial?.code, institution]);
  const previewAssets = useMemo(() => ({ photo: shownPhoto, logo: shownLogo }), [shownPhoto, shownLogo]);

  function choosePageMode() {
    setDesignMode('page');
    if (!pageDesign) setPageDesign(withHeaderTag(templateDesign('porcelain'), null, t('page.headerTag')));
    setStudioOpen(true);
  }

  function applyStudio(design: PageDesign, bg: StudioBackground) {
    setPageDesign(design);
    setBackgroundFile(bg.file);
    setRemoveBackground(bg.removed);
    setStudioOpen(false);
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    let saved: Card | null = null;
    try {
      const payload: CardInput = { ...values, accent_color: accent, status, photo_style: photoStyle, design_style: designStyle };
      // Only send the link when there is one to write or clear, so an install
      // without the institutions schema keeps saving cards.
      if (institution) {
        payload.institution = institution.id;
        payload.organization = institution.name;
      } else if (initial?.institution) payload.institution = null;
      // Only touch design_config when there is one to write or clear: an
      // install that has not re-run bootstrap keeps saving classic cards.
      if (designMode === 'page' && pageDesign) payload.design_config = pageDesign;
      else if (initial?.design_config) payload.design_config = null;
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
    // The card itself is saved; an asset failure must not make the form look
    // unsaved (a retry would create a duplicate card). Photo and logo remain
    // independent, so one failed upload never prevents the other.
    let warning: unknown;
    try {
      if (photoFile) saved = await uploadCardPhoto(saved.id, await shrinkImage(photoFile));
      else if (removePhoto && saved.photo) saved = await deleteCardPhoto(saved.id);
    } catch (e) {
      warning = e;
    }
    try {
      if (removeLogo && saved.logo) saved = await deleteCardLogo(saved.id);
    } catch (e) {
      warning ??= e;
    }
    try {
      if (backgroundFile) saved = await uploadCardBackground(saved.id, await shrinkImage(backgroundFile, 2000));
      else if (removeBackground && saved.background) saved = await deleteCardBackground(saved.id);
    } catch (e) {
      warning ??= e;
    }
    onSaved(saved, warning);
    setBusy(false);
  }

  const id = (k: string) => `${uid}-${k}`;

  return (
    <form onSubmit={onSubmit} className="card rise p-5 sm:p-6" noValidate>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{initial ? t('form.editTitle') : t('form.newTitle')}</h2>
        {initial && <span className="code text-xs text-muted">{initial.code}</span>}
      </div>

      <div className="mt-4 grid gap-6 lg:grid-cols-[1fr_16.5rem]">
        <div className="space-y-6">
          {SECTIONS.map((section, index) => (
            <fieldset key={index} className="form-section">
              <legend>{t(section.title)}</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {section.fields.includes('organization') && (
                  <Field id={id('institution')} label={t('form.institution')} error={fieldErrors.institution} hint={institutions?.length === 0 ? t('form.institutionEmpty') : t('form.institutionHint')} className="sm:col-span-2">
                    <select
                      id={id('institution')}
                      className="input"
                      value={institutionId}
                      disabled={institutions === null && !initial?.institution}
                      onChange={(e) => {
                        const next = institutions?.find((i) => i.id === e.target.value) ?? null;
                        setInstitutionId(next?.id ?? '');
                        setAddressCopied(false);
                        if (next?.accent_color) setAccent(next.accent_color);
                        // Unlinking keeps the name as editable text.
                        if (!next && institution) setValues((v) => ({ ...v, organization: institution.name }));
                      }}
                    >
                      <option value="">{t('form.institutionNone')}</option>
                      {[...(institutions ?? []), ...(initial?.institution && !institutions?.some((i) => i.id === initial.institution?.id) ? [initial.institution] : [])].map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
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
                    onBlur: key === 'first_name' || key === 'last_name' ? () => setValues((v) => ({ ...v, [key]: (key === 'first_name' ? formatGivenName : formatFamilyName)(v[key].trim()) })) : undefined,
                  };
                  if (key === 'organization' && institution) {
                    return (
                      <Field key={key} id={id(key)} label={t('form.organization')} hint={t('form.organizationFromInstitution')}>
                        <input id={id(key)} className="input text-muted" value={institution.name} readOnly />
                      </Field>
                    );
                  }
                  const addressChoices = key === 'address' ? (institution?.addresses ?? []) : [];
                  return (
                    <Field key={key} id={id(key)} label={t(`form.${key}`)} error={err} className={spec.wide ? 'sm:col-span-2' : ''} hint={key === 'address' && addressCopied ? t('form.addressCopied') : undefined}>
                      {addressChoices.length > 0 && (
                        <select
                          className="input mb-2"
                          aria-label={t('form.addressFromInstitution')}
                          value=""
                          onChange={(e) => {
                            const picked = addressChoices[Number(e.target.value)];
                            if (!picked) return;
                            setValues((v) => ({ ...v, address: picked.address }));
                            setAddressCopied(true);
                          }}
                        >
                          <option value="">{t('form.addressFromInstitution')}…</option>
                          {addressChoices.map((a, i) => (
                            <option key={`${i}-${a.label}`} value={i}>
                              {a.label} — {a.address.replace(/\s+/g, ' ').slice(0, 70)}
                            </option>
                          ))}
                        </select>
                      )}
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

          <fieldset className="form-section">
            <legend>{t('form.sectionCard')}</legend>
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
              <div className="sm:col-span-2">
                <span className="label">{t('form.designMode')}</span>
                {designMode === 'page' && pageDesign ? (
                  <div className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-surface p-4">
                    <div className="min-w-0 flex-1 space-y-2">
                      <p className="text-sm font-semibold">
                        {t('form.pageSummary', { name: t(`studio.templates.${pageDesign.template}`), count: pageDesign.blocks.filter((b) => !b.hidden).length })}
                      </p>
                      <p className="text-xs text-muted">{t('form.pageHint')}</p>
                      {backgroundFile && <p className="text-xs text-muted">{t('form.backgroundPending')}</p>}
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => setStudioOpen(true)}>
                          {t('form.openStudio')}
                        </button>
                        {initial && !initial.design_config && (
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDesignMode('classic')}>
                            {t('form.backToLegacy')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent/5 p-4">
                      <p className="min-w-0 flex-1 text-sm">{t('form.legacyNotice')}</p>
                      <button type="button" className="btn btn-primary btn-sm" onClick={choosePageMode}>
                        {t('form.switchToPage')}
                      </button>
                    </div>
                    <span className="label">{t('form.modeClassic')}</span>
                    <div className="design-gallery">
                      {CARD_DESIGNS.map((design) => (
                        <button
                          key={design.id}
                          type="button"
                          aria-pressed={designStyle === design.id}
                          onClick={() => setDesignStyle(design.id)}
                          className={`design-choice ${designStyle === design.id ? 'design-choice-active' : ''}`}
                        >
                          <span className="design-swatch" style={{ '--swatch-accent': accent, background: design.swatch } as CSSProperties} />
                          <span className="min-w-0"><span className="block truncate">{design.label}</span><span className="block text-[10px] font-normal text-muted">{design.family}</span></span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </fieldset>
        </div>

        {/* Photo + live preview of how the visitor will see the card header. */}
        <aside className="space-y-3">
          <span className="label">{t('form.preview')}</span>
          {designMode === 'page' && pageDesign ? (
            <button type="button" className="block rounded-xl border border-line bg-surface p-2 transition-shadow hover:shadow-md" onClick={() => setStudioOpen(true)} aria-label={t('form.openStudio')}>
              <PagePreview card={previewCard} design={pageDesign} assets={{ ...previewAssets, background: shownBackground }} scale={0.6} height={720} />
            </button>
          ) : (
            <CardIdentity
              compact
              name={previewName}
              photoUrl={shownPhoto}
              logoUrl={shownLogo}
              card={{ ...values, organization: institution?.name ?? values.organization, accent_color: accent, photo_style: photoStyle, design_style: designStyle }}
            />
          )}
          <span className="label pt-2">{t('form.photo')}</span>
          {shownPhoto && <img src={shownPhoto} alt="" className={`h-16 w-16 border border-line object-cover ${photoStyle === 'logo' ? 'rounded-lg bg-white object-contain p-1' : 'rounded-full'}`} />}
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
          <div className="border-t border-line pt-3">
            <span className="label">{t('form.logo')}</span>
            {shownLogo && <img src={shownLogo} alt="" className="mb-3 h-16 w-full rounded-lg border border-line bg-white object-contain p-2" />}
            {institution ? (
              <p className="text-xs text-muted">{institution.logo ? t('form.logoFromInstitution', { name: institution.name }) : t('form.logoInstitutionMissing', { name: institution.name })}</p>
            ) : (
              <p className="text-xs text-muted">{t('form.institutionHint')}</p>
            )}
            {ownLogo && (
              <div className="mt-3 rounded-lg border border-line p-2">
                <p className="text-xs font-medium">{t('form.logoLegacy')}</p>
                {institution?.logo && <img src={ownLogo} alt="" className="my-2 h-10 w-full rounded border border-line bg-white object-contain p-1" />}
                <p className="mt-1 text-xs text-muted">{t('form.logoLegacyHint')}</p>
                <button type="button" className="btn btn-ghost btn-sm mt-2 text-danger" onClick={() => setRemoveLogo(true)}>
                  {t('form.logoRemove')}
                </button>
              </div>
            )}
          </div>
        </aside>
      </div>

      {error !== null && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {isApiError(error) && error.code === 'CARD_LIMIT' ? t('errors.CARD_LIMIT', { max: error.fields?.max ?? 20 }) : errorText(t, error)}
        </p>
      )}

      {studioOpen && pageDesign && (
        <DesignStudio
          initial={pageDesign}
          card={previewCard}
          assets={previewAssets}
          background={{ url: storedBackground, file: backgroundFile, removed: removeBackground }}
          accent={accent}
          onApply={applyStudio}
          onClose={() => setStudioOpen(false)}
        />
      )}

      <div className="form-actions">
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

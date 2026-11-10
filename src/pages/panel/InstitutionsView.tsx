import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import Field from '../../components/Field';
import Modal from '../../components/Modal';
import { errorText, fieldErrorTexts, isApiError, useI18n } from '../../i18n';
import type { Institution, InstitutionAddress } from '../../lib/api';
import {
  createInstitution,
  deleteInstitution,
  deleteInstitutionLogo,
  institutionLogoUrl,
  listInstitutions,
  updateInstitution,
  uploadInstitutionLogo,
  uploadInstitutionLogoRaster,
} from '../../lib/api';
import { isSvgFile, rasterizeSvg } from '../../lib/image';

const LOGO_ACCEPT = 'image/svg+xml,.svg,image/png,image/jpeg,image/webp';

/**
 * Uploads a logo; an SVG also gets its PNG rendition (vCard photo, email
 * signatures — Directus cannot rasterise vectors). A failed rendition keeps
 * the SVG: the card shows it, only those bitmap consumers fall back.
 */
async function uploadLogo(id: string, file: File): Promise<Institution> {
  let saved = await uploadInstitutionLogo(id, file);
  if (isSvgFile(file)) {
    try {
      saved = await uploadInstitutionLogoRaster(id, await rasterizeSvg(file));
    } catch {
      /* the vector logo stands on its own */
    }
  }
  return saved;
}

function LogoThumb({ inst, size = 44 }: { inst: Pick<Institution, 'id' | 'logo' | 'name' | 'accent_color'>; size?: number }) {
  const url = institutionLogoUrl(inst);
  if (url) return <img src={url} alt="" className="shrink-0 rounded-lg border border-line bg-white object-contain p-1" style={{ width: size * 1.6, height: size }} />;
  const initials = inst.name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toLocaleUpperCase() || '—';
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-lg text-sm font-semibold text-white"
      style={{ width: size * 1.6, height: size, backgroundColor: inst.accent_color ?? '#64748b' }}
    >
      {initials}
    </span>
  );
}

function InstitutionFormModal({ institution, onClose, onSaved }: { institution: Institution | null; onClose: () => void; onSaved: (inst: Institution, warning?: unknown) => void }) {
  const { t } = useI18n();
  const uid = useId();
  const [name, setName] = useState(institution?.name ?? '');
  const [website, setWebsite] = useState(institution?.website ?? '');
  const [phone, setPhone] = useState(institution?.phone ?? '');
  const [email, setEmail] = useState(institution?.email ?? '');
  const [accent, setAccent] = useState<string | null>(institution?.accent_color ?? null);
  // Stable keys for the editable rows; never sent to the server.
  const [addresses, setAddresses] = useState<(InstitutionAddress & { key: string })[]>(() => (institution?.addresses ?? []).map((a, i) => ({ ...a, key: `a${i}` })));
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldErrors = fieldErrorTexts(t, error);

  useEffect(() => {
    if (!logoFile) {
      setLogoPreview(null);
      return;
    }
    const url = URL.createObjectURL(logoFile);
    setLogoPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [logoFile]);

  const shownLogo = logoPreview ?? (!removeLogo && institution ? institutionLogoUrl(institution) : null);

  function setAddress(key: string, patch: Partial<InstitutionAddress>) {
    setAddresses((list) => list.map((a) => (a.key === key ? { ...a, ...patch } : a)));
  }

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      name: name.trim(),
      website: website.trim() || null,
      phone: phone.trim() || null,
      email: email.trim() || null,
      accent_color: accent,
      // A blank row the admin added and never filled is not an address.
      addresses: addresses.map(({ label, address }) => ({ label: label.trim(), address: address.trim() })).filter((a) => a.label || a.address),
    };
    let saved: Institution;
    try {
      saved = institution ? await updateInstitution(institution.id, payload) : await createInstitution(payload);
    } catch (e) {
      setError(e);
      setBusy(false);
      return;
    }
    // The record is saved; a logo failure must not make the form look unsaved
    // (a retry would create a duplicate institution).
    let warning: unknown;
    try {
      if (logoFile) saved = { ...(await uploadLogo(saved.id, logoFile)), card_count: saved.card_count };
      else if (removeLogo && saved.logo) saved = { ...(await deleteInstitutionLogo(saved.id)), card_count: saved.card_count };
    } catch (e) {
      warning = e;
    }
    setBusy(false);
    onSaved(saved, warning);
  }

  const id = (k: string) => `${uid}-${k}`;
  const formId = id('form');
  return (
    <Modal
      title={institution ? t('institutions.editTitle') : t('institutions.createTitle')}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? t('common.saving') : institution ? t('common.save') : t('common.create')}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="space-y-5" noValidate>
        <div className="grid gap-5 sm:grid-cols-[1fr_12rem]">
          <div className="space-y-3">
            <Field id={id('name')} label={t('institutions.name')} error={fieldErrors.name}>
              <input id={id('name')} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="organization" required />
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id={id('website')} label={t('institutions.website')} error={fieldErrors.website} className="sm:col-span-2">
                <input id={id('website')} className="input" inputMode="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="ornek.com" />
              </Field>
              <Field id={id('phone')} label={t('institutions.phone')} error={fieldErrors.phone}>
                <input id={id('phone')} className="input" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+90 212 000 00 00" />
              </Field>
              <Field id={id('email')} label={t('institutions.email')} error={fieldErrors.email}>
                <input id={id('email')} className="input" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="info@ornek.com" />
              </Field>
            </div>
            <p className="text-xs text-muted">{t('institutions.contactHint')}</p>
          </div>

          <div>
            <span className="label">{t('institutions.logo')}</span>
            <div className="flex h-24 items-center justify-center rounded-lg border border-line bg-white p-2">
              {shownLogo ? <img src={shownLogo} alt="" className="max-h-full max-w-full object-contain" /> : <span className="text-xs text-muted">—</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <label className="btn btn-secondary btn-sm cursor-pointer">
                {shownLogo ? t('institutions.logoChange') : t('institutions.logoChoose')}
                <input
                  type="file"
                  accept={LOGO_ACCEPT}
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setLogoFile(file);
                    if (file) setRemoveLogo(false);
                    e.target.value = '';
                  }}
                />
              </label>
              {shownLogo && (
                <button type="button" className="btn btn-ghost btn-sm text-danger" onClick={() => { setLogoFile(null); setRemoveLogo(true); }}>
                  {t('institutions.logoRemove')}
                </button>
              )}
            </div>
            {logoFile && <p className="mt-2 text-xs text-muted">{t('institutions.logoPending')}</p>}
            <p className="mt-2 text-xs text-muted">{t('institutions.logoHint')}</p>
          </div>
        </div>

        <div>
          <span className="label">{t('institutions.accent')}</span>
          <div className="flex flex-wrap items-center gap-3">
            <input type="color" aria-label={t('institutions.accent')} value={accent ?? '#4f46e5'} onChange={(e) => setAccent(e.target.value)} className={`h-8 w-10 cursor-pointer rounded border border-line bg-surface ${accent ? '' : 'opacity-30'}`} />
            {accent ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAccent(null)}>
                {t('institutions.accentNone')}
              </button>
            ) : (
              <span className="text-xs text-muted">{t('institutions.accentNone')}</span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">{t('institutions.accentHint')}</p>
        </div>

        <fieldset>
          <legend className="label">{t('institutions.addresses')}</legend>
          <p className="mb-3 text-xs text-muted">{t('institutions.addressesHint')}</p>
          {addresses.length === 0 && <p className="mb-3 text-sm text-muted">{t('institutions.noAddresses')}</p>}
          <ul className="space-y-3">
            {addresses.map((a, index) => (
              <li key={a.key} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-[12rem_1fr_auto] sm:items-start">
                <input
                  className="input"
                  aria-label={`${t('institutions.addressLabel')} ${index + 1}`}
                  placeholder={t('institutions.addressLabelPlaceholder')}
                  value={a.label}
                  maxLength={80}
                  onChange={(e) => setAddress(a.key, { label: e.target.value })}
                />
                <textarea
                  className="input min-h-16"
                  aria-label={`${t('institutions.addressText')} ${index + 1}`}
                  placeholder={t('institutions.addressTextPlaceholder')}
                  value={a.address}
                  maxLength={500}
                  onChange={(e) => setAddress(a.key, { address: e.target.value })}
                />
                <button type="button" className="btn btn-ghost btn-sm text-danger" onClick={() => setAddresses((list) => list.filter((x) => x.key !== a.key))}>
                  {t('institutions.removeAddress')}
                </button>
              </li>
            ))}
          </ul>
          {fieldErrors.addresses && <p className="mt-2 text-sm text-danger">{fieldErrors.addresses}</p>}
          <button
            type="button"
            className="btn btn-secondary btn-sm mt-3"
            disabled={addresses.length >= 30}
            onClick={() => setAddresses((list) => [...list, { key: `n${Date.now()}${list.length}`, label: '', address: '' }])}
          >
            {t('institutions.addAddress')}
          </button>
        </fieldset>

        {error !== null && (
          <p role="alert" className="text-sm text-danger">
            {errorText(t, error)}
          </p>
        )}
      </form>
    </Modal>
  );
}

function DeleteInstitutionModal({ institution, onClose, onDeleted }: { institution: Institution; onClose: () => void; onDeleted: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The listing's count can be stale; the server's 409 is the last word.
  const [inUse, setInUse] = useState(institution.card_count ?? 0);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      await deleteInstitution(institution.id, inUse > 0);
      onDeleted();
    } catch (e) {
      if (isApiError(e) && e.code === 'IN_USE') setInUse(Number(e.fields?.count ?? 1));
      else setError(e);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('institutions.deleteTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void onConfirm()}>
            {busy ? t('common.deleting') : inUse > 0 ? t('institutions.deleteConfirm') : t('common.delete')}
          </button>
        </>
      }
    >
      <p className="text-sm">{t('institutions.deleteBody', { name: institution.name })}</p>
      {inUse > 0 && <p className="mt-3 rounded-lg border border-line bg-fg/5 p-3 text-sm">{t('institutions.deleteInUse', { count: inUse })}</p>}
      {error !== null && <p className="mt-3 text-sm text-danger">{errorText(t, error)}</p>}
    </Modal>
  );
}

type ModalState = { kind: 'create' } | { kind: 'edit'; institution: Institution } | { kind: 'delete'; institution: Institution } | null;

export default function InstitutionsView() {
  const { t } = useI18n();
  const [list, setList] = useState<Institution[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [modal, setModal] = useState<ModalState>(null);

  useEffect(() => {
    document.title = `${t('institutions.title')} · QR-VCard`;
  }, [t]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setList(await listInstitutions());
    } catch (e) {
      setLoadError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upsert = (inst: Institution) =>
    setList((all) => {
      const next = all?.some((i) => i.id === inst.id) ? all.map((i) => (i.id === inst.id ? inst : i)) : [...(all ?? []), inst];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });

  const visible = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return (list ?? []).filter((i) => !needle || [i.name, i.website, i.email, ...i.addresses.map((a) => `${a.label} ${a.address}`)].filter(Boolean).some((v) => String(v).toLocaleLowerCase().includes(needle)));
  }, [list, q]);

  return (
    <div>
      <div className="rise flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('institutions.title')}</h1>
          <p className="mt-1 text-sm text-muted">{t('institutions.subtitle')}</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setNotice(null);
            setWarning(null);
            setModal({ kind: 'create' });
          }}
        >
          + {t('institutions.new')}
        </button>
      </div>

      {notice && (
        <p role="status" className="mt-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      {warning && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {warning}
        </p>
      )}

      {list && list.length > 0 && (
        <input type="search" className="input mt-6 max-w-sm" placeholder={t('institutions.searchPlaceholder')} aria-label={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
      )}

      <div className="mt-4">
        {loadError !== null ? (
          <div className="card p-6 text-center">
            <p className="text-sm text-danger">{errorText(t, loadError)}</p>
            <button type="button" className="btn btn-secondary mt-3" onClick={() => void load()}>
              {t('common.retry')}
            </button>
          </div>
        ) : list === null ? (
          <p className="text-muted">{t('common.loading')}</p>
        ) : visible.length === 0 ? (
          <div className="card p-10 text-center text-sm text-muted">{list.length === 0 ? t('institutions.empty') : t('institutions.noMatch')}</div>
        ) : (
          <ul className="card rise divide-y divide-[var(--color-line)]">
            {visible.map((inst) => (
              <li key={inst.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <LogoThumb inst={inst} />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 font-medium tracking-tight">
                      <span className="truncate">{inst.name}</span>
                      {inst.accent_color && <span className="inline-block h-3 w-3 rounded-full border border-line" style={{ backgroundColor: inst.accent_color }} aria-hidden="true" />}
                    </p>
                    <p className="truncate text-sm text-muted">
                      {[inst.website?.replace(/^https?:\/\//, ''), t('institutions.addressCount', { count: inst.addresses.length })].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  {inst.card_count !== undefined && <span className="badge">{t('institutions.cardCount', { count: inst.card_count })}</span>}
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setModal({ kind: 'edit', institution: inst })}>
                    {t('common.edit')}
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm text-danger" onClick={() => setModal({ kind: 'delete', institution: inst })}>
                    {t('common.delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {(modal?.kind === 'create' || modal?.kind === 'edit') && (
        <InstitutionFormModal
          institution={modal.kind === 'edit' ? modal.institution : null}
          onClose={() => setModal(null)}
          onSaved={(inst, failed) => {
            upsert(inst);
            setNotice(modal.kind === 'create' ? t('institutions.created') : t('institutions.updated'));
            setWarning(failed ? t('institutions.logoWarning', { error: errorText(t, failed) }) : null);
            setModal(null);
          }}
        />
      )}
      {modal?.kind === 'delete' && (
        <DeleteInstitutionModal
          institution={modal.institution}
          onClose={() => setModal(null)}
          onDeleted={() => {
            setList((all) => all?.filter((i) => i.id !== modal.institution.id) ?? null);
            setNotice(t('institutions.deleted'));
            setWarning(null);
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

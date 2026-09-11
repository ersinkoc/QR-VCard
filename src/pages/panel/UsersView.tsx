import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import Avatar from '../../components/Avatar';
import CopyButton from '../../components/CopyButton';
import Field from '../../components/Field';
import Modal from '../../components/Modal';
import { errorText, fieldErrorTexts, useI18n } from '../../i18n';
import type { Translate } from '../../i18n';
import type { AdminUser, Role } from '../../lib/api';
import { createUser, deleteUser, displayName, listRoles, listUsers, updateUser } from '../../lib/api';
import { generatePassword } from '../../lib/password';
import { useSession } from './session';

function roleLabel(t: Translate, role: Pick<Role, 'name' | 'kind'>): string {
  if (role.name === 'Administrator') return t('roles.admin');
  if (role.name === 'vcard-editor') return t('roles.editor');
  if (role.name === 'vcard-user') return t('roles.user');
  return role.name;
}

function statusLabel(t: Translate, status: string): string {
  if (status === 'active') return t('users.statusActive');
  if (status === 'suspended') return t('users.statusSuspended');
  return t('users.statusOther', { status });
}

/** Password input with show/hide, generate and copy — for handing credentials over. */
function PasswordField({ id, label, value, onChange, error, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; error?: string; hint: string }) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <Field id={id} label={label} error={error} hint={hint}>
      <div className="flex gap-2">
        <input
          id={id}
          className="input code"
          type={visible ? 'text' : 'password'}
          autoComplete="new-password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
          minLength={8}
          required
        />
        <button type="button" className="btn btn-secondary btn-sm h-auto" onClick={() => setVisible((v) => !v)}>
          {visible ? t('common.hide') : t('common.show')}
        </button>
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            onChange(generatePassword());
            setVisible(true);
          }}
        >
          {t('common.generate')}
        </button>
        {value && <CopyButton text={value} label={t('common.copy')} className="btn btn-ghost btn-sm" />}
      </div>
    </Field>
  );
}

function UserFormModal({
  user,
  roles,
  isSelf,
  onClose,
  onSaved,
}: {
  user: AdminUser | null;
  roles: Role[];
  isSelf: boolean;
  onClose: () => void;
  onSaved: (user: AdminUser) => void;
}) {
  const { t } = useI18n();
  const uid = useId();
  const defaultRole = roles.find((r) => r.name === 'vcard-user')?.id ?? roles[0]?.id ?? '';
  const [email, setEmail] = useState(user?.email ?? '');
  const [firstName, setFirstName] = useState(user?.first_name ?? '');
  const [lastName, setLastName] = useState(user?.last_name ?? '');
  const [roleId, setRoleId] = useState(() => roles.find((r) => r.name === user?.role_name)?.id ?? defaultRole);
  const [status, setStatus] = useState<'active' | 'suspended'>(user?.status === 'suspended' ? 'suspended' : 'active');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fieldErrors = fieldErrorTexts(t, error);
  const selectedRole = roles.find((r) => r.id === roleId);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const saved = user
        ? await updateUser(user.id, {
            email: email.trim(),
            first_name: firstName.trim(),
            last_name: lastName.trim(),
            ...(isSelf ? {} : { role: roleId, status }),
          })
        : await createUser({ email: email.trim(), first_name: firstName.trim(), last_name: lastName.trim(), role: roleId, password });
      onSaved(saved);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const formId = `${uid}-form`;
  return (
    <Modal
      title={user ? t('users.editTitle') : t('users.createTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" form={formId} className="btn btn-primary" disabled={busy || !roleId || (!user && password.length < 8)}>
            {busy ? t('common.saving') : user ? t('common.save') : t('common.create')}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} className="space-y-3" noValidate>
        <Field id={`${uid}-email`} label={t('users.email')} error={fieldErrors.email}>
          <input id={`${uid}-email`} className="input" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={fieldErrors.email ? true : undefined} required />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id={`${uid}-first`} label={t('users.first_name')} error={fieldErrors.first_name}>
            <input id={`${uid}-first`} className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
          </Field>
          <Field id={`${uid}-last`} label={t('users.last_name')} error={fieldErrors.last_name}>
            <input id={`${uid}-last`} className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </Field>
        </div>
        <Field
          id={`${uid}-role`}
          label={t('users.role')}
          error={fieldErrors.role}
          hint={isSelf ? t('users.selfHint') : selectedRole ? t(`roles.${selectedRole.kind}Hint`) : undefined}
        >
          <select id={`${uid}-role`} className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={isSelf}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {roleLabel(t, r)}
              </option>
            ))}
          </select>
        </Field>
        {user && (
          <Field id={`${uid}-status`} label={t('users.status')}>
            <select id={`${uid}-status`} className="input" value={status} onChange={(e) => setStatus(e.target.value === 'suspended' ? 'suspended' : 'active')} disabled={isSelf}>
              <option value="active">{t('users.statusActive')}</option>
              <option value="suspended">{t('users.statusSuspended')}</option>
            </select>
          </Field>
        )}
        {!user && <PasswordField id={`${uid}-password`} label={t('users.initialPassword')} value={password} onChange={setPassword} error={fieldErrors.password} hint={t('users.passwordHint')} />}
        {error !== null && (
          <p role="alert" className="text-sm text-danger">
            {errorText(t, error)}
          </p>
        )}
      </form>
    </Modal>
  );
}

function PasswordModal({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const uid = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateUser(user.id, { password });
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('users.passwordTitle', { email: user.email })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" form={`${uid}-form`} className="btn btn-primary" disabled={busy || password.length < 8}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </>
      }
    >
      <form id={`${uid}-form`} onSubmit={onSubmit} className="space-y-3">
        <PasswordField id={`${uid}-password`} label={t('users.newPassword')} value={password} onChange={setPassword} error={fieldErrorTexts(t, error).password} hint={t('users.passwordResetHint')} />
        {error !== null && <p className="text-sm text-danger">{errorText(t, error)}</p>}
      </form>
    </Modal>
  );
}

function DeleteUserModal({ user, onClose, onDeleted }: { user: AdminUser; onClose: () => void; onDeleted: () => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'transfer' | 'delete'>('transfer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      await deleteUser(user.id, mode);
      onDeleted();
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={t('users.deleteTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void onConfirm()}>
            {busy ? t('common.deleting') : t('common.delete')}
          </button>
        </>
      }
    >
      <p className="text-sm">{t('users.deleteBody', { email: user.email })}</p>
      {user.card_count > 0 && (
        <fieldset className="mt-4 space-y-2">
          <legend className="mb-2 text-sm font-medium">{t('users.deleteCardsQuestion', { count: user.card_count })}</legend>
          {(['transfer', 'delete'] as const).map((m) => (
            <label key={m} className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-3 text-sm has-[:checked]:border-accent">
              <input type="radio" name="cards-mode" className="mt-0.5" checked={mode === m} onChange={() => setMode(m)} />
              {m === 'transfer' ? t('users.deleteCardsTransfer') : t('users.deleteCardsDelete')}
            </label>
          ))}
        </fieldset>
      )}
      {error !== null && <p className="mt-3 text-sm text-danger">{errorText(t, error)}</p>}
    </Modal>
  );
}

type ModalState = { kind: 'create' } | { kind: 'edit'; user: AdminUser } | { kind: 'password'; user: AdminUser } | { kind: 'delete'; user: AdminUser } | null;

export default function UsersView() {
  const { me, setMe } = useSession();
  const { t, formatDate } = useI18n();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [modal, setModal] = useState<ModalState>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    document.title = `${t('users.title')} · QR-VCard`;
  }, [t]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [u, r] = await Promise.all([listUsers(), listRoles()]);
      setUsers(u);
      setRoles(r);
    } catch (e) {
      setLoadError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const upsert = (user: AdminUser) => {
    setUsers((list) => (list ? (list.some((u) => u.id === user.id) ? list.map((u) => (u.id === user.id ? user : u)) : [...list, user].sort((a, b) => a.email.localeCompare(b.email))) : [user]));
    if (user.id === me.id) setMe({ id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role, role_name: user.role_name });
  };

  const visible = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return (users ?? []).filter((u) => !needle || [u.email, u.first_name, u.last_name].filter(Boolean).some((v) => String(v).toLocaleLowerCase().includes(needle)));
  }, [users, q]);

  async function toggleStatus(user: AdminUser) {
    setBusyId(user.id);
    setActionError(null);
    setNotice(null);
    try {
      const next = user.status === 'active' ? 'suspended' : 'active';
      upsert(await updateUser(user.id, { status: next }));
      setNotice(next === 'suspended' ? t('users.suspended', { email: user.email }) : t('users.activated', { email: user.email }));
    } catch (e) {
      setActionError(e);
    } finally {
      setBusyId(null);
    }
  }

  const all = users ?? [];
  const stats = [
    [t('users.statTotal'), all.length],
    [t('users.statActive'), all.filter((u) => u.status === 'active').length],
    [t('users.statSuspended'), all.filter((u) => u.status === 'suspended').length],
    [t('users.statAdmins'), all.filter((u) => u.role === 'admin').length],
  ] as const;

  return (
    <div>
      <div className="rise flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('users.title')}</h1>
          <p className="mt-1 text-sm text-muted">{t('users.subtitle')}</p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={roles.length === 0}
          onClick={() => {
            setNotice(null);
            setModal({ kind: 'create' });
          }}
        >
          + {t('users.new')}
        </button>
      </div>

      {users && (
        <div className="rise rise-2 mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map(([label, value]) => (
            <div key={label} className="card px-4 py-3">
              <p className="text-xs text-muted">{label}</p>
              <p className="mt-0.5 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
            </div>
          ))}
        </div>
      )}

      {notice && (
        <p role="status" className="mt-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      {actionError !== null && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {errorText(t, actionError)}
        </p>
      )}

      {users && users.length > 0 && (
        <input
          type="search"
          className="input mt-6 max-w-sm"
          placeholder={t('users.searchPlaceholder')}
          aria-label={t('common.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}

      <div className="mt-4">
        {loadError !== null ? (
          <div className="card p-6 text-center">
            <p className="text-sm text-danger">{errorText(t, loadError)}</p>
            <button type="button" className="btn btn-secondary mt-3" onClick={() => void load()}>
              {t('common.retry')}
            </button>
          </div>
        ) : users === null ? (
          <p className="text-muted">{t('common.loading')}</p>
        ) : visible.length === 0 ? (
          <div className="card p-10 text-center text-sm text-muted">{t('users.empty')}</div>
        ) : (
          <ul className="card rise divide-y divide-[var(--color-line)]">
            {visible.map((u) => {
              const self = u.id === me.id;
              const name = displayName(u);
              const busy = busyId === u.id;
              return (
                <li key={u.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar name={name || u.email} size={40} />
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium tracking-tight">
                        <span className="truncate">{name || u.email}</span>
                        {self && <span className="text-xs font-normal text-muted">({t('common.you')})</span>}
                        <span className={`badge ${u.role === 'admin' ? 'badge-accent' : ''}`}>{roleLabel(t, { name: u.role_name ?? '', kind: u.role })}</span>
                        {u.status !== 'active' && <span className="badge badge-danger">{statusLabel(t, u.status)}</span>}
                      </p>
                      <p className="truncate text-sm text-muted">
                        {name ? `${u.email} · ` : ''}
                        {u.last_access ? t('users.lastAccess', { date: formatDate(u.last_access) }) : t('users.neverSignedIn')}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    <Link to={u.card_count > 0 ? `/panel?owner=${u.id}` : '#'} aria-disabled={u.card_count === 0} className={`btn btn-ghost btn-sm ${u.card_count === 0 ? 'pointer-events-none opacity-50' : ''}`} title={t('users.viewCards')}>
                      {t('users.cardCount', { count: u.card_count })}
                    </Link>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setModal({ kind: 'edit', user: u })}>
                      {t('common.edit')}
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setModal({ kind: 'password', user: u })}>
                      {t('users.setPassword')}
                    </button>
                    {!self && (
                      <>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void toggleStatus(u)}>
                          {u.status === 'active' ? t('users.suspend') : t('users.activate')}
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm text-danger" onClick={() => setModal({ kind: 'delete', user: u })}>
                          {t('common.delete')}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {(modal?.kind === 'create' || modal?.kind === 'edit') && (
        <UserFormModal
          user={modal.kind === 'edit' ? modal.user : null}
          roles={roles}
          isSelf={modal.kind === 'edit' && modal.user.id === me.id}
          onClose={() => setModal(null)}
          onSaved={(user) => {
            upsert(user);
            setNotice(modal.kind === 'create' ? t('users.created', { email: user.email }) : t('users.updated'));
            setModal(null);
          }}
        />
      )}
      {modal?.kind === 'password' && (
        <PasswordModal
          user={modal.user}
          onClose={() => setModal(null)}
          onSaved={() => {
            setNotice(t('users.passwordSet'));
            setModal(null);
          }}
        />
      )}
      {modal?.kind === 'delete' && (
        <DeleteUserModal
          user={modal.user}
          onClose={() => setModal(null)}
          onDeleted={() => {
            setUsers((list) => list?.filter((u) => u.id !== modal.user.id) ?? null);
            setNotice(t('users.deleted'));
            setModal(null);
          }}
        />
      )}
    </div>
  );
}

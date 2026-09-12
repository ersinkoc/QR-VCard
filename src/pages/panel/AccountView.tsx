import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Field from '../../components/Field';
import { errorText, fieldErrorTexts, useI18n } from '../../i18n';
import { changePassword, updateMe, userUrl } from '../../lib/api';
import { useSession } from './session';

export default function AccountView() {
  const { me, setMe } = useSession();
  const { t } = useI18n();

  const [email, setEmail] = useState(me.email);
  const [firstName, setFirstName] = useState(me.first_name ?? '');
  const [lastName, setLastName] = useState(me.last_name ?? '');
  const [username, setUsername] = useState(me.username ?? '');
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileNotice, setProfileNotice] = useState(false);
  const [profileError, setProfileError] = useState<unknown>(null);

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwNotice, setPwNotice] = useState(false);
  const [pwError, setPwError] = useState<unknown>(null);

  useEffect(() => {
    document.title = `${t('account.title')} · QR-VCard`;
  }, [t]);

  useEffect(() => {
    setEmail(me.email);
    setFirstName(me.first_name ?? '');
    setLastName(me.last_name ?? '');
    setUsername(me.username ?? '');
  }, [me]);

  async function onProfile(ev: FormEvent) {
    ev.preventDefault();
    setProfileBusy(true);
    setProfileError(null);
    setProfileNotice(false);
    try {
      const patch: { email?: string; first_name?: string; last_name?: string; username?: string | null } = {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
      };
      if (email.trim().toLowerCase() !== me.email.toLowerCase()) {
        patch.email = email.trim().toLowerCase();
      }
      const nextUsername = username.trim().toLowerCase();
      if (nextUsername !== (me.username ?? '')) {
        patch.username = nextUsername || null;
      }
      const updated = await updateMe(patch);
      setMe(updated);
      setProfileNotice(true);
    } catch (e) {
      setProfileError(e);
    } finally {
      setProfileBusy(false);
    }
  }

  async function onPassword(ev: FormEvent) {
    ev.preventDefault();
    setPwNotice(false);
    setPwError(null);
    if (next !== confirm) return;
    setPwBusy(true);
    try {
      await changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setPwNotice(true);
    } catch (e) {
      setPwError(e);
    } finally {
      setPwBusy(false);
    }
  }

  const profileFields = fieldErrorTexts(t, profileError);
  const pwFields = fieldErrorTexts(t, pwError);
  const mismatch = confirm.length > 0 && next !== confirm;

  return (
    <div className="max-w-2xl">
      <div className="rise">
        <h1 className="text-2xl font-semibold tracking-tight">{t('account.title')}</h1>
        <p className="mt-1 text-sm text-muted">{t('account.subtitle')}</p>
      </div>

      <form onSubmit={onProfile} className="card rise rise-2 mt-6 p-5">
        <h2 className="font-semibold tracking-tight">{t('account.profile')}</h2>
        <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">{t('account.role')}</dt>
            <dd className="mt-0.5">
              {t(`roles.${me.role}`)} <span className="text-muted">— {t(`roles.${me.role}Hint`)}</span>
            </dd>
          </div>
        </dl>
        <div className="mt-4 space-y-3">
          <Field id="acc-email" label={t('account.email')} error={profileFields.email}>
            <input
              id="acc-email"
              type="email"
              className="input"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field id="acc-username" label={t('account.username')} error={profileFields.username} hint={me.username ? userUrl(me.username) : t('account.usernameHint')}>
            <input
              id="acc-username"
              className="input code"
              autoComplete="off"
              spellCheck={false}
              value={username}
              onChange={(e) => setUsername(e.target.value.toLocaleLowerCase('en'))}
              placeholder="ada"
            />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id="acc-first" label={t('account.first_name')} error={profileFields.first_name}>
              <input id="acc-first" className="input" autoComplete="given-name" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </Field>
            <Field id="acc-last" label={t('account.last_name')} error={profileFields.last_name}>
              <input id="acc-last" className="input" autoComplete="family-name" value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </Field>
          </div>
        </div>
        {profileError !== null && <p className="mt-3 text-sm text-danger">{errorText(t, profileError)}</p>}
        {profileNotice && (
          <p role="status" className="mt-3 text-sm text-muted">
            {t('account.profileSaved')}
          </p>
        )}
        <button type="submit" className="btn btn-primary mt-4" disabled={profileBusy}>
          {profileBusy ? t('common.saving') : t('account.saveProfile')}
        </button>
      </form>

      <form onSubmit={onPassword} className="card rise rise-2 mt-6 p-5">
        <h2 className="font-semibold tracking-tight">{t('account.changePassword')}</h2>
        {/* Lets password managers attach the change to the right account. */}
        <input type="email" autoComplete="username" value={me.email} readOnly hidden />
        <div className="mt-4 space-y-3">
          <Field id="acc-current" label={t('account.currentPassword')} error={pwFields.current_password}>
            <input id="acc-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field id="acc-new" label={t('account.newPassword')} error={pwFields.new_password} hint={t('fieldErrors.password_too_short')}>
              <input id="acc-new" className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
            </Field>
            <Field id="acc-confirm" label={t('account.confirmPassword')} error={mismatch ? t('account.mismatch') : undefined}>
              <input id="acc-confirm" className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch ? true : undefined} required />
            </Field>
          </div>
        </div>
        {pwError !== null && <p className="mt-3 text-sm text-danger">{errorText(t, pwError)}</p>}
        {pwNotice && (
          <p role="status" className="mt-3 text-sm text-muted">
            {t('account.passwordChanged')}
          </p>
        )}
        <button type="submit" className="btn btn-primary mt-4" disabled={pwBusy || !current || next.length < 8 || next !== confirm}>
          {pwBusy ? t('common.saving') : t('account.updatePassword')}
        </button>
      </form>
    </div>
  );
}

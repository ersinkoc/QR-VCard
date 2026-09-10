import {
  authentication,
  createDirectus,
  createItem,
  deleteItem,
  readItems,
  readMe,
  rest,
  updateItem,
} from '@directus/sdk';

export interface VCard {
  id: string;
  status: 'draft' | 'published';
  code: string;
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
  job_title: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  note: string | null;
  accent_color: string | null;
  date_created: string | null;
}

export interface MeInfo {
  id: string;
  email: string;
  role_name: string;
}

export const DIRECTUS_URL = (import.meta.env.VITE_DIRECTUS_URL ?? 'http://localhost:8055').replace(/\/+$/, '');

// Untyped SDK generic on purpose: the schema is small and every exported
// function below declares its own concrete return type.
export const directus = createDirectus<any>(DIRECTUS_URL)
  // 'json' persists tokens in localStorage when running in a browser.
  .with(authentication('json'))
  .with(rest());

export async function login(email: string, password: string): Promise<void> {
  await directus.login({ email, password });
}

export async function logout(): Promise<void> {
  try {
    await directus.logout();
  } catch {
    // logging out with an expired/no token is fine
  }
}

export async function fetchMe(): Promise<MeInfo> {
  const me = (await directus.request(readMe({ fields: ['id', 'email', { role: ['name'] }] }))) as {
    id: string;
    email: string;
    role: { name: string } | null;
  };
  return { id: me.id, email: me.email, role_name: me.role?.name ?? '' };
}

/** Privileged roles see everyone's cards; the plain user role only their own. */
export function isPrivileged(me: MeInfo): boolean {
  return me.role_name === 'Administrator' || me.role_name === 'vcard-editor';
}

export async function listCards(me: MeInfo): Promise<VCard[]> {
  const filter = isPrivileged(me) ? undefined : { user_created: { _eq: me.id } };
  const rows = (await directus.request(
    readItems('vcards', { sort: ['-date_created'], limit: 200, filter }),
  )) as VCard[];
  return rows;
}

export async function createCard(input: Partial<VCard> & { code: string }): Promise<VCard> {
  return directus.request(createItem('vcards', input)) as Promise<VCard>;
}

export async function updateCard(id: string, patch: Partial<VCard>): Promise<VCard> {
  return directus.request(updateItem('vcards', id, patch)) as Promise<VCard>;
}

export async function deleteCard(id: string): Promise<void> {
  await directus.request(deleteItem('vcards', id));
}

/** Public, unauthenticated read of one published card by its short code. */
export async function fetchPublishedByCode(code: string): Promise<VCard | null> {
  const rows = (await directus.request(
    readItems('vcards', {
      filter: { code: { _eq: code }, status: { _eq: 'published' } },
      limit: 1,
    }),
  )) as VCard[];
  return rows[0] ?? null;
}

export function shortUrl(code: string): string {
  return `${window.location.origin}/c/${code}`;
}

export function photoUrl(fileId: string): string {
  return `${DIRECTUS_URL}/assets/${fileId}?width=256&height=256&fit=cover&quality=80`;
}

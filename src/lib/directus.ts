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
import { canManage, cardScopeFilter } from './ownership';

export { isPrivileged } from './ownership';

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
  /** Owner. Set by Directus on create; the basis of the ownership checks. */
  user_created: string | null;
}

export interface MeInfo {
  id: string;
  email: string;
  role_name: string;
}

export interface PanelUser {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: string;
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

/**
 * Lists the cards this actor may see. The API filter is a convenience, not a
 * guarantee: on an unlicensed Directus (no row-level rules) a user's token can
 * still read the collection directly. See README, "Roles and card ownership".
 */
export async function listCards(me: MeInfo): Promise<VCard[]> {
  const rows = (await directus.request(
    readItems('vcards', { sort: ['-date_created'], limit: 200, filter: cardScopeFilter(me) }),
  )) as VCard[];
  return rows;
}

export async function createCard(input: Partial<VCard> & { code: string }): Promise<VCard> {
  return directus.request(createItem('vcards', input)) as Promise<VCard>;
}

function assertCanManage(card: VCard, me: MeInfo): void {
  if (!canManage(card, me)) {
    throw new Error('You can only manage your own cards.');
  }
}

/** Refuses unless `me` owns the card (or is privileged). */
export async function updateCard(me: MeInfo, card: VCard, patch: Partial<VCard>): Promise<VCard> {
  assertCanManage(card, me);
  return directus.request(updateItem('vcards', card.id, patch)) as Promise<VCard>;
}

/** Refuses unless `me` owns the card (or is privileged). */
export async function deleteCard(me: MeInfo, card: VCard): Promise<void> {
  assertCanManage(card, me);
  await directus.request(deleteItem('vcards', card.id));
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

// --- user administration (requires the Administrator role in Directus) -------

export async function listPanelUsers(): Promise<PanelUser[]> {
  const rows = (await directus.request(
    readItems('directus_users', {
      fields: ['id', 'email', 'first_name', 'last_name', 'status', { role: ['name'] }],
      sort: ['email'],
      limit: 200,
    }),
  )) as {
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    status: string;
    role: { name: string } | null;
  }[];
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    first_name: u.first_name,
    last_name: u.last_name,
    status: u.status,
    role_name: u.role?.name ?? '(no role)',
  }));
}

/** Roles a new panel user can be given — never Administrator. */
export async function listAssignableRoles(): Promise<{ id: string; name: string }[]> {
  const rows = (await directus.request(
    readItems('directus_roles', { fields: ['id', 'name'], limit: 100 }),
  )) as { id: string; name: string }[];
  return rows.filter((role) => role.name !== 'Administrator');
}

export async function createPanelUser(input: {
  email: string;
  password: string;
  first_name: string;
  roleId: string;
}): Promise<void> {
  await directus.request(
    createItem('directus_users', {
      email: input.email,
      password: input.password,
      first_name: input.first_name,
      role: input.roleId,
      status: 'active',
    }),
  );
}

export async function setPanelUserPassword(id: string, password: string): Promise<void> {
  await directus.request(updateItem('directus_users', id, { password }));
}

export function shortUrl(code: string): string {
  return `${window.location.origin}/c/${code}`;
}

export function photoUrl(fileId: string): string {
  return `${DIRECTUS_URL}/assets/${fileId}?width=256&height=256&fit=cover&quality=80`;
}

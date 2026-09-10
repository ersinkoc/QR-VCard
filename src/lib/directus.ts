import {
  authentication,
  createDirectus,
  createItem,
  createUser,
  deleteItem,
  readItems,
  readMe,
  readRoles,
  readUsers,
  rest,
  updateItem,
  updateUser,
} from '@directus/sdk';
import { canManage, cardScopeFilter, assignOwner, isPrivileged } from './ownership';

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
  /** Owner's email — only populated for privileged actors (see listCards). */
  owner_email?: string | null;
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
  // Only privileged actors may read directus_users, so the owner's email is
  // requested for them alone; a plain user's listing is already scoped to them.
  const fields: (string | Record<string, string[]>)[] = isPrivileged(me) ? ['*', { user_created: ['id', 'email'] }] : ['*'];
  const rows = (await directus.request(
    readItems('vcards', { fields, sort: ['-date_created'], limit: 200, filter: cardScopeFilter(me) }),
  )) as (Omit<VCard, 'user_created'> & { user_created: string | { id: string; email?: string | null } | null })[];

  return rows.map((row): VCard => {
    // Destructure `user_created` out of the spread so the union type (owner id
    // string, or the expanded object) never leaks into the normalised VCard.
    const { user_created: owner, ...rest } = row;
    if (owner !== null && typeof owner === 'object') {
      return { ...rest, user_created: owner.id, owner_email: owner.email ?? null };
    }
    return { ...rest, user_created: owner, owner_email: null };
  });
}

/**
 * Creates a card. `ownerId` lets a privileged actor create one on another user's
 * behalf; a plain user may not assign an owner at all. The UI only renders the
 * picker for admins, but the adapter is the documented enforcement layer on an
 * unlicensed Directus, so the refusal lives here rather than in the form.
 */
export async function createCard(
  me: MeInfo,
  input: Partial<VCard> & { code: string },
  ownerId?: string | null,
): Promise<VCard> {
  const wanted = ownerId?.trim();
  if (wanted && !isPrivileged(me)) {
    throw new Error('Only admins can create a card for another user.');
  }
  const body = assignOwner({ ...input } as Record<string, unknown>, wanted);
  return directus.request(createItem('vcards', body)) as Promise<VCard>;
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
//
// These use the SDK's *system* functions (`readUsers`, `readRoles`,
// `createUser`, `updateUser`), NOT `readItems('directus_users')`. The Items API
// (`/items/{collection}`) only serves user-defined collections: for a core
// collection it answers 403 FORBIDDEN ("You don't have permission to access
// this.") even for an administrator, because the route does not serve those
// collections at all. Each core collection has its own endpoint (`/users`,
// `/roles`, `/files`, ...), which is what these helpers build.

export async function listPanelUsers(): Promise<PanelUser[]> {
  const rows = (await directus.request(
    readUsers({
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
    readRoles({ fields: ['id', 'name'], limit: 100 }),
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
    createUser({
      email: input.email,
      password: input.password,
      first_name: input.first_name,
      role: input.roleId,
      status: 'active',
    }),
  );
}

export async function setPanelUserPassword(id: string, password: string): Promise<void> {
  await directus.request(updateUser(id, { password }));
}

export function shortUrl(code: string): string {
  return `${window.location.origin}/c/${code}`;
}

export function photoUrl(fileId: string): string {
  return `${DIRECTUS_URL}/assets/${fileId}?width=256&height=256&fit=cover&quality=80`;
}

/**
 * Card ownership rules (domain logic — no vendor imports, no I/O).
 *
 * These live here rather than next to the Directus adapter because they are the
 * only thing standing between a signed-in user and another user's card on an
 * UNLICENSED Directus, where row-level permission rules cannot be created (the
 * API returns RESOURCE_RESTRICTED for them). See README, "Roles and card
 * ownership" for what that does and does not protect against.
 */

/** Roles allowed to see and manage every card. */
export const PRIVILEGED_ROLES = ['Administrator', 'vcard-editor'] as const;

export interface Actor {
  id: string;
  role_name: string;
}

export interface OwnedRecord {
  user_created?: string | null;
}

/** Privileged roles see everyone's cards; a plain user only their own. */
export function isPrivileged(actor: Actor): boolean {
  return (PRIVILEGED_ROLES as readonly string[]).includes(actor.role_name);
}

/**
 * May `actor` edit or delete this record?
 *
 * Privileged actors may touch anything; everyone else only records they created.
 * A record with no `user_created` is nobody's, so only a privileged actor may
 * touch it — refusing is the safe default when the owner is unknown.
 */
export function canManage(record: OwnedRecord, actor: Actor): boolean {
  if (isPrivileged(actor)) return true;
  return Boolean(record.user_created) && record.user_created === actor.id;
}

/**
 * The query filter that scopes a card list to its owner, or `undefined` for
 * privileged actors (who see everything).
 *
 * This is a domain decision, which is why it lives here: the Directus SDK hands
 * the API an opaque request descriptor, so a test can assert this shape but
 * cannot read it back out of the adapter.
 */
export function cardScopeFilter(actor: Actor): { user_created: { _eq: string } } | undefined {
  return isPrivileged(actor) ? undefined : { user_created: { _eq: actor.id } };
}

/**
 * Assigns a card to another owner — an admin creating on someone's behalf.
 *
 * A blank/absent owner means "leave it to Directus", which stamps the creating
 * user. Sending an empty string instead would be rejected by the API, so the
 * decision to omit is made here, once, and tested.
 */
export function assignOwner<T extends Record<string, unknown>>(input: T, ownerId?: string | null): T {
  const id = ownerId?.trim();
  return id ? ({ ...input, user_created: id } as T) : input;
}

/**
 * How a card's owner is shown in the panel list.
 *
 * Only privileged actors are told anything: for everyone else the listing is
 * already scoped to them, so naming owners would just leak who else exists.
 */
export function ownerLabel(record: OwnedRecord & { owner_email?: string | null }, actor: Actor): string {
  if (!isPrivileged(actor)) return 'you';
  if (record.owner_email) return record.owner_email;
  if (record.user_created && record.user_created === actor.id) return 'you';
  return record.user_created ? `unknown (${record.user_created.slice(0, 8)}…)` : 'unowned';
}

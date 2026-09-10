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

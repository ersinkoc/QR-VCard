/**
 * Who may do what — pure rules, no I/O. The API enforces these on every request;
 * Directus grants the browser nothing, so there is no second path around them.
 *
 *   admin   (Directus role "Administrator")  every card, plus user management
 *   editor  (role "vcard-editor")            every card, no user management
 *   user    (role "vcard-user", or any other) only the cards they own
 */
export const ROLE_ADMIN = 'Administrator';
export const ROLE_EDITOR = 'vcard-editor';
export const ROLE_USER = 'vcard-user';

export function roleKind(roleName) {
  if (roleName === ROLE_ADMIN) return 'admin';
  if (roleName === ROLE_EDITOR) return 'editor';
  return 'user';
}

export const canSeeAllCards = (kind) => kind === 'admin' || kind === 'editor';
export const canManageUsers = (kind) => kind === 'admin';

/**
 * Ownership lives in `vcards.owner`, written only by the app server. (Directus'
 * own `user_created` cannot carry it: Directus stamps the caller there on every
 * create, and every create comes from the service token.)
 *
 * A card with no owner is nobody's: only a privileged actor may touch it.
 */
export function canManageCard(card, actor) {
  if (canSeeAllCards(actor.kind)) return true;
  return Boolean(card?.owner) && card.owner === actor.id;
}

/** Directus filter that scopes a card query to what `actor` may see. */
export function cardScope(actor) {
  return canSeeAllCards(actor.kind) ? null : { owner: { _eq: actor.id } };
}

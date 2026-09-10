import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Directus client resolves its auth storage lazily, but stub the browser
// stores so the adapter module can be imported in the node test environment.
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const { createCard, createPanelUser, deleteCard, directus, listAssignableRoles, listCards, updateCard } =
  await import('./directus');
type VCard = import('./directus').VCard;

const admin = { id: 'u-admin', email: 'admin@local.dev', role_name: 'Administrator' };
const editor = { id: 'u-editor', email: 'editor@local.dev', role_name: 'vcard-editor' };
const user = { id: 'u-ada', email: 'ada@local.dev', role_name: 'vcard-user' };

const ownCard = { id: 'c1', code: 'abc123', user_created: user.id } as VCard;
const foreignCard = { id: 'c2', code: 'xyz789', user_created: 'u-someone-else' } as VCard;

beforeEach(() => {
  vi.restoreAllMocks();
});

/**
 * These tests cover the WIRING — that the guard runs before the API call, and
 * that responses come back mapped. Which filter a listing requests is a domain
 * decision covered by ownership.test.ts, because the SDK hands `request()` an
 * opaque descriptor that cannot be read back here.
 */
describe('card mutation guards', () => {
  it('refuses to update a card the actor does not own, without calling the API', async () => {
    const spy = vi.spyOn(directus, 'request').mockResolvedValue({});

    await expect(updateCard(user, foreignCard, { status: 'published' })).rejects.toThrow(/only manage your own/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('updates a card the actor owns', async () => {
    const spy = vi.spyOn(directus, 'request').mockResolvedValue({ ...ownCard, status: 'published' });

    await expect(updateCard(user, ownCard, { status: 'published' })).resolves.toMatchObject({ status: 'published' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('lets privileged actors update any card', async () => {
    const spy = vi.spyOn(directus, 'request').mockResolvedValue({});

    await updateCard(admin, foreignCard, { status: 'draft' });
    await updateCard(editor, foreignCard, { status: 'draft' });

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refuses to delete a card the actor does not own, without calling the API', async () => {
    const spy = vi.spyOn(directus, 'request').mockResolvedValue(undefined);

    await expect(deleteCard(user, foreignCard)).rejects.toThrow(/only manage your own/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('deletes a card the actor owns', async () => {
    const spy = vi.spyOn(directus, 'request').mockResolvedValue(undefined);

    await deleteCard(user, ownCard);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('card listing', () => {
  it('returns the rows the API produced, normalised in one request', async () => {
    const spy = vi.spyOn(directus, 'request').mockResolvedValue([ownCard]);

    // A plain user's listing carries no owner email: the expansion is only
    // requested for privileged actors, and this row came back unexpanded.
    await expect(listCards(user)).resolves.toEqual([{ ...ownCard, owner_email: null }]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('card creation', () => {
  it('creates a card with one request', async () => {
    const spy = vi.spyOn(directus, 'request').mockResolvedValue({ id: 'c3' });

    await expect(createCard({ code: 'new123' })).resolves.toEqual({ id: 'c3' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('creates a card on behalf of another owner with one request', async () => {
    const spy = vi.spyOn(directus, 'request').mockResolvedValue({ id: 'c4' });

    await expect(createCard({ code: 'new456' }, 'u-ada')).resolves.toEqual({ id: 'c4' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('user administration', () => {
  it('never offers Administrator as an assignable role', async () => {
    vi.spyOn(directus, 'request').mockResolvedValue([
      { id: 'r1', name: 'Administrator' },
      { id: 'r2', name: 'vcard-user' },
      { id: 'r3', name: 'vcard-editor' },
    ]);

    await expect(listAssignableRoles()).resolves.toEqual([
      { id: 'r2', name: 'vcard-user' },
      { id: 'r3', name: 'vcard-editor' },
    ]);
  });

  it('creates a panel user with a single request', async () => {
    const spy = vi.spyOn(directus, 'request').mockResolvedValue({});

    await expect(
      createPanelUser({ email: 'new@local.dev', password: 'secret123', first_name: 'New', roleId: 'r2' }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

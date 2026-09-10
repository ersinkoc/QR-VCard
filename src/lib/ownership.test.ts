import { describe, expect, it } from 'vitest';
import { assignOwner, canManage, cardScopeFilter, isPrivileged, ownerLabel, PRIVILEGED_ROLES } from './ownership';

const admin = { id: 'u-admin', role_name: 'Administrator' };
const editor = { id: 'u-editor', role_name: 'vcard-editor' };
const user = { id: 'u-ada', role_name: 'vcard-user' };

describe('isPrivileged', () => {
  it('covers exactly the privileged roles', () => {
    expect(PRIVILEGED_ROLES).toEqual(['Administrator', 'vcard-editor']);
    expect(isPrivileged(admin)).toBe(true);
    expect(isPrivileged(editor)).toBe(true);
    expect(isPrivileged(user)).toBe(false);
  });

  it('treats an unknown or blank role as unprivileged', () => {
    expect(isPrivileged({ id: 'x', role_name: 'something-else' })).toBe(false);
    expect(isPrivileged({ id: 'x', role_name: '' })).toBe(false);
  });
});

describe('canManage', () => {
  it('lets privileged actors manage any card', () => {
    expect(canManage({ user_created: 'someone-else' }, admin)).toBe(true);
    expect(canManage({ user_created: 'someone-else' }, editor)).toBe(true);
    expect(canManage({ user_created: null }, editor)).toBe(true);
  });

  it('lets a plain user manage only their own card', () => {
    expect(canManage({ user_created: user.id }, user)).toBe(true);
    expect(canManage({ user_created: 'u-someone-else' }, user)).toBe(false);
  });

  it('refuses a card whose owner is unknown, rather than assuming ownership', () => {
    expect(canManage({ user_created: null }, user)).toBe(false);
    expect(canManage({}, user)).toBe(false);
  });

  it('does not treat a blank owner id as matching a blank actor id', () => {
    expect(canManage({ user_created: '' }, { id: '', role_name: 'vcard-user' })).toBe(false);
  });
});

describe('cardScopeFilter', () => {
  it('scopes a plain user to their own cards', () => {
    expect(cardScopeFilter(user)).toEqual({ user_created: { _eq: user.id } });
  });

  it('applies no filter for privileged actors', () => {
    expect(cardScopeFilter(admin)).toBeUndefined();
    expect(cardScopeFilter(editor)).toBeUndefined();
  });
});

describe('assignOwner', () => {
  it('stamps the given owner onto the payload', () => {
    expect(assignOwner({ code: 'abc' }, user.id)).toEqual({ code: 'abc', user_created: user.id });
  });

  it('leaves the payload untouched when no owner is chosen (Directus stamps the creator)', () => {
    expect(assignOwner({ code: 'abc' })).toEqual({ code: 'abc' });
    expect(assignOwner({ code: 'abc' }, undefined)).toEqual({ code: 'abc' });
    expect(assignOwner({ code: 'abc' }, '   ')).toEqual({ code: 'abc' });
  });

  it('trims the owner id it does send', () => {
    expect(assignOwner({ code: 'abc' }, ` ${user.id} `)).toEqual({ code: 'abc', user_created: user.id });
  });
});

describe('ownerLabel', () => {
  it('names the owner for privileged actors, preferring the email', () => {
    expect(ownerLabel({ user_created: 'u-x', owner_email: 'ada@local.dev' }, admin)).toBe('ada@local.dev');
    expect(ownerLabel({ user_created: admin.id }, admin)).toBe('you');
    expect(ownerLabel({ user_created: 'u-x' }, admin)).toMatch(/^unknown \(u-x/);
    expect(ownerLabel({ user_created: null }, admin)).toBe('unowned');
  });

  it('tells a plain user nothing about other owners', () => {
    expect(ownerLabel({ user_created: 'u-other', owner_email: 'other@local.dev' }, user)).toBe('you');
  });
});

import { describe, expect, it } from 'vitest';
import { stripUser } from './export-directus.mjs';
import { blockingField, cardPayload, userPayload } from './import-directus.mjs';

describe('export-directus', () => {
  it('strips credentials that can never be written back through the API', () => {
    const row = {
      id: 'u1',
      email: 'a@b.c',
      token: 'service-token-that-must-not-leak',
      tfa_secret: 'ABCDEF',
      external_identifier: 'sso-id',
      auth_data: '{}',
      first_name: 'Ada',
    };
    const out = stripUser(row);
    expect(out.token).toBeUndefined();
    expect(out.tfa_secret).toBeUndefined();
    expect(out.external_identifier).toBeUndefined();
    expect(out.auth_data).toBeUndefined();
    expect(out.email).toBe('a@b.c');
    expect(row.token).toBe('service-token-that-must-not-leak'); // original untouched
  });
});

describe('import-directus', () => {
  it('builds a user payload on a whitelist, mapping role and avatar', () => {
    const row = {
      id: 'u1',
      email: 'a@b.c',
      first_name: 'Ada',
      status: 'active',
      username: 'ada',
      qrv_session_epoch: 3,
      avatar: 'file-old',
      password: 'hash-that-would-be-rehashed',
      token: 'never',
      provider: 'sso',
    };
    const out = userPayload(row, { roleId: 'role-1', password: 'temp-pass', fileMap: new Map([['file-old', 'file-new']]) });
    expect(out).toMatchObject({ id: 'u1', email: 'a@b.c', role: 'role-1', password: 'temp-pass', avatar: 'file-new', qrv_session_epoch: 3 });
    expect(out.provider).toBeUndefined();
    expect(out.token).toBeUndefined();
    expect(out.password).toBe('temp-pass'); // never the exported hash
  });

  it('nulls the avatar when the file did not make it to the target', () => {
    const out = userPayload({ id: 'u1', email: 'a@b.c', avatar: 'missing' }, { roleId: 'r' });
    expect(out.avatar).toBeNull();
    expect(out.role).toBe('r');
  });

  it('remaps card owner and photo onto target ids, dropping user_created', () => {
    const row = { id: 'c1', code: 'demo-01', owner: 'src-user', photo: 'src-file', user_created: 'whoever', status: 'published' };
    const out = cardPayload(row, { userMap: new Map([['src-user', 'dst-user']]), fileMap: new Map([['src-file', 'dst-file']]) });
    expect(out.owner).toBe('dst-user');
    expect(out.photo).toBe('dst-file');
    expect(out.user_created).toBeUndefined();
    expect(out.code).toBe('demo-01');
  });

  it('nulls dangling card references instead of writing source ids', () => {
    const out = cardPayload({ id: 'c1', code: 'x', owner: 'gone', photo: 'gone' });
    expect(out.owner).toBeNull();
    expect(out.photo).toBeNull();
  });

  it('finds the field a Directus error blames, limited to the droppable list', () => {
    const body = { id: 'u1', username: 'ada', email: 'a@b.c' };
    const err = '400 POST /users: ["\\"username\\" has to be unique"]';
    expect(blockingField(err, body, ['qrv_session_epoch', 'username', 'id'])).toBe('username');
    expect(blockingField(err, body, ['qrv_session_epoch'])).toBeUndefined();
    expect(blockingField(err, { email: 'a@b.c' }, ['username'])).toBeUndefined();
  });
});

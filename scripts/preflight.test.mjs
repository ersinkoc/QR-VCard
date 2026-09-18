import { describe, expect, it } from 'vitest';
import { probeToken, validateEnv, waitForDirectus } from './preflight.mjs';

const GOOD = {
  DIRECTUS_URL: 'https://cms.acme.io',
  DIRECTUS_TOKEN: 'a'.repeat(32),
  SESSION_SECRET: 'b'.repeat(64),
  PUBLIC_URL: 'https://kart.acme.io',
  TRUST_PROXY: '1',
  QR_API_KEY: 'k1',
};

describe('validateEnv', () => {
  it('accepts a complete configuration without warnings', () => {
    expect(validateEnv(GOOD)).toEqual({ errors: [], warnings: [] });
  });

  it('requires DIRECTUS_URL and DIRECTUS_TOKEN', () => {
    const { errors } = validateEnv({});
    expect(errors.some((e) => e.startsWith('DIRECTUS_URL'))).toBe(true);
    expect(errors.some((e) => e.startsWith('DIRECTUS_TOKEN'))).toBe(true);
  });

  it('refuses the .env.example placeholders', () => {
    const { errors } = validateEnv({
      ...GOOD,
      DIRECTUS_URL: 'https://directus.example.com',
      DIRECTUS_TOKEN: 'replace-with-directus-administrator-static-token',
      SESSION_SECRET: 'replace-with-openssl-rand-hex-32',
    });
    expect(errors).toHaveLength(3);
  });

  it.each([
    ['DIRECTUS_URL', 'directus:8055'],
    ['PUBLIC_URL', 'kart.acme.io'],
    ['PUBLIC_URL', 'https://kart.acme.io/app'],
    ['SESSION_SECRET', 'short'],
    ['PORT', 'eighty'],
  ])('rejects a malformed %s', (name, value) => {
    const { errors } = validateEnv({ ...GOOD, [name]: value });
    expect(errors.some((e) => e.startsWith(name))).toBe(true);
  });

  it('accepts a Docker service name as DIRECTUS_URL', () => {
    expect(validateEnv({ ...GOOD, DIRECTUS_URL: 'http://directus:8055' }).errors).toEqual([]);
  });

  it('only warns about the optional settings', () => {
    const { errors, warnings } = validateEnv({ DIRECTUS_URL: GOOD.DIRECTUS_URL, DIRECTUS_TOKEN: GOOD.DIRECTUS_TOKEN });
    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.split(' ')[0])).toEqual(['SESSION_SECRET', 'PUBLIC_URL', 'TRUST_PROXY', 'QR_API_KEY']);
  });
});

const response = (status, data) => ({ ok: status < 400, status, json: async () => ({ data }) });

describe('waitForDirectus', () => {
  it('retries until Directus answers', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return response(200);
    };
    await expect(waitForDirectus({ url: 'http://d', fetchImpl, intervalMs: 1, timeoutMs: 30_000 })).resolves.toEqual({ ok: true, attempts: 3 });
  });

  it('gives up after the timeout with the last error', async () => {
    const fetchImpl = async () => response(503);
    const result = await waitForDirectus({ url: 'http://d', fetchImpl, intervalMs: 5, timeoutMs: 20 });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HTTP 503');
  });
});

describe('probeToken', () => {
  const directus = (routes) => async (url) => {
    const path = new URL(url).pathname;
    return routes[path] ?? response(404);
  };

  it('recognises an Administrator token', async () => {
    const fetchImpl = directus({ '/users/me': response(200, { id: 'u1', email: 'a@acme.io', role: { name: 'Administrator' } }), '/roles': response(200, []) });
    await expect(probeToken({ url: 'http://d', token: 't', fetchImpl })).resolves.toMatchObject({ valid: true, admin: true, identity: 'a@acme.io' });
  });

  it('flags a valid token without Administrator access', async () => {
    const fetchImpl = directus({ '/users/me': response(200, { id: 'u1', role: { name: 'vcard-user' } }), '/roles': response(403) });
    await expect(probeToken({ url: 'http://d', token: 't', fetchImpl })).resolves.toMatchObject({ valid: true, admin: false });
  });

  it('reports a rejected token', async () => {
    const fetchImpl = directus({ '/users/me': response(401) });
    const result = await probeToken({ url: 'http://d', token: 't', fetchImpl });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/rejected/);
  });

  it('reports an unreachable Directus', async () => {
    const fetchImpl = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(probeToken({ url: 'http://d', token: 't', fetchImpl })).resolves.toMatchObject({ valid: false, error: expect.stringMatching(/unreachable/) });
  });
});

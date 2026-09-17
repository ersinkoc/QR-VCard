import { describe, expect, it } from 'vitest';
import { bootstrapEnabled, bootstrapEnvironment } from './start-production.mjs';

describe('production startup', () => {
  it('provisions Directus by default', () => {
    expect(bootstrapEnabled({})).toBe(true);
  });

  it.each(['0', 'false', 'NO', 'off'])('can explicitly disable provisioning with %s', (value) => {
    expect(bootstrapEnabled({ DIRECTUS_BOOTSTRAP: value })).toBe(false);
  });

  it('keeps provisioning enabled for an explicit truthy value', () => {
    expect(bootstrapEnabled({ DIRECTUS_BOOTSTRAP: '1' })).toBe(true);
  });

  it('forces bootstrap into read-only runtime mode with demo data disabled', () => {
    expect(bootstrapEnvironment({ DIRECTUS_URL: 'https://directus.example.com' })).toMatchObject({
      DIRECTUS_URL: 'https://directus.example.com',
      BOOTSTRAP_RUNTIME: '1',
      BOOTSTRAP_SEED_DEMO: '0',
    });
  });
});

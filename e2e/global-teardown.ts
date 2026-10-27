#!/usr/bin/env node
/** Deletes the throwaway E2E accounts (see global-setup.ts) and the credentials file. */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { OUT_FILE, directusClient, readRootEnv } from './global-setup.js';

export default async function globalTeardown() {
  // The smoke project provisions nothing, so there is nothing to clean up.
  if (!existsSync(OUT_FILE)) return;
  let accounts: { admin: { email: string }; editor: { email: string }; user: { email: string } };
  try {
    accounts = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  } catch {
    rmSync(OUT_FILE, { force: true });
    return;
  }

  try {
    const env = readRootEnv();
    const base = (env.DIRECTUS_URL || 'http://localhost:8055').replace(/\/+$/, '');
    const api = directusClient(base, env.DIRECTUS_TOKEN || '');
    const rows = (await api.request('/users', { query: { 'filter[email][_starts_with]': 'e2e-', 'fields': 'id,email', 'limit': '-1' } })) as { id: string; email: string }[];
    const disposable = rows.filter((user) => /^e2e-(?:admin|editor|user|probe)-[a-z0-9]+@example\.com$/i.test(user.email));
    for (const user of disposable) {
      const cards = (await api.request('/items/vcards', { query: { 'filter[owner][_eq]': user.id, 'fields': 'id,photo,logo', 'limit': '-1' } })) as { id: string; photo?: string | null; logo?: string | null }[];
      for (const card of cards) {
        await api.request(`/items/vcards/${card.id}`, { method: 'DELETE' });
        for (const fileId of [card.photo, card.logo].filter(Boolean)) {
          await api.request(`/files/${fileId}`, { method: 'DELETE' }).catch(() => null);
        }
      }
      await api.request(`/users/${user.id}`, { method: 'DELETE' });
    }
    process.stdout.write(`[e2e] teardown: ${disposable.length} test account(s) deleted\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`[e2e] teardown: could not delete accounts (${message}) — delete ${accounts.admin.email} etc. manually\n`);
  } finally {
    rmSync(OUT_FILE, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  globalTeardown().catch((err) => {
    console.error(`[e2e] teardown failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}

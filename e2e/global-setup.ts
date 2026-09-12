#!/usr/bin/env node
/**
 * Global setup for the Playwright E2E suite.
 *
 *  1. waits for Directus to answer (clear message if the container is down),
 *  2. checks that dist/ exists (the webServer serves the BUILT app),
 *  3. runs `npm run directus:bootstrap` (idempotent — heals drift, seeds roles),
 *  4. provisions throwaway accounts (admin / editor / user) through the service
 *     token and records their credentials in .playwright/.accounts.json.
 *
 * Tests never touch the seed accounts: every run gets its own identities and
 * global-teardown.ts deletes them again.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_FILE = join(ROOT, '.playwright', '.accounts.json');

function readRootEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2]!.trim() !== '') out[m[1]!] = m[2]!.trim();
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function directusReady(base: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${base}/server/ping`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(1500);
  }
  return false;
}

interface DirectusLike {
  request(path: string, opts?: { method?: string; query?: Record<string, unknown>; body?: unknown; auth?: string | null }): Promise<any>;
}

function directusClient(base: string, token: string): DirectusLike {
  async function request(path: string, { method = 'GET', query, body, auth = token } = {} as any) {
    const qs = query
      ? '?' +
        Object.entries(query)
          .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    const res = await fetch(`${base}${path}${qs}`, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Directus ${res.status} ${method} ${path}: ${JSON.stringify(json?.errors ?? json)}`);
    return json?.data ?? null;
  }
  return { request };
}

export default async function globalSetup() {
  // The smoke project only needs a running deployment; it uses no throwaway
  // accounts and (against a remote SMOKE_BASE_URL) has no Directus of its own.
  // Detect it by the SMOKE_BASE_URL env var or by the requested project(s).
  const projectFlag = /--project[= ]+([^\s]+)/.exec(process.argv.join(' '))?.[1] ?? '';
  const projects = projectFlag ? projectFlag.split(',') : [];
  if (process.env.SMOKE_BASE_URL || (projects.length > 0 && !projects.includes('panel'))) {
    process.stdout.write('[e2e] smoke project: skipping Directus bootstrap and account provisioning\n');
    return;
  }

  const env = readRootEnv();
  const base = (env.DIRECTUS_URL || 'http://localhost:8055').replace(/\/+$/, '');
  const token = env.DIRECTUS_TOKEN || '';

  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html not found — E2E runs the built app; run `npm run build` first');
  }
  process.stdout.write(`[e2e] waiting for Directus at ${base}…\n`);
  if (!(await directusReady(base))) {
    throw new Error(`Directus did not answer at ${base} — start it with \`npm run directus:up\` first`);
  }

  process.stdout.write('[e2e] running directus:bootstrap (idempotent)…\n');
  const boot = spawnSync('npm', ['run', 'directus:bootstrap'], { cwd: ROOT, shell: process.platform === 'win32', stdio: 'inherit' });
  if (boot.status !== 0) throw new Error('directus:bootstrap failed — see the log above');

  if (!token) throw new Error('DIRECTUS_TOKEN missing in .env — run npm run directus:bootstrap');
  const api = directusClient(base, token);

  const roles: { id: string; name: string }[] = await api.request('/roles', { query: { 'limit': '-1', 'fields': 'id,name' } });
  const roleId = (name: string) => {
    const hit = roles.find((r) => r.name === name);
    if (!hit) throw new Error(`role "${name}" not found — bootstrap should have created it`);
    return hit.id;
  };

  const run = Math.random().toString(36).slice(2, 8);
  const password = `E2e-${run}-Passw0rd!`;
  const accounts = {
    run,
    base,
    admin: { email: `e2e-admin-${run}@example.com`, password },
    editor: { email: `e2e-editor-${run}@example.com`, password },
    user: { email: `e2e-user-${run}@example.com`, password },
  };

  const create = async (email: string, role: string, first: string) => {
    await api.request('/users', { method: 'POST', body: { email, password, role, status: 'active', first_name: first, last_name: 'E2E' } });
  };
  await create(accounts.admin.email, roleId('Administrator'), 'Admin');
  await create(accounts.editor.email, roleId('vcard-editor'), 'Editor');
  await create(accounts.user.email, roleId('vcard-user'), 'User');

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(accounts, null, 2));
  process.stdout.write(`[e2e] accounts ready (run ${run})\n`);
}

/** Exported so global-teardown reuses the same parsing rules. */
export { readRootEnv, OUT_FILE, directusClient };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  globalSetup().catch((err) => {
    console.error(`[e2e] setup failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}

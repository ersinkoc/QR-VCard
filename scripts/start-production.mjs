#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const disabled = new Set(['0', 'false', 'no', 'off']);

export function bootstrapEnabled(env = process.env) {
  return !disabled.has(String(env.DIRECTUS_BOOTSTRAP ?? '1').trim().toLowerCase());
}

export function bootstrapEnvironment(env = process.env) {
  return {
    ...env,
    BOOTSTRAP_RUNTIME: '1',
    BOOTSTRAP_SEED_DEMO: env.BOOTSTRAP_SEED_DEMO ?? '0',
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  if (bootstrapEnabled()) {
    if (!process.env.DIRECTUS_URL?.trim() || !process.env.DIRECTUS_TOKEN?.trim()) {
      console.error('[startup] DIRECTUS_URL and DIRECTUS_TOKEN are required for automatic provisioning');
      process.exitCode = 1;
      return;
    }

    console.log('[startup] provisioning Directus schema (idempotent, read-only filesystem, demo seed disabled)');
    const result = await run(process.execPath, ['directus/bootstrap.mjs'], {
      env: bootstrapEnvironment(),
    });
    if (result.code !== 0) {
      console.error(`[startup] Directus provisioning failed${result.signal ? ` (${result.signal})` : ` (exit ${result.code})`}`);
      process.exitCode = result.code || 1;
      return;
    }
  } else {
    console.log('[startup] automatic Directus provisioning disabled');
  }

  const server = spawn(process.execPath, ['server/serve.mjs'], { stdio: 'inherit', env: process.env });
  const forward = (signal) => server.kill(signal);
  process.once('SIGTERM', () => forward('SIGTERM'));
  process.once('SIGINT', () => forward('SIGINT'));
  server.once('error', (error) => {
    console.error(`[startup] server failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  server.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`[startup] FAILED: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
/**
 * Production entry point (Docker CMD, nixpacks start):
 *
 *   1. validate the runtime environment      — one readable line per problem, exit 1
 *   2. wait for Directus to answer            — up to DIRECTUS_WAIT_SECONDS (default 120)
 *   3. check DIRECTUS_TOKEN                   — accepted, and Administrator when provisioning
 *   4. provision / repair the Directus schema — directus/bootstrap.mjs, idempotent, retried
 *   5. run the app server                     — server/serve.mjs, signals forwarded
 *
 * Steps 2–4 are what make a first deploy "just work": the schema is created on an
 * empty Directus, repaired on an old one, and an app started alongside a Directus
 * that is still booting waits for it instead of crash-looping.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapWanted, probeToken, validateEnv, waitForDirectus } from './preflight.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP_ATTEMPTS = 3;

export function bootstrapEnabled(env = process.env) {
  return bootstrapWanted(env);
}

export function bootstrapEnvironment(env = process.env) {
  return {
    ...env,
    BOOTSTRAP_RUNTIME: '1',
    BOOTSTRAP_SEED_DEMO: env.BOOTSTRAP_SEED_DEMO ?? '0',
  };
}

export function waitSeconds(env = process.env) {
  const n = Number.parseInt(String(env.DIRECTUS_WAIT_SECONDS ?? ''), 10);
  return Number.isInteger(n) && n >= 0 ? n : 120;
}

const log = (message) => console.log(`[startup] ${message}`);
const fail = (message) => console.error(`[startup] ERROR: ${message}`);

let child = null;
let stopping = false;

function run(command, args, options = {}) {
  return new Promise((done, reject) => {
    child = spawn(command, args, { stdio: 'inherit', cwd: ROOT, ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      child = null;
      done({ code, signal });
    });
  });
}

// Registered before anything else: as PID 1 in a container, node ignores
// SIGTERM unless it handles it, so `docker stop` during provisioning would
// otherwise wait out its timeout and SIGKILL.
function onSignal(signal) {
  stopping = true;
  if (child) child.kill(signal);
  else process.exit(signal === 'SIGINT' ? 130 : 143);
}

function commitSha() {
  try {
    const sha = readFileSync(join(ROOT, '.commit-sha'), 'utf8').trim();
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 12) : null;
  } catch {
    return null;
  }
}

async function provision(env) {
  const url = env.DIRECTUS_URL.trim();
  const timeoutMs = waitSeconds(env) * 1000;
  const reach = await waitForDirectus({ url, timeoutMs, log });
  if (!reach.ok) {
    fail(`Directus at ${url} did not answer within ${waitSeconds(env)}s (${reach.error}). Check DIRECTUS_URL — from inside the container "localhost" is the container itself, not the host.`);
    return false;
  }
  log(`Directus reachable at ${url}`);

  const probe = await probeToken({ url, token: env.DIRECTUS_TOKEN.trim() });
  if (!probe.valid) {
    fail(`${probe.error}. Create a static token in Directus (Users → your admin user → Token → generate, then Save) and put it in DIRECTUS_TOKEN.`);
    return false;
  }
  if (!probe.admin) {
    fail(`DIRECTUS_TOKEN belongs to ${probe.identity}${probe.roleName ? ` (role ${probe.roleName})` : ''}, which lacks Administrator access. Automatic provisioning needs an Administrator token — or set DIRECTUS_BOOTSTRAP=0 if the schema is managed separately.`);
    return false;
  }
  log(`DIRECTUS_TOKEN accepted (${probe.identity}, Administrator)`);

  for (let attempt = 1; attempt <= BOOTSTRAP_ATTEMPTS; attempt += 1) {
    log(`provisioning Directus schema (idempotent; demo data ${bootstrapEnvironment(env).BOOTSTRAP_SEED_DEMO === '1' ? 'ON' : 'off'})${attempt > 1 ? ` — attempt ${attempt}/${BOOTSTRAP_ATTEMPTS}` : ''}`);
    const result = await run(process.execPath, ['directus/bootstrap.mjs'], { env: bootstrapEnvironment(env) });
    if (stopping) return false;
    if (result.code === 0) return true;
    fail(`Directus provisioning failed${result.signal ? ` (${result.signal})` : ` (exit ${result.code})`}`);
    if (attempt < BOOTSTRAP_ATTEMPTS) await new Promise((done) => setTimeout(done, attempt * 5_000));
  }
  return false;
}

async function main() {
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  const sha = commitSha();
  log(`QR-VCard${sha ? ` ${sha}` : ''} on Node ${process.versions.node}`);

  const { errors, warnings } = validateEnv(process.env);
  for (const w of warnings) log(`warning: ${w}`);
  if (errors.length) {
    for (const e of errors) fail(e);
    fail(`${errors.length} configuration problem(s) — fix the variables above and redeploy`);
    process.exitCode = 1;
    return;
  }

  if (bootstrapEnabled()) {
    if (!(await provision(process.env))) {
      process.exitCode = 1;
      return;
    }
  } else {
    log('automatic Directus provisioning disabled (DIRECTUS_BOOTSTRAP=0)');
  }

  if (stopping) return;
  const result = await run(process.execPath, ['server/serve.mjs'], { env: process.env });
  if (stopping) {
    process.exitCode = 0;
    return;
  }
  fail(`server exited${result.signal ? ` (${result.signal})` : ` (exit ${result.code})`}`);
  process.exitCode = result.code || 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    fail(error?.message ?? String(error));
    process.exitCode = 1;
  });
}

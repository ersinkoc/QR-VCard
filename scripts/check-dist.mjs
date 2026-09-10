#!/usr/bin/env node
/**
 * Deployment gate for the BUILT bundle — `npm run deploy:check` after `npm run build`.
 *
 * The platform build (nixpacks.toml / root Dockerfile) inlines VITE_* values at
 * build time, and the one mistake that cannot be fixed at runtime is shipping the
 * wrong bundle. This gate catches the two known ways that happens:
 *
 *   1. The dev-default Directus URL (`localhost:8055`) inlined into the bundle —
 *      a public visitor's browser would then call its own machine. This actually
 *      shipped once: the first Docker image was built without --build-arg.
 *   2. A server-side secret NAME (DIRECTUS_ADMIN_TOKEN, QR_API_KEY) in the bundle —
 *      everything under dist/ is public; if the name is there, the wiring leaks.
 *
 * Plus one loud warning, not a failure: any plain `http://` (non-localhost) URL in
 * the JS. A https page calling http is blocked as mixed content, which is exactly
 * how a live site dies quietly; override with ALLOW_INSECURE_DIRECTUS_URL=1 when a
 * plain-http Directus really is intended.
 *
 * Scans text-like files under dist/ (5 MB cap per file). Run: npm run deploy:check
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

const DIST = process.env.DIST_DIR || 'dist';
const SCAN_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.txt', '.svg']);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SECRET_NAMES = ['DIRECTUS_ADMIN_TOKEN', 'QR_API_KEY'];
const DEV_DEFAULT_URL = 'localhost:8055';

let scanned = 0;
const failures = [];
const warnings = [];

async function walk(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true }))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (!SCAN_EXT.has(extname(entry.name).toLowerCase())) continue;
    if ((await stat(full)).size > MAX_FILE_BYTES) {
      warnings.push(`${relative(DIST, full)}: skipped (over ${MAX_FILE_BYTES} bytes)`);
      continue;
    }
    scanned += 1;
    const rel = relative(DIST, full).split(sep).join('/');
    const text = await readFile(full, 'utf8');

    if (text.includes(DEV_DEFAULT_URL)) {
      failures.push(
        `${rel}: the dev-default Directus URL (${DEV_DEFAULT_URL}) is in the bundle. ` +
          `A public visitor's browser would call its own machine. Rebuild with ` +
          `VITE_DIRECTUS_URL=https://<your-directus> (deploy platform variable or build arg).`,
      );
    }
    for (const name of SECRET_NAMES) {
      if (text.includes(name)) {
        failures.push(
          `${rel}: the server-side secret name ${name} appears in the bundle. ` +
            `Everything under dist/ is public — the token/key must exist only in ` +
            `server/runtime env (QR_API_KEY) or ops scripts (DIRECTUS_ADMIN_TOKEN).`,
        );
      }
    }
    // Mixed-content probe: a https deployment cannot call a plain-http URL from the
    // browser. Not a hard failure only because a deliberately plain-http setup may
    // be intentional (staging on http) — set ALLOW_INSECURE_DIRECTUS_URL=1 to mute.
    if (process.env.ALLOW_INSECURE_DIRECTUS_URL === '1') continue;
    const insecure = [...text.matchAll(/http:\/\/(?!localhost|127\.0\.0\.1)[^\s"'`<>)\\]]+/g)].map((m) => m[0]);
    for (const url of new Set(insecure).values()) {
      warnings.push(
        `${rel}: plain-http URL in client bundle: ${url} — a https page cannot call this ` +
          `(mixed content). If intentional, set ALLOW_INSECURE_DIRECTUS_URL=1.`,
      );
    }
  }
}

let htmlExists = false;
let hasJsAsset = false;
try {
  await stat(join(DIST, 'index.html'));
  htmlExists = true;
} catch {
  failures.push(`${DIST}/index.html not found — run \`npm run build\` first (or set DIST_DIR).`);
}
try {
  const assets = await readdir(join(DIST, 'assets'));
  hasJsAsset = assets.some((f) => f.endsWith('.js'));
  if (!hasJsAsset) failures.push(`${DIST}/assets/ contains no .js bundle — the build output looks wrong.`);
} catch {
  if (htmlExists) failures.push(`${DIST}/assets/ not found — the build output looks wrong.`);
}

await walk(DIST);

for (const w of [...new Set(warnings)].slice(0, 10)) console.warn(`WARN  ${w}`);
for (const f of failures) console.error(`FAIL  ${f}`);
console.log(`checked ${scanned} file(s) under ${DIST}/`);
if (failures.length > 0) {
  console.error(`\ndeploy:check FAILED with ${failures.length} problem(s). Do not ship this bundle.`);
  process.exitCode = 1;
} else {
  console.log('deploy:check OK — no dev-default URL, no secret names, structure intact.');
}

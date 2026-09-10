#!/usr/bin/env node
/**
 * Syntax-checks every `.mjs` under scripts/, server/ and directus/.
 *
 * Why this exists: those files sit outside both existing gates. `tsc --noEmit`
 * only covers TypeScript, and `vitest run` only picks up `*.test.ts`. A plain
 * script with a broken parse is therefore not caught until it is actually run.
 *
 * Scope, stated honestly: `node --check` parses without executing, so this catches
 * SYNTAX errors only. It does NOT catch undefined identifiers — the
 * `ReferenceError` in `scripts/dev-all.mjs` that prompted this gate was a runtime
 * error and still slips through, and this repo has no linter config, so nothing
 * currently covers that class. (Verified: `node --check` passes on a file whose
 * only defect is an undefined variable.)
 *
 * Parsing runs nothing, so this is safe for the scripts that mutate state or need
 * credentials.
 *
 * Run: npm run scripts:check
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIRS = ['scripts', 'server', 'directus'];

let checked = 0;
const failures = [];

for (const dir of DIRS) {
  const files = readdirSync(dir)
    .filter((entry) => entry.endsWith('.mjs'))
    .sort();

  for (const entry of files) {
    const file = join(dir, entry);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      checked += 1;
    } catch (err) {
      const detail = err.stderr?.toString().trim() || err.message;
      failures.push(`${file}\n${detail}`);
    }
  }
}

console.log(`checked ${checked} script(s) in ${DIRS.join(', ')}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} script(s) failed to parse:\n`);
  console.error(failures.join('\n\n'));
  process.exitCode = 1;
}

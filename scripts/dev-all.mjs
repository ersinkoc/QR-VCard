#!/usr/bin/env node
/**
 * Runs the app and the QR proxy together, so development needs one command:
 *
 *   npm run dev:all
 *
 * Written by hand instead of pulling in `concurrently`: it is small, and this
 * repo keeps its tooling dependency-free (see scripts/ and directus/).
 *
 * Ctrl+C stops both. If one side exits on its own, the other is stopped too —
 * on Windows through `taskkill /T`, because `child.kill()` only reaps the shell
 * we spawned and leaves the real server running with its port still bound.
 */
import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (isWindows) {
      // Observed failure without /T: after `[app] stopped (SIGTERM)` the Vite
      // process was still listening on its port, because the signal only
      // reached the npm shell. /T kills the whole tree under it.
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        /* best effort */
      }
    } else {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
  process.exitCode = code;
}

function start(label, script) {
  // Windows needs a shell, and not for cosmetic reasons: since the
  // CVE-2024-27980 fix, spawning a `.cmd` (npm.cmd) without one throws
  // `Error: spawn EINVAL`. The command is passed as a single string there,
  // because `shell: true` together with an args array is deprecated (DEP0190) —
  // arguments would be concatenated unescaped. On POSIX the args form is kept,
  // which avoids a shell entirely.
  const child = isWindows
    ? spawn(`npm run ${script}`, { stdio: ['ignore', 'pipe', 'pipe'], shell: true })
    : spawn('npm', ['run', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `[${label}] `;
  const forward = (stream, sink) => {
    stream.on('data', (chunk) => {
      const text = chunk.toString().replace(/\s+$/, '');
      if (text) sink(prefix + text.replace(/\n/g, `\n${prefix}`));
    });
  };
  forward(child.stdout, (text) => console.log(text));
  forward(child.stderr, (text) => console.error(text));
  child.on('exit', (code, signal) => {
    console.log(`${prefix}stopped (${signal ?? code})`);
    stop(code ?? 0);
  });
  children.push(child);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

start('app', 'dev');
start('qr-proxy', 'qr:proxy');

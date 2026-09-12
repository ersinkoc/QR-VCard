/**
 * Structured logging for the app server: one JSON object per line, so a
 * collector (Docker log driver, Loki, journalctl -o json, ...) can parse
 * without regexes. Human-readable text stays available for local debugging.
 *
 *   LOG_FORMAT   json (default) | text
 *   LOG_SLOW_MS  requests slower than this are flagged "slow" (default 1000)
 *   LOG_HEALTH   1 = log /healthz and /api/health too (skipped by default;
 *                the container healthcheck would flood the log otherwise)
 *
 * Every line carries `t` (ISO time), `lvl`, `msg` and — for requests —
 * `req_id`, `method`, `path`, `status`, `ms`, `bytes`, `type` ("api" | "qr" |
 * "static") plus, when flagged, `slow: true` or an `err` object. Request ids
 * come from `X-Request-Id` when a reverse proxy supplies one, else a random
 * id is minted; the id is echoed back to the client as `X-Request-Id`.
 */
import { randomUUID } from 'node:crypto';

export function loggerConfigFromEnv(env = process.env) {
  return {
    format: env.LOG_FORMAT === 'text' ? 'text' : 'json',
    slowMs: Number.parseInt(env.LOG_SLOW_MS ?? '', 10) || 1000,
    logHealth: env.LOG_HEALTH === '1',
  };
}

export function createLogger(config = loggerConfigFromEnv()) {
  const json = config.format !== 'text';
  const now = config.now ?? Date.now; // injectable for tests
  // Normalised here so partial configs (tests, embedders) get the defaults.
  const slowMs = Number.isFinite(config.slowMs) ? config.slowMs : 1000;
  const logHealth = config.logHealth === true;

  function emit(lvl, msg, fields) {
    if (json) {
      const line = JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...fields });
      (lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(line);
    } else {
      const extras = Object.entries(fields ?? {})
        .filter(([k]) => !['req_id', 'method', 'path', 'status', 'ms', 'type'].includes(k))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(' ');
      const base = fields?.req_id ? `${fields.method} ${fields.path} ${fields.status ?? '-'} ${fields.req_id}` : msg;
      const line = `${base}${fields?.ms !== undefined ? ` ${fields.ms}ms` : ''}${extras ? ` ${extras}` : ''}`;
      (lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(line);
    }
  }

  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),

    /** Bridge for the existing `[api] …` / `[qr] …` text lines. */
    scoped: (tag) => ({
      log: (...args) => emit('info', args.join(' '), { tag }),
      warn: (...args) => emit('warn', args.join(' '), { tag }),
      error: (...args) => emit('error', args.join(' '), { tag }),
    }),

    /**
     * Request logging. `start` is called when a request arrives — it stamps
     * the id and returns the echo header; `finish` (wired to the response's
     * `finish` event by serve.mjs) writes the access line, flagging slow
     * requests and attaching the error of a failed handler.
     */
    start(req, res) {
      const reqId = (typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].slice(0, 64)) || randomUUID();
      const started = now();
      if (!res.headersSent) res.setHeader('X-Request-Id', reqId);
      let done = false;
      return {
        id: reqId,
        finish(status, { bytes, error, type = 'static' } = {}) {
          if (done) return;
          done = true;
          const ms = now() - started;
          const path = (req.url ?? '/').split('?')[0];
          const fields = { req_id: reqId, type, method: req.method, path, status, ms, ...(bytes !== undefined ? { bytes } : {}) };
          if (error) fields.err = { name: error?.name ?? 'Error', message: String(error?.message ?? error) };
          if (ms >= slowMs) fields.slow = true;
          // Failures always speak up — a failing healthcheck is exactly the
          // signal a container orchestrator acts on. Successful healthchecks
          // are noise (the container probe runs every few seconds) and stay
          // silent unless LOG_HEALTH=1; everything else is an access line.
          if (error || status >= 500) emit('error', 'request failed', fields);
          else if (!logHealth && (path === '/healthz' || path === '/api/health')) return;
          else if (fields.slow) emit('warn', 'slow request', fields);
          else emit('info', 'request', fields);
        },
      };
    },
  };
}

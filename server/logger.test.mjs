import { describe, expect, it } from 'vitest';
import { createLogger, loggerConfigFromEnv } from './logger.mjs';

/** Captures everything the logger emits. */
function capture() {
  const lines = [];
  const push = (lvl) => (...args) => lines.push({ lvl, raw: args.join(' ') });
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = push('info');
  console.warn = push('warn');
  console.error = push('error');
  return {
    lines,
    restore() {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    },
  };
}

function fakeRes(headers = {}) {
  return {
    headersSent: false,
    statusCode: 200,
    _headers: headers,
    setHeader(k, v) {
      this._headers[k] = v;
    },
    getHeader(k) {
      return this._headers[k];
    },
  };
}

describe('loggerConfigFromEnv', () => {
  it('defaults to json, 1000ms slow threshold, health skipped', () => {
    expect(loggerConfigFromEnv({})).toEqual({ format: 'json', slowMs: 1000, logHealth: false });
    expect(loggerConfigFromEnv({ LOG_FORMAT: 'text', LOG_SLOW_MS: '250', LOG_HEALTH: '1' })).toEqual({
      format: 'text',
      slowMs: 250,
      logHealth: true,
    });
  });
});

describe('createLogger (json)', () => {
  it('emits one JSON object per line with the base fields', () => {
    const cap = capture();
    try {
      const log = createLogger({ format: 'json' });
      log.info('hello', { k: 1 });
      log.warn('careful');
      log.error('boom', { err: { name: 'Error', message: 'x' } });
      const parsed = cap.lines.map((l) => JSON.parse(l.raw));
      expect(parsed[0]).toMatchObject({ lvl: 'info', msg: 'hello', k: 1 });
      expect(parsed[0].t).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(parsed[1]).toMatchObject({ lvl: 'warn', msg: 'careful' });
      expect(parsed[2]).toMatchObject({ lvl: 'error', err: { message: 'x' } });
    } finally {
      cap.restore();
    }
  });

  it('scopes existing text lines into tagged JSON', () => {
    const cap = capture();
    try {
      const log = createLogger({ format: 'json' });
      log.scoped('api').warn('[api] something degraded');
      const line = JSON.parse(cap.lines[0].raw);
      expect(line).toMatchObject({ lvl: 'warn', tag: 'api', msg: '[api] something degraded' });
    } finally {
      cap.restore();
    }
  });

  describe('request lifecycle', () => {
    it('stamps X-Request-Id, honours an upstream id and logs the access line', () => {
      const cap = capture();
      try {
        const log = createLogger({ format: 'json' });
        const res = fakeRes();
        const r = log.start({ method: 'GET', url: '/api/cards?x=1', headers: { 'x-request-id': 'abc-123' } }, res);
        expect(r.id).toBe('abc-123');
        expect(res.getHeader('X-Request-Id')).toBe('abc-123');
        res.statusCode = 200;
        r.finish(200, { type: 'api', bytes: 42 });
        const line = JSON.parse(cap.lines[0].raw);
        expect(line).toMatchObject({ lvl: 'info', req_id: 'abc-123', type: 'api', method: 'GET', path: '/api/cards', status: 200, ms: 0, bytes: 42 });
        expect(line.path).not.toContain('?');
      } finally {
        cap.restore();
      }
    });

    it('flags slow requests as warn with slow:true', () => {
      const cap = capture();
      try {
        let t = 0;
        const log = createLogger({ format: 'json', now: () => t });
        const r = log.start({ method: 'GET', url: '/panel', headers: {} }, fakeRes());
        t = 1500; // ms later
        r.finish(200, { type: 'static' });
        const line = JSON.parse(cap.lines[0].raw);
        expect(line).toMatchObject({ lvl: 'warn', slow: true, ms: 1500 });
      } finally {
        cap.restore();
      }
    });

    it('emits fast successful requests as plain info', () => {
      const cap = capture();
      try {
        let t = 0;
        const log = createLogger({ format: 'json', now: () => t });
        const r = log.start({ method: 'GET', url: '/c/demo-01', headers: {} }, fakeRes());
        t = 5;
        r.finish(200, { type: 'static' });
        expect(cap.lines[0].lvl).toBe('info');
        expect(JSON.parse(cap.lines[0].raw).slow).toBeUndefined();
      } finally {
        cap.restore();
      }
    });

    it('reports failures at error level with the error attached', () => {
      const cap = capture();
      try {
        const log = createLogger({ format: 'json' });
        const r = log.start({ method: 'POST', url: '/api/cards', headers: {} }, fakeRes());
        r.finish(500, { type: 'api', error: new Error('Directus unreachable') });
        const line = JSON.parse(cap.lines[0].raw);
        expect(line).toMatchObject({ lvl: 'error', status: 500, err: { message: 'Directus unreachable' } });
      } finally {
        cap.restore();
      }
    });

    it('skips health endpoints unless LOG_HEALTH=1', () => {
      const cap = capture();
      try {
        const log = createLogger({ format: 'json' });
        for (const url of ['/healthz', '/api/health']) {
          const r = log.start({ method: 'GET', url, headers: {} }, fakeRes());
          r.finish(200, { type: 'api' });
        }
        expect(cap.lines).toHaveLength(0);

        const loud = createLogger({ format: 'json', logHealth: true });
        const r = loud.start({ method: 'GET', url: '/healthz', headers: {} }, fakeRes());
        r.finish(200, { type: 'api' });
        expect(cap.lines).toHaveLength(1);
      } finally {
        cap.restore();
      }
    });

    it('logs a failing health endpoint even when health is silenced', () => {
      const cap = capture();
      try {
        const log = createLogger({ format: 'json' });
        const r = log.start({ method: 'GET', url: '/api/health', headers: {} }, fakeRes());
        r.finish(503, { type: 'api' });
        expect(cap.lines).toHaveLength(1);
        expect(JSON.parse(cap.lines[0].raw)).toMatchObject({ lvl: 'error', status: 503 });
      } finally {
        cap.restore();
      }
    });

    it('writes exactly one line even if finish fires twice', () => {
      const cap = capture();
      try {
        const log = createLogger({ format: 'json' });
        const r = log.start({ method: 'GET', url: '/', headers: {} }, fakeRes());
        r.finish(200, {});
        r.finish(200, {});
        expect(cap.lines).toHaveLength(1);
      } finally {
        cap.restore();
      }
    });
  });
});

describe('createLogger (text)', () => {
  it('keeps a compact human-readable line', () => {
    const cap = capture();
    try {
      const log = createLogger({ format: 'text' });
      const r = log.start({ method: 'GET', url: '/api/cards', headers: {} }, fakeRes());
      r.finish(200, { type: 'api', bytes: 7 });
      expect(cap.lines[0].raw).toContain('GET /api/cards 200');
      expect(cap.lines[0].raw).toContain('bytes=7');
    } finally {
      cap.restore();
    }
  });
});

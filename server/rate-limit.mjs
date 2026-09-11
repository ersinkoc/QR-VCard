/**
 * Fixed-window rate limiter, one bucket per key (login attempts, password checks).
 * Same semantics as the QR limiter in qr-handler.mjs: bounded memory, Retry-After.
 */
export function createRateLimiter({ max, windowMs }) {
  const buckets = new Map();

  function hit(key, now = Date.now()) {
    if (buckets.size >= 10_000) {
      for (const [k, b] of buckets) if (now - b.start >= windowMs) buckets.delete(k);
    }
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      buckets.set(key, { start: now, count: 1 });
      return { limited: false };
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return { limited: true, retryAfterSec: Math.max(1, Math.ceil((bucket.start + windowMs - now) / 1000)) };
    }
    return { limited: false };
  }

  return { hit, reset: (key) => buckets.delete(key) };
}

/**
 * The client a request came from. Behind a reverse proxy (trustProxy) that is the
 * LAST X-Forwarded-For hop — the one the edge appended, which a client cannot forge.
 */
export function clientKey(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    const hops = String(Array.isArray(forwarded) ? forwarded[0] : (forwarded ?? ''))
      .split(',')
      .map((hop) => hop.trim())
      .filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Server-side Directus client: plain fetch with the service token.
 *
 * Only the app server holds DIRECTUS_TOKEN. Browsers never talk to Directus —
 * every card and user operation goes through server/api.mjs, which decides what
 * the signed-in person may see before this client is called. That is what makes
 * "a user sees only their own cards" hold on an unlicensed Directus, where
 * row-level permission rules are not available.
 */

export class DirectusError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DirectusError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Query objects are encoded bracket-style (`filter[code][_eq]=x`), which every
 * Directus version parses; arrays of scalars become comma lists (`fields=a,b`).
 */
export function encodeQuery(query) {
  const parts = [];
  const walk = (prefix, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      parts.push(`${prefix}=${encodeURIComponent(value.join(','))}`);
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(`${prefix}[${encodeURIComponent(k)}]`, v);
    } else {
      parts.push(`${prefix}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [k, v] of Object.entries(query ?? {})) walk(encodeURIComponent(k), v);
  return parts.join('&');
}

export function createDirectusClient({ url, token, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  const base = String(url).replace(/\/+$/, '');

  /**
   * `auth: null` sends no Authorization (login); `raw: true` hands back the
   * Response (assets). Anything else resolves to the `data` member.
   */
  async function request(path, { method = 'GET', query, body, auth = token, raw = false } = {}) {
    const qs = query ? encodeQuery(query) : '';
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers = {};
    if (auth) headers.Authorization = `Bearer ${auth}`;
    if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetchImpl(`${base}${path}${qs ? `?${qs}` : ''}`, {
        method,
        headers,
        body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DirectusError(502, 'UPSTREAM_UNREACHABLE', `Directus unreachable: ${err?.cause?.message ?? err?.message ?? err}`);
    }

    if (!res.ok) {
      const json = await res.json().catch(() => null);
      const first = json?.errors?.[0];
      throw new DirectusError(res.status, first?.extensions?.code ?? 'UPSTREAM_ERROR', first?.message ?? `HTTP ${res.status}`);
    }
    if (raw) return res;
    if (res.status === 204) return null;
    const json = await res.json().catch(() => null);
    return json?.data ?? null;
  }

  return { base, request };
}

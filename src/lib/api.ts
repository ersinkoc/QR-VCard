/**
 * Client for the app API (server/api.mjs). The ONLY way the browser reaches data:
 * there is no Directus URL or token in the bundle. The session is an HttpOnly
 * cookie the server sets, so no credential is ever readable by scripts.
 */

export type RoleKind = 'admin' | 'editor' | 'user';

export interface Me {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role: RoleKind;
  role_name: string | null;
}

export interface CardOwner {
  id: string;
  email: string | null;
  name: string | null;
}

export interface CardContent {
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
  job_title: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  note: string | null;
  accent_color: string | null;
  /** How the image is framed: a round, cropped photo or an uncropped logo. */
  photo_style: 'avatar' | 'logo' | null;
}

export interface Card extends CardContent {
  id: string;
  status: 'draft' | 'published';
  code: string;
  /** Photo file id (cache-buster), or null. */
  photo: string | null;
  date_created: string | null;
  /** Present for admins and editors only. */
  owner?: CardOwner | null;
}

export interface PublicCard extends CardContent {
  code: string;
  photo: string | null;
}

export interface AdminUser extends Me {
  status: string;
  last_access: string | null;
  card_count: number;
}

export interface Role {
  id: string;
  name: string;
  kind: RoleKind;
}

export type CardInput = Partial<CardContent> & { status?: Card['status']; code?: string; owner_id?: string };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

let onUnauthenticated: (() => void) | null = null;

/** The panel registers this to drop back to the sign-in screen when a session ends. */
export function setUnauthenticatedHandler(fn: (() => void) | null): void {
  onUnauthenticated = fn;
}

interface ErrorBody {
  error?: { code?: string; message?: string; fields?: Record<string, string> };
}

async function request<T>(method: string, path: string, body?: unknown, { quiet401 = false } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  let payload: BodyInit | undefined;
  // Every write carries X-QRV: a custom header cannot be sent cross-site without
  // a CORS preflight, which the server never grants — the CSRF guard.
  if (method !== 'GET') headers['X-QRV'] = '1';
  if (body instanceof Blob) {
    payload = body;
    headers['Content-Type'] = body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'network error');
  }

  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  const json = isJson ? ((await res.json().catch(() => null)) as (ErrorBody & { data?: T }) | null) : null;

  if (!res.ok) {
    const e = json?.error;
    if (res.status === 401 && !quiet401) onUnauthenticated?.();
    throw new ApiError(res.status, e?.code ?? (res.status >= 500 ? 'INTERNAL' : 'UNKNOWN'), e?.message ?? `HTTP ${res.status}`, e?.fields);
  }
  // A 200 that is not JSON is the SPA shell answering a path no API handled —
  // a broken deployment, not data.
  if (!isJson) throw new ApiError(res.status, 'BAD_RESPONSE', `expected JSON from ${path}`);
  return (json?.data ?? null) as T;
}

// --- session -------------------------------------------------------------------

export const login = (email: string, password: string) => request<Me>('POST', '/api/auth/login', { email, password }, { quiet401: true });

export async function logout(): Promise<void> {
  await request<null>('POST', '/api/auth/logout', undefined, { quiet401: true });
}

/** The signed-in person, or null when there is no valid session. */
export async function fetchMe(): Promise<Me | null> {
  try {
    return await request<Me>('GET', '/api/me', undefined, { quiet401: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export const updateMe = (patch: { email?: string; first_name?: string | null; last_name?: string | null }) => request<Me>('PATCH', '/api/me', patch);

export async function changePassword(current_password: string, new_password: string): Promise<void> {
  await request<null>('POST', '/api/me/password', { current_password, new_password });
}

// --- cards -----------------------------------------------------------------------

export const listCards = () => request<Card[]>('GET', '/api/cards');
export const createCard = (input: CardInput) => request<Card>('POST', '/api/cards', input);
export const updateCard = (id: string, patch: CardInput) => request<Card>('PATCH', `/api/cards/${id}`, patch);

export async function deleteCard(id: string): Promise<void> {
  await request<null>('DELETE', `/api/cards/${id}`);
}

export const uploadCardPhoto = (id: string, image: Blob) => request<Card>('POST', `/api/cards/${id}/photo`, image);
export const deleteCardPhoto = (id: string) => request<Card>('DELETE', `/api/cards/${id}/photo`);

export function cardPhotoUrl(card: Pick<Card, 'id' | 'photo'>): string | null {
  return card.photo ? `/api/cards/${card.id}/photo?v=${card.photo.slice(0, 8)}` : null;
}

/** A published card by its short code, or null when there is none. */
export async function fetchPublicCard(code: string): Promise<PublicCard | null> {
  try {
    return await request<PublicCard>('GET', `/api/public/cards/${encodeURIComponent(code)}`, undefined, { quiet401: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export function publicPhotoUrl(card: Pick<PublicCard, 'code' | 'photo'>, format?: 'jpg'): string | null {
  if (!card.photo) return null;
  return `/api/public/cards/${encodeURIComponent(card.code)}/photo?v=${card.photo}${format ? `&format=${format}` : ''}`;
}

// --- users (admin) ------------------------------------------------------------------

export const listUsers = () => request<AdminUser[]>('GET', '/api/users');
export const listRoles = () => request<Role[]>('GET', '/api/roles');

export const createUser = (input: { email: string; password: string; first_name: string; last_name: string; role: string }) =>
  request<AdminUser>('POST', '/api/users', input);

export const updateUser = (
  id: string,
  patch: Partial<{ email: string; first_name: string; last_name: string; role: string; status: 'active' | 'suspended'; password: string }>,
) => request<AdminUser>('PATCH', `/api/users/${id}`, patch);

export const deleteUser = (id: string, cards: 'delete' | 'transfer') =>
  request<{ cards: number; mode: string }>('DELETE', `/api/users/${id}?cards=${cards}`);

// --- helpers ---------------------------------------------------------------------------

export function shortUrl(code: string): string {
  return `${window.location.origin}/c/${code}`;
}

export function displayName(c: { first_name: string | null; last_name: string | null }): string {
  return [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
}

export const isPrivileged = (me: Pick<Me, 'role'>) => me.role === 'admin' || me.role === 'editor';

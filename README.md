# QR-VCard

Digital business cards with QR codes. **Administrators** manage everything — every
card and every account. **Users** create and manage only their own cards and share
them as QR codes that resolve to a short URL (`/c/<code>`). Opening that URL shows
the card and lets the visitor add it to their contacts (`.vcf`, photo included).

- **Frontend** — Vite + React 19 + TypeScript + Tailwind 4, installable PWA, Turkish + English UI.
- **App server** — dependency-free Node (`server/`): the single web endpoint — the app, the
  app API (`/api/*`) and QR images (`/api/qr/<code>`) on one port and one origin.
- **Backend** — Directus, configured only through the server's `.env`. The browser never
  talks to Directus.
- **QR codes** — clean, local standard QR generation (zero external API keys needed), plus optional artistic QR generation via the Art QR API.

## Quick start (local)

```bash
npm install
npm run directus:up         # local Directus on http://localhost:8055 (Docker, SQLite volume)
npm run directus:bootstrap  # provisions Directus and writes DIRECTUS_URL + DIRECTUS_TOKEN to .env
npm run directus:verify     # proves Directus refuses browsers and accepts the service token
npm run dev:all             # Vite on :5173 + the API server on :8787 (PORT), one command
```

Then open http://localhost:5173/panel. Default seed accounts (provisioned by `npm run directus:bootstrap`):

| Role | Email | Password | Capabilities | Seed Card |
|---|---|---|---|---|
| **Administrator** | `admin@local.dev` | `vcard-admin` | Full control: manages all cards AND user accounts | `/c/demo-admin` |
| **Editor** | `editor@local.dev` | `vcard-editor` | Card manager: manages all cards; no user management | *(sees all cards)* |
| **User** | `ada@local.dev` | `vcard-user` | Regular user: personal account; manages only own cards | `/c/demo-01` |

Set `QR_API_KEY` in `.env` for QR generation. Public demo cards are `/c/demo-01` (User) and `/c/demo-admin` (Admin).

## Using an existing Directus

Put two values in the root `.env` (or the deploy platform's variables) — that is the
whole backend configuration:

```bash
DIRECTUS_URL=https://directus.example.com
DIRECTUS_TOKEN=<static token of the service account>
```

To provision a fresh or existing instance (collection, roles, lockdown, service account,
token), run bootstrap once with an admin's static token; it writes the service token to
`.env` for you:

```bash
DIRECTUS_URL=https://directus.example.com DIRECTUS_ADMIN_TOKEN=<admin token> npm run directus:bootstrap
DIRECTUS_URL=https://directus.example.com npm run directus:verify
```

Bootstrap is idempotent — re-running it repairs drift instead of duplicating data.

## Roles and what each one can do

| Role (Directus role name) | Cards | Accounts | Seed Account |
|---|---|---|---|
| **Administrator** (`Administrator`) | Every card across all users; create for / transfer to anyone | List with card counts, create, edit, change role, set password, suspend, delete | `admin@local.dev` |
| **Editor** (`vcard-editor`) | Every card across all users; create, edit, delete, publish | — (no account management access) | `editor@local.dev` |
| **User** (`vcard-user`) | Only their own cards (default limit: 20) | Own profile, email and password | `ada@local.dev` |

Accounts are created by administrators only; there is no public self-registration.

### Seed data & testing role boundaries

When `npm run directus:bootstrap` runs, it provisions 3 default accounts and 2 demo cards:

1. **Administrator (`admin@local.dev` / `vcard-admin`)**
   - Can manage **both users and cards**.
   - In the panel (`/panel`), sees both the **Cards** (`/panel`) and **Users** (`/panel/users`) tabs.
   - Can create new accounts, assign roles (`Administrator`, `vcard-editor`, `vcard-user`), suspend accounts, reset passwords, or delete accounts with card transfer.
   - Owns the administrator demo card (`/c/demo-admin`).

2. **Editor (`editor@local.dev` / `vcard-editor`)**
   - Dedicated card manager: **only manages cards**.
   - Can view, edit, publish, or delete all cards in the system (e.g. for marketing or corporate directory management).
   - Has **no access** to user accounts: the Users tab is hidden, and any direct request to `/api/users` is rejected with **403 Forbidden**.

3. **User (`ada@local.dev` / `vcard-user`)**
   - Regular account holder: **only manages their own cards**.
   - Owns the demo card (`/c/demo-01`).
   - Completely isolated: cannot see, edit, or delete cards belonging to other users. Attempting to fetch or mutate a foreign card returns **404 Not Found** (the card's existence is never leaked).
   - Has no access to user accounts (`/api/users` returns **403 Forbidden**).
   - Can update their own profile (name, email address) and password via `/panel/account`.

### Guards the server enforces:

- A plain user asking for someone else's card gets **404** — the card's existence is not revealed.
- Any user (or admin) changing an email address is protected by strict uniqueness checks: attempting to take an already registered email returns **409 Conflict** (`EMAIL_TAKEN`) without server or database errors.
- Admins cannot change their own role or status, or delete their own account; the last active
  administrator cannot be removed.
- Deleting an account either deletes its cards or transfers them to the acting admin
  (their QR codes keep working).
- Setting a password (admin) or changing it (self) **signs that account out everywhere**;
  suspending an account ends its sessions at once.

## Security model

```
browser ──(HttpOnly cookie)──▶ app server (/api) ──(DIRECTUS_TOKEN)──▶ Directus
                                  │ authorises every request
                                  └ decides "own cards only" / "admins only"
```

- **Directus grants browsers nothing.** Bootstrap removes every direct `vcards` /
  `directus_files` permission from the public and vCard policies and turns off their Studio
  access. `npm run directus:verify` proves an anonymous caller, a signed-in user and an editor
  all get 403 from Directus itself.
- **Why not Directus row rules?** Row-level permission rules are license-gated in Directus 12
  (`RESOURCE_RESTRICTED: custom_permission_rules_enabled`). Earlier versions of this app fell
  back to rule-less grants, which let any signed-in user read, edit and delete every card
  directly through the Directus API. Moving authorisation into the app server closes that with
  or without a license.
- **Ownership** lives in `vcards.owner` (an m2o to `directus_users`), written only by the
  server. Directus' own `user_created` cannot carry it: Directus stamps the caller there, and
  every write now comes from the service token.
- **Sessions** are HMAC-signed, HttpOnly, SameSite=Lax cookies (7 days, renewed on use). Every
  request re-checks the account in Directus (cached 10 s): suspended accounts and changed
  passwords (`qrv_session_epoch`) end sessions.
- **CSRF**: every write needs an `X-QRV: 1` header (not sendable cross-site without a CORS
  preflight, which is never granted) and a same-origin `Origin`.
- **Brute force**: sign-in is rate limited per client and per client+account.
- **Headers**: CSP (`default-src 'self'`), HSTS, nosniff, same-origin framing, strict referrer.
- **Photo or logo**: each card's image is framed as a round photo or an uncropped square logo.
- **Photos** are only served through the API — owners see their own, visitors see photos of
  published cards. Uploads are checked by magic bytes (JPEG/PNG/WebP, 4 MB) and scaled down
  in the browser first.
- `npm run deploy:check` fails any bundle containing a Directus URL or a secret's name.

## Environment variables (server, runtime)

| Variable | Required | Meaning |
|---|---|---|
| `DIRECTUS_URL` | yes | Directus base URL, reached server-to-server |
| `DIRECTUS_TOKEN` | yes | static token of the service account (bootstrap creates it) |
| `SESSION_SECRET` | recommended | cookie signing key, ≥ 16 chars (`openssl rand -hex 32`); derived from the token when empty |
| `PUBLIC_URL` | recommended | public address, e.g. `https://kart.example.com`; QR codes encode `PUBLIC_URL/c/<code>` |
| `QR_API_KEY` | for QR | QR provider key (`QR_API_URL` overrides the provider) |
| `TRUST_PROXY` | behind a proxy | `1` = rate limits key on the last `X-Forwarded-For` hop |
| `COOKIE_SECURE` | optional | `1` forces the `Secure` flag (automatic on https / `X-Forwarded-Proto: https`) |
| `MAX_CARDS_PER_USER` | optional | cards a plain user may own, default 20 |
| `PORT` | optional | listen port (`npm run start` default 8080; `.env.example` uses 8787 for dev) |
| `QR_RATE_LIMIT_MAX` / `QR_RATE_LIMIT_WINDOW_MS` | optional | `/api/qr` limit per client, default 30 / 60 s |

Nothing is needed at build time; the bundle holds no environment-specific values.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev:all` | Vite dev server + API server together (Ctrl+C stops both) |
| `npm run dev` / `npm run api` | the two halves separately (`api` restarts on `server/` changes) |
| `npm run build` | typecheck + production build (`dist/`) |
| `npm run start` | production server: `dist/` + `/api` + `/api/qr/<code>` on one port, reads `.env` |
| `npm test` | Vitest: API authorisation rules, validation, i18n, vCard, QR |
| `npm run typecheck` | TypeScript, no emit |
| `npm run scripts:check` | syntax-check every `.mjs` in `scripts/`, `server/`, `directus/` |
| `npm run deploy:check` | fail a `dist/` that contains a Directus URL or a secret name |
| `npm run smoke:live` | end-to-end checks against a running deployment (see below) |
| `npm run directus:up` / `:down` | start / stop the local Directus container |
| `npm run directus:bootstrap` | provision Directus (idempotent) |
| `npm run directus:verify` | prove the Directus lockdown |
| `npm run qr:verify` | probe the QR provider directly |
| `npm run icons` | regenerate the PWA icons |

## Deployment (Docker / Nixpacks)

The root `Dockerfile` and `nixpacks.toml` build one image that runs `server/serve.mjs`:

```bash
docker build -t qr-vcard .
docker run -d -p 8080:8080 \
  -e DIRECTUS_URL=https://directus.example.com -e DIRECTUS_TOKEN=... \
  -e SESSION_SECRET=... -e QR_API_KEY=... -e TRUST_PROXY=1 \
  -e PUBLIC_URL=https://kart.example.com qr-vcard
```

The same image works against any Directus — nothing is baked in, and Directus needs no CORS
configuration because browsers never call it. Keep HTTPS at the edge (sessions and the PWA
need a secure origin). Health check: `/healthz` (process) and `/api/health` (Directus + token).

After deploying:

```bash
SMOKE_BASE_URL=https://your-domain USER_EMAIL=... USER_PASSWORD=... \
DIRECTUS_URL=https://directus.example.com npm run smoke:live
```

It checks both health endpoints, the SPA routes, the public card, admin sign-in and cookie
flags, a plain user's isolation (own cards only, 404 on foreign cards, 403 on accounts),
the Directus lockdown and one QR generation.

## One web endpoint — QR included (Standard & Artistic)

Everything — the app, the API and QR codes — is served by the same process on the same
origin. There is no separate QR proxy and no CORS. The browser asks for
`GET /api/qr/<code>` and names nothing but the short code:

- **Clean Standard QR (`style=standard`)**: Generated 100% locally on the server. Zero external API calls, zero dependencies on remote services, and zero keys required. Clean, high-contrast, black-and-white, and instantly scannable by any camera or QR scanner. If `QR_API_KEY` is not configured, the server automatically defaults to standard QR codes so your installation works immediately out-of-the-box.
- **Artistic QR (`style=art`)**: When `QR_API_KEY` is provided, generated via the Art QR API with custom stylings, eyes, and palette.

Both styles are cached independently in memory (keyed by style and URL) and by browsers for a day. Visitors and panel users can toggle between Standard and Artistic styles on both the public card page (`/c/<code>`) and the dashboard QR modal, and download either format directly.

Provider facts `server/qr-handler.test.mjs` locks: a partial `InputParameters` body gets a
bare `500`, and success is raw PNG bytes (not JSON) despite its Swagger. `npm run qr:verify`
probes the provider directly. Reverse-proxy recipes: [`server/README.md`](server/README.md).

## Architecture

```
src/
  lib/api.ts          the ONLY data access: fetch to /api (cookie session, X-QRV header)
  lib/vcf.ts          vCard 3.0 builder (+ embedded photo) and .vcf download
  lib/qr.ts           QR image URLs (/api/qr/<code>)
  i18n/               tr.ts (default), en.ts (typed against tr), provider + error texts
  pages/              HomePage, ScanPage (/c/:code), panel/ (Cards, Users, Account)
  components/         Modal, Avatar, Field, QrDisplay, CopyButton, ContactActions, LanguageSwitch
server/
  serve.mjs           single-port server: static app + API + QR, security headers
  api.mjs             routes, authentication, authorisation, Directus calls
  access.mjs          role rules (admin / editor / user)
  validate.mjs        input validation (error codes, translated client-side)
  session.mjs         signed cookie sessions
  directus-client.mjs server-side Directus client (service token)
  qr-handler.mjs      GET /api/qr/<code> (server-built link, cache, rate limit) + /healthz
directus/
  bootstrap.mjs       idempotent provisioning + lockdown + service token
  verify.mjs          lockdown proof
```

## Directus 12 notes

1. Login returns `access_token`, not `token`.
2. Roles cannot be created with a non-empty `policies` array; bootstrap links policies afterwards.
3. The anonymous policy is stored as `$t:public_label` on a fresh install.
4. Row-level permission rules and explicit field lists are license-gated — hence the app server.
5. Permission changes are cached; bootstrap clears the cache.
6. A `uuid` primary key needs `special: ['uuid']`.
7. `user_created` is always the caller — ownership therefore uses `vcards.owner`.
8. User emails are validated strictly (`.local` domains are refused).

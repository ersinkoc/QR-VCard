# Deploying the QR proxy

`server/qr-proxy.mjs` holds the provider's `ApiKey` so the browser never does. In development
`npm run dev` forwards `/api/qr` to it automatically (see `vite.config.ts`). In production the
**host serving the app must route `/api/qr` to this process** — the build warns when
`VITE_QR_PROXY_URL` is unset precisely because that route is then required. Without it the app
gets the SPA shell back and reports a missing route. A `403` with `QR generation failed.` in the
app means the request's `Origin` and `Host` did not match and the origin is not in
`QR_ALLOWED_ORIGINS` — see “The `Origin` header on the hop” below.

**Single port instead?** `server/serve.mjs` — `npm run start`, or the root `Dockerfile` — serves the
built app and `/api/qr` from one process, so no route below is needed at all. The rest of this file
is for running the proxy as its own service.

Requirements: Node 22+ (the proxy uses `fetch`), and one of the recipes below.

Configuration (environment only — the proxy never reads a config file):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `QR_API_KEY` | yes | — | provider key, sent as the `ApiKey` header |
| `QR_API_URL` | no | `https://artqrcode.oxog.net` | provider base URL |
| `PORT` | no | `8787` | listen port |
| `QR_ALLOWED_ORIGINS` | no | `http://localhost:5173` | comma-separated browser origins allowed to call the proxy; `*` for any |

Keep `QR_API_KEY` out of the repository: put it in the root `.env` (git-ignored, and what
`npm run qr:proxy` loads via `--env-file`), in the unit's `EnvironmentFile`/compose env, or in your
platform's secret store. Never under a `VITE_*` name — Vite inlines those into the client bundle.
(There is no `server/.env` in the run path: the proxy reads process environment only, so a key placed
there would be silently ignored.)

Check any deployment with:

```bash
curl -sS http://127.0.0.1:8787/healthz
# {"ok":true,"provider":"https://artqrcode.oxog.net","keyConfigured":true}

curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' \
  -X POST https://app.example.com/api/qr \
  -H 'Content-Type: application/json' -H 'Origin: https://app.example.com' \
  -d '{"inputText":"https://app.example.com/c/demo"}'
# Send the Origin header: a browser sends it on every POST, even a same-origin one, so this is
# the header the deployed app sends. Drop it from the command and it passes even when every
# browser fails — see "The Origin header on the hop" below.
# Must NOT be "200 text/html" — that means the SPA served the request instead of the proxy.
# Expect "200 image/png" with 100 KB+ of raw PNG bytes. A 500 with an empty body means the
# request reached the provider but its body was incomplete (the provider throws on partial
# InputParameters), 401 means the key never got attached, and a 403 naming an origin means the
# proxy refused the browser's Origin — the trap below.
```

## The `Origin` header on the hop

**A browser sends `Origin` on every POST, even a same-origin one.** The handler compares that
origin's host against the host the request arrived on (`X-Forwarded-Host` when a proxy sets it), so
a same-origin POST is allowed whatever hostname or port the app is served on, with nothing to list.
`QR_ALLOWED_ORIGINS` therefore governs only a genuine **cross-origin** caller — a browser page on
some other site — which is the case it exists for:

```
403  {"error":"origin https://evil.example is not allowed by QR_ALLOWED_ORIGINS"}
```

One failure mode is still worth knowing, because a terminal check looks healthy while every browser
fails: if a proxy rewrites `Host`, the comparison cannot see the name the browser used, the request
falls through to `QR_ALLOWED_ORIGINS`, and a staging hostname, `www` vs apex, an `http` variant or a
bare IP all miss that exact-match list. The app can only report `QR generation failed.` for it,
while `curl` without an `Origin` header keeps answering `200 image/png`. Two defences:

- **Drop the header on the hop (recommended).** Your web server → this process is a
  server-to-server call, so CORS has no meaning on it and the app's own hostname never has to be
  listed. `vite.config.ts` does exactly this for `npm run dev` and `npm run preview`; the nginx
  and Caddy recipes below do it with `proxy_set_header Origin ""` and `header_up -Origin`. It also
  keeps working when the app is reachable on several hostnames or a bare IP.
- **Or list every hostname the app is served from**, e.g.
  `QR_ALLOWED_ORIGINS=https://app.example.com,https://www.app.example.com`. Listing is required
  anyway when the browser calls the proxy cross-origin (`VITE_QR_PROXY_URL` pointing at the
  proxy's own URL): that request really is a cross-origin browser call, and `QR_ALLOWED_ORIGINS`
  is the only thing standing between the provider key and every other site on the internet.

## nginx (same origin)

Exact-match location, so it wins over the SPA fallback and the shell can never answer the API:

```nginx
server {
    listen 443 ssl;
    server_name app.example.com;
    root /srv/qr-vcard;

    # The proxy route. `= /api/qr` is an exact match: it takes precedence over the
    # SPA fallback below, which is what keeps index.html out of API responses.
    location = /api/qr {
        proxy_pass http://127.0.0.1:8787/api/qr;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # Browsers send Origin on every POST, even same-origin, and forwarding it makes the
        # proxy 403 any origin missing from QR_ALLOWED_ORIGINS. Empty value = header not
        # passed, which is what this server-to-server hop wants. See "The Origin header on
        # the hop" above.
        proxy_set_header Origin "";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 20s;
        client_max_body_size 64k;   # matches the proxy's own body cap
    }

    # SPA fallback for everything else (client-side routes like /c/<code>).
    location / {
        try_files $uri /index.html;
    }
}
```

## Caddy (same origin)

Caddy needs no explicit ordering tricks — `handle /api/qr` is matched before the catch-all:

```
app.example.com {
    handle /api/qr {
        reverse_proxy 127.0.0.1:8787 {
            # Browsers send Origin on every POST, even same-origin; forwarding it makes the
            # proxy 403 any origin missing from QR_ALLOWED_ORIGINS. `-Field` deletes the
            # header, which is what this server-to-server hop wants (nginx's equivalent is
            # proxy_set_header Origin "").
            header_up -Origin
        }
    }

    handle {
        root * /srv/qr-vcard
        try_files {path} /index.html
        file_server
    }
}
```

## Docker

`server/Dockerfile` builds a small `node:24-alpine` image containing only the proxy (it has no
dependencies). Build from the repository root:

```bash
docker build -f server/Dockerfile -t qr-proxy .
docker run -d --name qr-proxy --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -e QR_API_KEY=... \
  -e QR_ALLOWED_ORIGINS=https://app.example.com \
  qr-proxy
```

`server/docker-compose.yml` wraps that — the health check comes from the image's `HEALTHCHECK`, which
compose reports as `Up (healthy)` — and adds a fail-fast key check:

```bash
# QR_API_KEY (and optionally QR_API_URL / QR_ALLOWED_ORIGINS) from the root .env
docker compose --env-file ../.env -f server/docker-compose.yml up -d --build
```

Bind to `127.0.0.1` and put the reverse proxy in front — the proxy is not designed to be exposed
directly, and `QR_ALLOWED_ORIGINS` is the only thing standing in front of the provider key.

## Traefik (Docker, automatic domains)

The deployable form of this recipe is **`server/docker-compose.traefik.yml`** — it builds the same
image as `server/docker-compose.yml`, publishes **no host port** (Traefik reaches the container
over the shared Docker network), and carries the router plus the `qr-strip-origin` middleware, so
nothing has to be copied by hand:

```bash
# QR_HOST is the hostname the app is served on. Put it in .env once, or pass it per deploy.
QR_HOST=app.example.com docker compose --env-file .env -f server/docker-compose.traefik.yml up -d --build
```

Compose-level variables that file reads (they configure Traefik, not the proxy):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `QR_HOST` | yes | — | hostname the app is served on; the router matches `Host(QR_HOST) && Path(/api/qr)` |
| `TRAEFIK_NETWORK` | no | `traefik` | existing Docker network this container shares with Traefik |
| `TRAEFIK_ENTRYPOINT` | no | `websecure` | entrypoint the router binds to |
| `TRAEFIK_CERTRESOLVER` | no | `le` | resolver that issues the certificate for `QR_HOST` |

`QR_HOST` has no default on purpose: a deploy without it stops with a readable message instead of
publishing a router for the wrong hostname. The middleware is attached as
`traefik.http.middlewares.qr-strip-origin.headers.customrequestheaders.Origin=` — an empty value
**removes** the header in Traefik's `customRequestHeaders`, which is what stops the proxy's
allowlist from 403-ing the browser's own origin.

Notes:

- `certresolver=le` stands for whatever resolver your Traefik defines (`le`, `default`, …) — the
  one that issues certificates for the automatically configured domains. Keep the app container's
  own router as it is; only `/api/qr` moves to this one.
- Do not route `/healthz` externally. It reports whether a key is configured (never the key), but
  it has no business being public.
- With `Origin` stripped, `QR_ALLOWED_ORIGINS` is no longer consulted for browser traffic — the
  compose default is then harmless. Set it to your public origin anyway as defence in depth, so
  removing the middleware later cannot silently open the proxy to other sites.
- Verify from outside, with the header a browser would send (see the `curl` block above):

```bash
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' \
  -X POST https://app.example.com/api/qr \
  -H 'Content-Type: application/json' -H 'Origin: https://app.example.com' \
  -d '{"inputText":"https://app.example.com/c/demo"}'
# Expect "200 image/png". A 403 naming an origin means the middleware is not attached to the
# router that actually matched.
```

## systemd (no container)

`server/qr-proxy.service` runs the script directly. Copy the repository to `/opt/qr-vcard`, put the
secrets in `/etc/qr-vcard/qr-proxy.env`, then:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin qrproxy
sudo install -d -m 750 -o root -g qrproxy /etc/qr-vcard
sudo install -m 640 -o root -g qrproxy /dev/null /etc/qr-vcard/qr-proxy.env
sudo tee /etc/qr-vcard/qr-proxy.env >/dev/null <<'EOF'
QR_API_KEY=...
QR_API_URL=https://artqrcode.oxog.net
PORT=8787
QR_ALLOWED_ORIGINS=https://app.example.com
EOF

sudo install -m 644 server/qr-proxy.service /etc/systemd/system/qr-proxy.service
sudo systemctl daemon-reload
sudo systemctl enable --now qr-proxy
systemctl status qr-proxy --no-pager
curl -sS http://127.0.0.1:8787/healthz
```

## Deployment checklist

1. `QR_API_KEY` set in the proxy's environment — and **nowhere** in a `VITE_*` variable.
2. The app's origin listed in `QR_ALLOWED_ORIGINS` (or `*` if the route is only reachable
   server-side).
3. `/api/qr` routed to the proxy on the same origin, or `VITE_QR_PROXY_URL` set at build time to
   the proxy's absolute URL.
4. Same-origin calls are allowed automatically, so this only applies to a proxy that **rewrites
   `Host`** (or to a cross-origin caller): either strip `Origin` on the hop — nginx
   `proxy_set_header Origin ""`, Caddy `header_up -Origin`, Traefik
   `…customrequestheaders.Origin=` — or list every hostname the app is served from in
   `QR_ALLOWED_ORIGINS`. Otherwise the proxy answers `403` and the app shows
   `QR generation failed.`, while `curl` without that header still looks healthy. It bites hardest
   with automatic/wildcard domains, where the hostname set is not fixed.
5. `curl` the two checks above: `/healthz` reports `keyConfigured: true`, and a POST to
   `/api/qr` **with an `Origin` header** does **not** answer `200 text/html`.

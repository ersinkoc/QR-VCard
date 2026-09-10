# Deploying the QR proxy

`server/qr-proxy.mjs` holds the provider's `ApiKey` so the browser never does. In development
`npm run dev` forwards `/api/qr` to it automatically (see `vite.config.ts`). In production the
**host serving the app must route `/api/qr` to this process** — the build warns when
`VITE_QR_PROXY_URL` is unset precisely because that route is then required. Without it the app
gets the SPA shell back and reports a missing route.

Requirements: Node 22+ (the proxy uses `fetch`), and one of the recipes below.

Configuration (environment only — the proxy never reads a config file):

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `QR_API_KEY` | yes | — | provider key, sent as the `ApiKey` header |
| `QR_API_URL` | no | `https://artqrcode.oxog.net` | provider base URL |
| `PORT` | no | `8787` | listen port |
| `QR_ALLOWED_ORIGINS` | no | `http://localhost:5173` | comma-separated browser origins allowed to call the proxy; `*` for any |

Keep `QR_API_KEY` out of the repository: put it in the root `.env` (git-ignored, and what
`npm run qr:proxy` loads via `--env-file`) or a `server/.env` (also ignored), an `EnvironmentFile`
with mode `600`, or your platform's secret store. Never under a `VITE_*` name — Vite inlines those
into the client bundle.

Check any deployment with:

```bash
curl -sS http://127.0.0.1:8787/healthz
# {"ok":true,"provider":"https://artqrcode.oxog.net","keyConfigured":true}

curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' \
  -X POST https://app.example.com/api/qr \
  -H 'Content-Type: application/json' -d '{"inputText":"https://app.example.com/c/demo"}'
# Must NOT be "200 text/html" — that means the SPA served the request instead of the proxy.
# Expect "200 image/png" with 100 KB+ of raw PNG bytes. A 500 with an empty body means the
# request reached the provider but its body was incomplete (the provider throws on partial
# InputParameters), and 401 means the key never got attached.
```

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
        reverse_proxy 127.0.0.1:8787
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

`server/docker-compose.yml` wraps that, including a health check and a fail-fast key check:

```bash
# QR_API_KEY (and optionally QR_API_URL / QR_ALLOWED_ORIGINS) from the root .env
docker compose --env-file ../.env -f server/docker-compose.yml up -d --build
```

Bind to `127.0.0.1` and put the reverse proxy in front — the proxy is not designed to be exposed
directly, and `QR_ALLOWED_ORIGINS` is the only thing standing in front of the provider key.

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
4. `curl` the two checks above: `/healthz` reports `keyConfigured: true`, and a POST to
   `/api/qr` does **not** answer `200 text/html`.

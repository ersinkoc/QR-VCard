# The app server

`server/serve.mjs` is the **only** web endpoint. One process, one port, one origin:

| Path | What answers it |
|---|---|
| `/`, `/c/<code>`, `/panel/*`, `/assets/*` | the built app (`dist/`), SPA fallback, security headers |
| `/api/*` | the app API (`api.mjs`) — sessions, cards, users, photos |
| `/api/qr/<code>` | the QR endpoint (`qr-handler.mjs`) — PNG of `PUBLIC_URL/c/<code>`, cached |
| `/healthz` | liveness + whether the QR key is set |
| `/api/health` | Directus reachable + service token valid |

The browser never talks to Directus or to the QR provider; their credentials
(`DIRECTUS_TOKEN`, `QR_API_KEY`) exist only in this process's environment. There is no
separate QR proxy and no CORS: everything is same-origin.

## Behind a reverse proxy

Send **everything** to the one upstream — no per-path routes:

```nginx
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

```caddy
kart.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then set `TRUST_PROXY=1` (rate limits key on the real client) and `PUBLIC_URL=https://kart.example.com`
(the address QR codes encode). Keep HTTPS at the edge; the session cookie becomes `Secure`
automatically from `X-Forwarded-Proto`.

## Checks

```bash
curl -sS https://kart.example.com/healthz
curl -sS https://kart.example.com/api/health
curl -sS -o /dev/null -w '%{http_code} %{content_type}\n' https://kart.example.com/api/qr/demo-01
SMOKE_BASE_URL=https://kart.example.com npm run smoke
```

Configuration is described in the root [README](../README.md#environment-variables-server-runtime).

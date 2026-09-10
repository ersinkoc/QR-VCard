# QR proxy runtime image. Build from the repository root:
#   docker build -f server/Dockerfile -t qr-proxy .
# The proxy is dependency-free, so only the script is copied — no npm install.
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8787

WORKDIR /app

COPY server/qr-proxy.mjs ./server/qr-proxy.mjs

# The node image ships an unprivileged `node` user; nothing here needs root.
USER node

EXPOSE 8787

# No curl in alpine — probe with node's fetch instead.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/qr-proxy.mjs"]

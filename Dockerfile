# Single-port app image: one process serves the built SPA and /api/qr.
#
#   docker build -t qr-vcard --build-arg VITE_DIRECTUS_URL=https://directus.example.com .
#   docker run -d --name qr-vcard -p 8080:8080 -e QR_API_KEY=... qr-vcard
#
# VITE_DIRECTUS_URL is inlined into the bundle at build time (Vite replaces
# import.meta.env at build), so it is a --build-arg and not a runtime variable:
# changing which Directus the app talks to means rebuilding the image. Directus
# itself must allow this app's origin (CORS) — the browser calls it directly.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_DIRECTUS_URL=http://localhost:8055
ENV VITE_DIRECTUS_URL=$VITE_DIRECTUS_URL
RUN npm run build

# Runtime stage: no dependencies to install. server/serve.mjs and its handler are
# plain node:http, so only the built assets and those two files are copied.
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server/serve.mjs server/qr-handler.mjs ./server/
USER node
EXPOSE 8080
# No curl in alpine — probe with node's fetch instead.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/serve.mjs"]

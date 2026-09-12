# Single-port app image: one process serves the built SPA, the app API and /api/qr.
#
#   docker build -t qr-vcard .
#   docker run -d --name qr-vcard -p 8080:8080 \
#     -e DIRECTUS_URL=https://directus.example.com -e DIRECTUS_TOKEN=... \
#     -e SESSION_SECRET=... -e QR_API_KEY=... -e TRUST_PROXY=1 qr-vcard
#
# Nothing about Directus is baked into the image: the browser only talks to this
# server, and the server reads DIRECTUS_URL / DIRECTUS_TOKEN at runtime. The same
# image works against any Directus.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Bake the commit this image was built from; /healthz reports it as `sha`,
# which the post-deploy smoke workflow compares against the pushed commit so a
# run never validates a STALE deployment.
ARG COMMIT_SHA=""
RUN echo "$COMMIT_SHA" > .commit-sha && npm run build

# Runtime stage: no dependencies to install — the server is plain node:http.
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/.commit-sha ./.commit-sha
COPY server/serve.mjs server/api.mjs server/access.mjs server/directus-client.mjs \
     server/session.mjs server/rate-limit.mjs server/validate.mjs server/qr-handler.mjs ./server/
USER node
EXPOSE 8080
# No curl in alpine — probe with node's fetch instead.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/serve.mjs"]

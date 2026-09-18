# Single-port app image: one process serves the built SPA, the app API and /api/qr.
#
#   docker build -t qr-vcard .
#   docker run -d --name qr-vcard -p 8080:8080 --env-file .env qr-vcard
#
# Nothing about Directus is baked into the image: the browser only talks to this
# server, and the server reads DIRECTUS_URL / DIRECTUS_TOKEN at runtime. The same
# image works against any Directus. On start it validates the environment, waits
# for Directus, provisions/repairs the schema and then serves (see
# scripts/start-production.mjs and docs/deploy.md).
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
# Bake the commit this image was built from; /healthz reports it as `sha`,
# which the post-deploy smoke workflow compares against the pushed commit so a
# run never validates a STALE deployment. Coolify passes SOURCE_COMMIT.
ARG COMMIT_SHA=""
ARG SOURCE_COMMIT=""
RUN echo "${COMMIT_SHA:-$SOURCE_COMMIT}" > .commit-sha \
 && npm run build \
 && npm run deploy:check

# Runtime stage: only the packages imported by the Node server.
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/.commit-sha ./.commit-sha
# The whole server/ directory (a new module can never be forgotten here); tests
# are dropped, they need dev dependencies that are not installed.
COPY server ./server
COPY directus/bootstrap.mjs ./directus/bootstrap.mjs
COPY scripts/start-production.mjs scripts/preflight.mjs ./scripts/
RUN rm -f server/*.test.mjs server/README.md
USER node
EXPOSE 8080
# Liveness only (the process answers). start-period covers the wait for Directus
# and the schema provisioning that run before the server listens.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/start-production.mjs"]

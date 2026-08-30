# syntax=docker/dockerfile:1

# ── Builder ──────────────────────────────────────────────────────────────────
# Full toolchain: better-sqlite3 compiles its native addon against this exact
# Node runtime. All workspace manifests are present before dependency install.
FROM node:24-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/web/package.json ./packages/web/package.json
COPY packages/email/package.json ./packages/email/package.json
COPY packages/antibot/package.json ./packages/antibot/package.json
COPY packages/geo/package.json ./packages/geo/package.json
COPY packages/map/package.json ./packages/map/package.json
RUN npm install --include-workspace-root --workspaces

COPY tsconfig.json drizzle.config.ts vitest.config.ts eslint.config.js ./
COPY packages ./packages
COPY scripts ./scripts
RUN npm run build

# Keep the native better-sqlite3 binary built above and the production tsx entry.
RUN npm prune --omit=dev --include-workspace-root --workspaces

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime

ENV NODE_ENV=production \
    PORCHFEST_HOST=0.0.0.0 \
    PORCHFEST_PORT=9398 \
    PORCHFEST_DATA_DIR=/data

WORKDIR /app

RUN mkdir -p /data && chown -R node:node /data

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/scripts/organizer-link.ts ./scripts/organizer-link.ts

VOLUME ["/data"]
EXPOSE 9398
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORCHFEST_PORT||9398)+'/health').then(r=>{if(!r.ok)process.exit(1);return r.json()}).then(j=>process.exit(j&&j.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node_modules/.bin/tsx", "packages/web/src/server.ts"]

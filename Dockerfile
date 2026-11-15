# syntax=docker/dockerfile:1.7

# ---------- build stage: compile TypeScript ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: no third-party install scripts run during the build (supply-chain hardening).
# better-sqlite3 ships prebuilt N-API binaries, so nothing needs compiling.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------- runtime stage: production deps + compiled JS only ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=3000 \
    DB_PATH=/app/data/portfolio.db \
    AUDIT_DB_PATH=/app/data/audit.db
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh \
 && mkdir -p /app/data && chown -R node:node /app/data

# Run as the unprivileged built-in user.
USER node
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.HTTP_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]

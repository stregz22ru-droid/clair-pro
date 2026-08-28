# ── CLAIR Visual Dashboard — multi-stage production image ────────────────────
# Build context is the clair-pro root:
#   docker build -f dashboard/Dockerfile -t clair-dashboard .

FROM node:20-alpine AS builder
WORKDIR /app
COPY dashboard/package.json ./
RUN npm install --no-audit --no-fund
COPY dashboard/tsconfig.json ./
COPY dashboard/src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
ENV DASHBOARD_PORT=4000
ENV DASHBOARD_PUBLIC_DIR=/app/public
WORKDIR /app
RUN mkdir -p /app/public && chown -R node:node /app
USER node
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node dashboard/src/public ./public
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${DASHBOARD_PORT}/health" >/dev/null 2>&1 || exit 1
CMD ["node", "dist/server.js"]

# ---- Build: compile TypeScript (server + client bundles + service worker) ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.client.json tsconfig.sw.json ./
COPY src ./src
COPY views ./views
COPY public ./public
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

# ---- Runtime: only what the server needs ----
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/views ./views
COPY --from=build /app/public ./public

# Accounts, push subscriptions and VAPID keys live here (mounted as a volume).
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3000/ || exit 1

CMD ["node", "dist/server/server.js"]

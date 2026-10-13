# syntax=docker/dockerfile:1
# craft-ai-hub: launcher, reverse proxy and AI assistant overlay for the craft web apps (server.mjs).
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs chat.mjs ./
COPY public/ ./public/
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

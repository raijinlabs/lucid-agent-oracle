FROM node:20-slim AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/publisher/package.json apps/publisher/
COPY apps/ponder/package.json apps/ponder/
COPY apps/webhook-worker/package.json apps/webhook-worker/
RUN npm install
COPY . .

# API target (default)
FROM base AS api
EXPOSE 4040
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4040)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "apps/api/src/server.ts"]

# Worker target
FROM base AS worker
CMD ["npx", "tsx", "apps/worker/src/index.ts"]

# Publisher target
FROM base AS publisher
CMD ["npx", "tsx", "apps/publisher/src/index.ts"]

# Webhook worker target
FROM base AS webhook-worker
CMD ["npx", "tsx", "apps/webhook-worker/src/index.ts"]

# Ponder target (Base indexer)
FROM base AS ponder
CMD ["npx", "ponder", "start"]

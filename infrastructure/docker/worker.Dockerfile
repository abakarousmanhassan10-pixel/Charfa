# syntax=docker/dockerfile:1.7
ARG BASE_IMAGE=node:22-bookworm-slim
# Build from the repository root:  docker build -f infrastructure/docker/worker.Dockerfile -t touma-worker .
# Optional proxy/CA settings: see api.Dockerfile.
FROM ${BASE_IMAGE} AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && npm install -g pnpm@10.28.0 \
 && pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter=@touma/worker... \
 && pnpm deploy --filter=@touma/worker --prod --legacy /out \
 && cp -r packages/database/prisma /out/prisma \
 && for d in /out/node_modules/.pnpm/@prisma+client@*/node_modules; do cp -r /repo/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma "$d/"; done \
 && cd /out && node -e "const { PrismaClient } = require('@touma/database'); new PrismaClient(); console.log('prisma client ok')"

FROM ${BASE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production WORKER_HEALTH_PORT=4001
WORKDIR /app
COPY --from=build --chown=node:node /out .
COPY --from=build --chown=node:node /repo/apps/worker/dist ./dist
USER node
EXPOSE 4001
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:'+process.env.WORKER_HEALTH_PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

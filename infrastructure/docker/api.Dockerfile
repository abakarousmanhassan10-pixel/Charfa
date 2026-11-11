# syntax=docker/dockerfile:1.7
ARG BASE_IMAGE=node:22-bookworm-slim
# Build from the repository root:  docker build -f infrastructure/docker/api.Dockerfile -t touma-api .
# Optional for builds behind a TLS-intercepting proxy (never stored in the image):
#   --secret id=build_ca,src=/path/to/ca.pem  --build-arg HTTPS_PROXY=...  --network host
FROM ${BASE_IMAGE} AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && npm install -g pnpm@10.28.0 \
 && pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter=@touma/api... \
 && pnpm deploy --filter=@touma/api --prod --legacy /out \
 && cp -r packages/database/prisma /out/prisma \
 && for d in /out/node_modules/.pnpm/@prisma+client@*/node_modules; do cp -r /repo/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma "$d/"; done \
 && cd /out && node -e "const { PrismaClient } = require('@touma/database'); new PrismaClient(); console.log('prisma client ok')"

# One-shot migration runner (prisma migrate deploy) used before rolling out a new API version.
FROM base AS migrate
COPY --from=build /repo /repo
WORKDIR /repo/packages/database
CMD ["npx", "prisma", "migrate", "deploy"]

FROM ${BASE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out .
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
USER node
EXPOSE 4000
# Liveness only; readiness (/api/v1/health/ready) checks the database, Redis and dependencies.
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://localhost:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]

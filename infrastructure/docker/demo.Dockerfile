# syntax=docker/dockerfile:1.7
ARG BASE_IMAGE=node:22-bookworm-slim
# DEMO ONLY (free hosting preview). Not for staging or production: use api.Dockerfile + migrate.Dockerfile for those.
# One image that applies the database migrations, seeds the plans (idempotent) and starts the API.
# It keeps the whole workspace (Prisma CLI and tsx included), so it is larger than the runtime image.
# The environment (APP_ENV=test with simulated AI, platforms and storage) is supplied by the host; nothing secret is baked in.
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates fontconfig fonts-dejavu-core fonts-liberation && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@10.28.0
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter=@touma/api...
CMD ["sh", "-c", "cd /repo/packages/database && pnpm exec prisma migrate deploy && pnpm exec tsx prisma/seed.ts && cd /repo/apps/api && node dist/main.js"]

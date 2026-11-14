# syntax=docker/dockerfile:1.7
ARG BASE_IMAGE=node:22-bookworm-slim
# One image that applies the database migrations, seeds the plans (idempotent) and starts the API with its in-process workers.
# For a SINGLE instance (migrations run at every start). With several instances, run migrate.Dockerfile once per release instead.
# All configuration comes from the host's environment; nothing secret is baked into the image.
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates fontconfig fonts-dejavu-core fonts-liberation && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@10.28.0
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter=@touma/api...
CMD ["sh", "-c", "cd /repo/packages/database && pnpm exec prisma migrate deploy && pnpm exec tsx prisma/seed.ts && cd /repo/apps/api && node dist/main.js"]

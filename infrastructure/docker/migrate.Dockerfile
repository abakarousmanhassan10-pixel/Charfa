# syntax=docker/dockerfile:1.7
ARG BASE_IMAGE=node:22-bookworm-slim
# One-shot database tooling image: applies Prisma migrations (and, on request, seeds the subscription plans).
# It is NOT a long-running service. Unlike the `runtime` stage of api.Dockerfile it contains the Prisma CLI and tsx
# (dev dependencies that `pnpm deploy --prod` leaves out), so it is the only image that can run `prisma migrate deploy`.
#
# Build from the repository root:
#   docker build -f infrastructure/docker/migrate.Dockerfile -t touma-migrate .
#
# Apply pending migrations (default command). Use a DIRECT PostgreSQL connection (not a transaction-mode pooler):
#   docker run --rm -e DATABASE_URL="$DATABASE_URL" touma-migrate
#
# Seed the subscription plans (idempotent, run once after the first migration):
#   docker run --rm -e DATABASE_URL="$DATABASE_URL" touma-migrate pnpm exec tsx prisma/seed.ts
#
# DATABASE_URL is supplied at run time only; nothing secret is baked into the image.
# Optional for builds behind a TLS-intercepting proxy: see api.Dockerfile (--secret id=build_ca, --build-arg HTTPS_PROXY).
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@10.28.0 \
 && mkdir -p /pnpm /repo && chown node:node /pnpm /repo
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
WORKDIR /repo
# The whole workspace is copied so the frozen lockfile matches every manifest; only @touma/database and its dependencies are installed.
COPY --chown=node:node . .
USER node
RUN --mount=type=secret,id=build_ca,required=false,mode=0444 \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && pnpm install --frozen-lockfile --filter @touma/database...
WORKDIR /repo/packages/database
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

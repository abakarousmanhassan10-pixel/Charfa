# syntax=docker/dockerfile:1.7
ARG BASE_IMAGE=node:22-bookworm-slim
# Production frontend is deployed on Vercel; this image is for local full-stack runs and self-hosting.
# Build from the repository root:  docker build -f infrastructure/docker/web.Dockerfile -t touma-web .
# Optional proxy/CA settings: see api.Dockerfile.
FROM ${BASE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
ARG API_URL=http://api:4000
ENV API_URL=${API_URL}
COPY . .
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi \
 && npm install -g pnpm@10.28.0 \
 && pnpm install --frozen-lockfile \
 && pnpm turbo run build --filter=@touma/web...

# next.config.ts is loaded at start-up (needs TypeScript), so the built workspace is kept as is.
FROM ${BASE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/apps/web
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://localhost:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]

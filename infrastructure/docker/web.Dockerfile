# syntax=docker/dockerfile:1.7
# Production frontend is deployed on Vercel; this image is for local full-stack runs and self-hosting.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
ARG API_URL=http://api:4000
ENV API_URL=${API_URL} NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@touma/web...

FROM node:22-bookworm-slim AS runtime
RUN corepack enable
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY --from=build --chown=node:node /repo /repo
USER node
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]

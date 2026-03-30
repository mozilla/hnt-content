# syntax=docker/dockerfile:1
# Builds a single image containing all hnt-content services.
# Each Helm workload overrides the command to select which service to run.
#
# Adapted from content-monorepo and
# https://turbo.build/repo/docs/guides/tools/docker

# ---- base ----
FROM node:24.14-alpine AS base

WORKDIR /app
RUN apk add --no-cache curl libc6-compat
COPY package.json .
RUN corepack enable && corepack install
ENV PNPM_HOME=/usr/local/bin
ENV PNPM_STORE_DIR=/pnpm/store
RUN pnpm add -g turbo@2.8.20

# ---- prune ----
FROM base AS setup

COPY . .
RUN turbo prune crawl-agent crawl-worker --docker

# ---- build ----
FROM base AS builder

# Install dependencies (json-only layer for Docker caching)
COPY .gitignore .gitignore
COPY --from=setup /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=setup /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=setup /app/out/json/ ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Build all services
COPY --from=setup /app/out/full/ ./
COPY turbo.json turbo.json
COPY tsconfig.json tsconfig.json
RUN pnpm run build

# Deploy each service to a self-contained directory with prod deps only
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter=crawl-agent --prod deploy /prod/crawl-agent && \
    pnpm --filter=crawl-worker --prod deploy /prod/crawl-worker

# ---- runner ----
FROM node:24.14-alpine AS runner

RUN apk add --no-cache curl libc6-compat

WORKDIR /app
COPY --from=builder --chown=node:node /prod/ ./
USER node

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "echo 'ERROR: specify a service command, e.g. node crawl-agent/dist/main.js' && exit 1"]

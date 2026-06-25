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

# Deploy each service to a self-contained directory with prod deps only.
# Our workspace deps are symlinks, so pnpm 10's default deploy fails (it
# expects deps to be pre-copied, or "injected"). --legacy handles symlinks
# by copying each dep's built dist/ into the deploy directory.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter=crawl-agent --prod deploy --legacy /prod/crawl-agent && \
    pnpm --filter=crawl-worker --prod deploy --legacy /prod/crawl-worker

# ---- runner ----
FROM node:24.14-alpine AS runner

RUN apk add --no-cache curl libc6-compat

RUN addgroup -g 10001 -S app && adduser -u 10001 -S -G app -h /app app

WORKDIR /app
COPY --from=builder --chown=app:app /prod/ ./
USER app

# Set by CI from the merging commit SHA; surfaced to Sentry as the
# release tag so issues can be grouped by deployed revision.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "echo 'ERROR: specify a service command, e.g. node crawl-agent/dist/main.js' && exit 1"]

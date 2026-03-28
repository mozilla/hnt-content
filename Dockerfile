# syntax=docker/dockerfile:1
# Adapted from content-monorepo and
# https://turbo.build/repo/docs/guides/tools/docker

# ---- base ----
FROM node:24.14-alpine AS base

ARG SCOPE
ARG PORT=8080

RUN apk add --no-cache curl libc6-compat
COPY package.json .
RUN corepack enable && corepack install
ENV PNPM_HOME=/usr/local/bin
RUN pnpm add -g turbo@2.8.20

# ---- prune ----
FROM base AS setup
ARG SCOPE

WORKDIR /app
COPY . .
RUN turbo prune $SCOPE --docker

# ---- build ----
FROM base AS builder
ARG SCOPE

WORKDIR /app

# Install dependencies (json-only layer for Docker caching)
COPY .gitignore .gitignore
COPY --from=setup /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=setup /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=setup /app/out/json/ ./
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Build
COPY --from=setup /app/out/full/ ./
COPY turbo.json turbo.json
COPY tsconfig.json tsconfig.json
RUN pnpm run build --filter=${SCOPE}...

# Deploy: produce self-contained directory with prod deps only
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm --filter=${SCOPE} --prod deploy /prod

# ---- runner ----
FROM node:24.14-alpine AS runner
ARG PORT=8080

RUN apk add --no-cache curl && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs

WORKDIR /app
COPY --from=builder --chown=nodejs:nodejs /prod/ ./
USER nodejs

ENV NODE_ENV=production
ENV PORT=${PORT}
EXPOSE ${PORT}

CMD ["node", "dist/main.js"]

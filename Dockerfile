# Adapted from content-monorepo and
# https://turbo.build/repo/docs/guides/tools/docker

# ---- base ----
FROM node:24-alpine AS base

ARG SCOPE
ARG PORT=8080

RUN apk add --no-cache curl libc6-compat
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
ENV PNPM_HOME=/usr/local/bin
RUN pnpm add -g turbo@2.5.0

# ---- prune ----
FROM base AS setup
ARG SCOPE

WORKDIR /app
COPY . .
RUN turbo prune --scope=$SCOPE --docker

# ---- build ----
FROM base AS builder
ARG SCOPE

WORKDIR /app

COPY .gitignore .gitignore
COPY --from=setup /app/out/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=setup /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY --from=setup /app/out/json/ ./
RUN pnpm install --filter=${SCOPE}... --frozen-lockfile

COPY --from=setup /app/out/full/ ./
COPY turbo.json turbo.json
COPY tsconfig.json tsconfig.json
RUN pnpm run build --filter=${SCOPE}...

# Prune to production dependencies
RUN pnpm --filter=$SCOPE --prod deploy --legacy pruned

# ---- runner ----
FROM node:24-alpine AS runner
ARG PORT=8080

RUN apk add --no-cache curl
WORKDIR /app
COPY --from=builder /app/pruned/ ./

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nodejs && \
    chown -R nodejs:nodejs /app
USER nodejs

ENV NODE_ENV=production
ENV PORT=${PORT}
EXPOSE ${PORT}

CMD ["node", "dist/main.js"]

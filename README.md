# hnt-content

Article crawling and extraction pipeline for [Firefox New Tab](https://support.mozilla.org/en-US/kb/customize-your-new-tab-page) content recommendations. Crawls publisher pages, discovers articles, extracts content via Zyte, and streams results to BigQuery for ML ranking.

## Quick Start

```sh
nvm use            # Node 24
pnpm install
pnpm build
pnpm test
```

## Repository Structure

```
hnt-content/
├── services/
│   ├── crawl-agent/      # Scheduler: enqueues crawl jobs on configured intervals
│   └── crawl-worker/     # Worker: discovers articles and extracts content
├── packages/
│   ├── crawl-common/     # Shared types, utilities, Zyte client
│   └── eslint-config-custom/
├── Dockerfile            # Multi-stage build with turbo prune + pnpm deploy
├── turbo.json
└── pnpm-workspace.yaml
```

## Common Commands

| Command | Description |
|---------|-------------|
| `pnpm build` | Build all packages and services |
| `pnpm test` | Run all tests |
| `pnpm lint` | Lint all packages |
| `pnpm format` | Format source files with Prettier |
| `pnpm format:check` | Check formatting (CI) |
| `pnpm clean` | Remove all build artifacts and node_modules |

## Docker

Build a service image using the `SCOPE` build arg:

```sh
docker build --build-arg SCOPE=crawl-worker -t crawl-worker .
docker build --build-arg SCOPE=crawl-agent -t crawl-agent .
```

The Dockerfile uses [Turborepo Docker pruning](https://turbo.build/repo/docs/guides/tools/docker) and `pnpm deploy --prod` to produce a minimal image with only production dependencies.

## Technology

- **Runtime:** Node.js 24, ESM
- **Language:** TypeScript (strict, nodenext)
- **Package Manager:** pnpm 10 with workspace injection
- **Build Orchestration:** Turborepo
- **Shared Packages:** tsup (ESM)
- **Testing:** Vitest
- **Linting:** ESLint 10 (flat config) + Prettier
- **Deployment:** GKE via ArgoCD (mozcloud Helm chart)

## Architecture

See the [Article Crawler Technical Spec](https://mozilla-hub.atlassian.net/wiki/spaces/FPS/pages/1737064449) for the full design. In brief:

- **Crawl Agent** runs a tick loop every 60s, checking which publisher pages and live articles need crawling based on Redis state, then enqueues jobs to Pub/Sub.
- **Crawl Worker** consumes from two Pub/Sub queues: `crawl-article-discovery` (page crawling) and `crawl-article` (article extraction). Results stream to BigQuery via Pub/Sub subscriptions.
- **Redis** (Memorystore) tracks crawl timestamps, prevents duplicate fetches, and provides distributed locking.

## License

[MPL-2.0](LICENSE)

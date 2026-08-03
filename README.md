# hnt-content

Article crawling and extraction pipeline for [Firefox New Tab](https://support.mozilla.org/en-US/kb/customize-your-new-tab-page) content recommendations. Crawls publisher pages, discovers articles, extracts content via Zyte, and streams results to BigQuery for ML ranking.

## Development

### Prerequisites

- **[nvm](https://github.com/nvm-sh/nvm#installing-and-updating)** — `nvm use` installs the Node version in [`.nvmrc`](.nvmrc).
- **[pnpm](https://pnpm.io/installation)** — `corepack enable` activates the version pinned in `package.json`.

### Setup

From the repo root:

```sh
nvm use        # Node 24
pnpm install   # install workspace dependencies
pnpm build     # build packages and services
```

The article worker needs a [Zyte API key](https://app.zyte.com/o/612928/zyte-api/api-access). Copy `services/crawl-worker/.env.example` to `services/crawl-worker/.env` and set `ZYTE_API_KEY`. The dev scripts load `.env` automatically, and it is gitignored, so keep real keys there and never commit them. In deployed environments these values come from the Helm chart and Google Secret Manager, not from a file.

### Agent

The agent is a long-running service that every 60s checks Redis state and enqueues crawl jobs to Pub/Sub for the publisher pages and live articles due for a refresh. Run it with:

```sh
pnpm --filter crawl-agent dev
```

### Article worker

Consumes the `crawl-article` queue, extracts each article via Zyte, and publishes the result to the `articles` topic for BigQuery.

```sh
pnpm --filter crawl-worker dev:article
```

### Discovery worker

Consumes the `crawl-article-discovery` queue and extracts article links from publisher pages via Zyte, enqueuing a crawl job per discovered article.

```sh
pnpm --filter crawl-worker dev:discovery
```

### Common commands

| Command | Description |
|---------|-------------|
| `pnpm build` | Build all packages and services |
| `pnpm test` | Run all tests |
| `pnpm lint` | Lint all packages |
| `pnpm format` | Format source files with Prettier |
| `pnpm format:check` | Check formatting (CI) |
| `pnpm clean` | Remove all build artifacts and node_modules |

## Architecture

See the [Article Crawler Technical Spec](https://mozilla-hub.atlassian.net/wiki/spaces/FPS/pages/1737064449) for the full design. In brief:

- **Crawl Agent** is a long-running service that every 60s checks which publisher pages and live articles need crawling based on Redis state, then enqueues jobs to Pub/Sub.
- **Crawl Worker** consumes from two Pub/Sub queues: `crawl-article-discovery` (page crawling) and `crawl-article` (article extraction). Results stream to BigQuery via Pub/Sub subscriptions.
- **Redis** (Memorystore) tracks crawl timestamps, prevents duplicate fetches, and provides distributed locking.

### Crawl Worker

The worker consumes the `crawl-article` subscription. Each job carries an
article URL, and optionally a `corpus_item` for live articles managed by
editors. The handler extracts the article via Zyte and, for live articles,
syncs a changed title or excerpt back to the Curated Corpus API. It then
publishes an event to the `articles` topic, which a BigQuery subscription
writes to `crawl.articles`.

A job is acked only after its event reaches the topic. Any failure throws,
which nacks the message so Pub/Sub redelivers it. Delivery is at-least-once,
so duplicate events are expected and resolved by "latest per URL" queries.
On `SIGTERM` the worker drains in-flight messages before exit. Errors are
reported to Sentry with the job's URL and crawl ID attached.

### Repository structure

```
hnt-content/
├── services/
│   ├── crawl-agent/      # Scheduler: enqueues crawl jobs on configured intervals
│   └── crawl-worker/     # Worker: discovers articles and extracts content
├── packages/
│   ├── crawl-common/     # Crawl-domain types, validation, Corpus API, utils
│   ├── pubsub/           # Generic Pub/Sub consumer/publisher client
│   ├── redis-state/      # Generic Redis state client (timestamps, locks, tokens)
│   ├── zyte/             # Generic Zyte extraction API client
│   ├── metrics/          # StatsD metrics client
│   └── sentry/           # Sentry error reporting client
├── Dockerfile            # Multi-stage build with turbo prune + pnpm deploy
├── turbo.json
└── pnpm-workspace.yaml
```

## Deployment

The Dockerfile builds a single image containing all services. Each Helm workload overrides the command to select which service to run:

```sh
docker build -t hnt-content .
docker run -e PORT=8080 hnt-content node crawl-agent/dist/main.js
docker run -e PORT=8080 hnt-content node crawl-worker/dist/main.js
```

The Dockerfile uses [Turborepo Docker pruning](https://turbo.build/repo/docs/guides/tools/docker) and `pnpm deploy --prod` to produce a minimal image with only production dependencies. Services deploy to GKE via ArgoCD (mozcloud Helm chart).

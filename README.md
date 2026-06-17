# hnt-content

Article crawling and extraction pipeline for [Firefox New Tab](https://support.mozilla.org/en-US/kb/customize-your-new-tab-page) content recommendations. Crawls publisher pages, discovers articles, extracts content via Zyte, and streams results to BigQuery for ML ranking.

## Development

```sh
nvm use  # Node 24
pnpm install
pnpm build
pnpm test
```

Run a service locally (no build step, uses tsx):

```sh
pnpm --filter crawl-agent dev
pnpm --filter crawl-worker dev
```

Each service reads its config from environment variables. For local
runs, copy the service's `.env.example` to `.env` and fill in the
blanks; `pnpm dev` loads `.env` automatically. `.env` is gitignored,
so keep real keys there and never commit them. In deployed
environments these variables come from the Helm chart and Google
Secret Manager, not from a file.

```sh
cp services/crawl-worker/.env.example services/crawl-worker/.env
# edit .env: add your personal ZYTE_API_KEY
pnpm --filter crawl-worker dev
```

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

- **Crawl Agent** runs a tick loop every 60s, checking which publisher pages and live articles need crawling based on Redis state, then enqueues jobs to Pub/Sub.
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

Not yet wired: page discovery (the `crawl-article-discovery` subscription,
Task 6.2) and Redis fetch deduplication (Milestone 8).

### Repository structure

```
hnt-content/
├── services/
│   ├── crawl-agent/      # Scheduler: enqueues crawl jobs on configured intervals
│   └── crawl-worker/     # Worker: discovers articles and extracts content
├── packages/
│   └── crawl-common/     # Shared types, utilities, Zyte client
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


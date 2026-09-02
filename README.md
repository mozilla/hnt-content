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

The services deploy when a pull request merges to `main`. GitHub Actions builds the image and pushes it to Artifact Registry, then ArgoCD Image Updater notices the new digest and rolls it out. For now, dev, stage and prod all track the same tag, so a single merge reaches all three.

One image contains both entry points. The shared mozcloud Helm chart chooses which one each workload runs and sets `WORKER_ROLE` to select the discovery or article role, so all three workloads come from one build.

For how the system fits together, see [docs/crawl/ARCHITECTURE.md](docs/crawl/ARCHITECTURE.md).


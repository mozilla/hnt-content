# hnt-content

Article crawling and extraction pipeline for [Firefox New Tab](https://support.mozilla.org/en-US/kb/customize-your-new-tab-page) content recommendations. Crawls publisher pages, discovers articles, extracts content via Zyte, and streams results to BigQuery for ML ranking.

## System Summary

The system is comprised of two services:

1. **Crawl Scheduler** - every minute, sends PubSub messages to the Crawl Worker containing either a live Curated Corpus API article URL or a publisher article list page URL (think a landing page listing many articles).

2. **Crawl Worker** - polls PubSub for messages sent by the Crawl Scheduler and processes them, eventually getting metadata for each URL (live Corpus Item or publisher article) from Zyte, which is in turn sent in a PubSub message to be consumed by (and inserted into) BigQuery.

(For a more in-depth overview, see the [architecture doc](docs/crawl/ARCHITECTURE.md).)

### Crawl Scheduler

When this service starts, two infinite loops ("pages" and "live articles") are spun up, each "ticking" every minute. Notably, as the service load is low and predictable, this service only has a single replica (no worrying about concurrency).

#### Pages Loop

On each "tick", chooses a subset of publisher landing pages (hardcoded in a JSON file) to be processed by the Crawl Worker. For each publisher landing page chosen, sends a PubSub message to the `${env}-crawl-article-discovery` topic (which is consumed by the Crawl Worker). Purpose is to find newly published articles.

#### Live Articles Loop

Retrieves all articles present in live sections (currently `NEW_TAB_EN_US` only) from the Corpus. Sends each article to the `${environment}-crawl-article` PubSub topic to be processed by the Crawl Worker. Purpose is to update `title` and `excerpt` on existing Corpus items.

### Crawl Worker

This is a scaling service that subscribes to PubSub messages received from the Crawl Scheduler. Additionally, this service runs under two "modes" (defined via an env var set in K8s): "discovery" and "article".

#### Discovery Mode

In "discovery" mode, the Crawl Worker consumes messages sent by the Crawl Scheduler "Pages" loop. Calls Zyte to scrape the publisher landing page for individual articles, and sends each article found to the `${environment}-crawl-article` PubSub topic to be processed by "article" mode.

Additionally, for each publisher landing page crawled, sends a PubSub message to the `${environment}-article-discoveries` topic, which is consumed by BigQuery.

#### Article Mode

"Article" mode consumes messages from the `${environment}-crawl-article` PubSub topic. For each message, calls Zyte to get metadata (title, authors, image url, etc).

If the PubSub message defines a `corpus_id`, updates the item's `title` and or `excerpt` in the Corpus (only if changed).

For each article, sends a message to the `${environment}-articles` PubSub topic, which is consumed by BigQuery.

## Development

```sh
nvm use  # Node 24
pnpm install
pnpm build
pnpm test
```

Run a service locally (no build step, uses tsx):

```sh
pnpm --filter crawl-scheduler dev
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

- **Crawl Scheduler** runs a tick loop every minute, enqueueing the publisher pages due that minute, staggered across the crawl interval by a hash of each URL, and a batch of live articles to Pub/Sub.
- **Crawl Worker** consumes from two Pub/Sub queues: `crawl-article-discovery` (page crawling) and `crawl-article` (article extraction). Results stream to BigQuery via Pub/Sub subscriptions.
- **Redis** (Memorystore) tracks crawl timestamps, prevents duplicate fetches, and provides distributed locking.

### Repository structure

```
hnt-content/
├── services/
│   ├── crawl-scheduler/  # Enqueues crawl jobs on configured intervals
│   └── crawl-worker/     # Discovers articles and extracts content
├── packages/
│   ├── crawl-common/     # Shared types, utilities, Corpus API client
│   ├── metrics/          # OpenTelemetry metrics client
│   ├── pubsub/           # Pub/Sub publisher and subscriber
│   ├── redis-state/      # Redis crawl state and locks
│   ├── sentry/           # Sentry init and handler wrapper
│   └── zyte/             # Zyte API client
├── Dockerfile            # Multi-stage build with turbo prune + pnpm deploy
├── turbo.json
└── pnpm-workspace.yaml
```

## Deployment

The services deploy when a pull request merges to `main`. GitHub Actions builds the image and pushes it to Artifact Registry, then ArgoCD Image Updater notices the new digest and rolls it out. Merging to `main` publishes the `latest` tag, which stage and prod track. Pushing to the `dev` branch (e.g. `git push -f origin HEAD:dev`) publishes the `dev` tag, which only hnt-dev tracks, so dev can run a branch ahead of `main`.

Per MozCloud convention the pods run on a shared platform cluster in `moz-fx-webservices-high-prod`, while this project's own infrastructure, including Pub/Sub, Redis and BigQuery, lives in `moz-fx-hnt-prod`, so the chart passes `PROJECT_ID` for the Google client libraries to use; dev and stage mirror that split in the nonprod projects.

One image contains both services. The shared mozcloud Helm chart chooses which one each workload runs and sets `WORKER_ROLE` to select the discovery or article role, so all three workloads come from one build.

For how the system fits together, see [docs/crawl/ARCHITECTURE.md](docs/crawl/ARCHITECTURE.md).

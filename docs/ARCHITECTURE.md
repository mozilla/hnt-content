# Crawl Architecture

This document explains the crawler's main components and how content
flows from a publisher's website into BigQuery, staying at the level of data
flow rather than implementation detail.

## What the system does

The crawler keeps Firefox New Tab supplied with fresh article content. It visits
publisher pages, discovers the articles linked from them, extracts the text and
metadata of each article, and streams the results into BigQuery where machine
learning models rank them for readers. The design target is that a newly
published article reaches BigQuery within roughly 75 minutes, at a scale of
millions of articles per month.

The system is event driven. A small scheduler decides what to crawl, and a pool
of stateless workers does the crawling. The two sides never call each other
directly. They communicate through Pub/Sub. This lets the workers scale up and
down with demand and lets the system absorb bursts without losing work.

## System context

The crawler is a single system that sits between Mozilla's editorial curation
and the analytics that feed Firefox New Tab. This view shows who it talks to and
why. The next section looks inside.

```mermaid
flowchart TB
    editors["Editors<br/>via an editorial spreadsheet"]:::actor
    zyte["Zyte API<br/>fetches publisher websites"]:::external
    corpus["Curated Corpus API"]:::external

    crawler["Crawler<br/>discovers and extracts articles"]:::system

    bq[("BigQuery<br/>crawl dataset")]:::store
    newtab["Firefox New Tab<br/>via ML ranking"]:::actor

    editors -->|publisher pages to crawl, as committed JSON| crawler
    zyte -->|extracted content| crawler
    tpad[" "]:::pad ~~~ crawler
    crawler <-->|curated articles| corpus
    crawler -->|article and discovery data| bq
    bq -->|ranking and training data| newtab
    bq ~~~ pad[" "]:::pad

    classDef system fill:#1a5276,stroke:#0b2e42,color:#eaf2f8,stroke-width:3px
    classDef external fill:#616a6b,stroke:#2c3232,color:#f2f4f4,stroke-width:1px
    classDef store fill:#0e6655,stroke:#073b31,color:#e8f8f5,stroke-width:1px
    classDef actor fill:#935116,stroke:#5b3410,color:#fdf2e9,stroke-width:1px
    classDef pad fill:none,stroke:none,color:#ffffff
```

Every arrow points in the direction that data flows. Editors maintain the list
of publisher pages to crawl in an editorial spreadsheet, which is exported to a
committed JSON file that the agent reads on startup. The crawler drives the Zyte
API to fetch and extract those pages and the articles found on them, since it
never visits sites itself, so the extracted content flows back from Zyte. The
crawler streams its results into the BigQuery crawl dataset for the ranking
pipeline. Its
relationship with the Curated Corpus API runs both ways. Curated articles are
the editorially approved items that New Tab serves, so the crawler reads the
current set from that API to re-extract them and writes any changed headline or
excerpt back to keep the copy readers see accurate.

## Components

The whole system lives in one TypeScript monorepo. Two deployable services carry
the runtime behavior, and a set of shared packages provides the building blocks
they share.

```mermaid
flowchart TB
    agent["Crawl Agent<br/>single replica"]:::service
    qDisc(["crawl-article-discovery"]):::messaging
    disc["Discovery Worker"]:::service
    qArt(["crawl-article"]):::messaging
    art["Article Worker"]:::service
    tDisc(["article-discoveries"]):::messaging
    bqDisc[("crawl.article_discoveries")]:::store
    tArt(["articles"]):::messaging
    bqArt[("crawl.articles")]:::store

    subgraph deps["Shared dependencies"]
        direction TB
        redis[("Redis")]:::store
        zyte["Zyte API"]:::external
        corpus["Curated Corpus API"]:::external
    end

    agent -->|page jobs| qDisc
    agent -->|curated article jobs| qArt
    qDisc --> disc
    disc -->|discovery events| tDisc --> bqDisc
    disc -->|new article jobs| qArt
    qArt --> art
    art -->|event when content changed| tArt --> bqArt

    disc -.-> redis
    disc -.-> zyte
    art -.-> redis
    art -.-> zyte
    art -.->|writes corrections| corpus

    classDef service fill:#2c3e50,stroke:#1a252f,color:#ecf0f1,stroke-width:1px
    classDef messaging fill:#7d3c98,stroke:#4a235a,color:#f4ecf7,stroke-width:1px
    classDef store fill:#0e6655,stroke:#073b31,color:#e8f8f5,stroke-width:1px
    classDef external fill:#616a6b,stroke:#2c3232,color:#f2f4f4,stroke-width:1px
    style deps fill:#f4f6f7,stroke:#d5dbdb,color:#1b2631
```

The same components drawn as a Mermaid `architecture-beta` diagram. Its icons
stand in for the component type: a server for a service, a cloud for a Pub/Sub
queue or topic, a globe for an external API, and a database for a data store.
Its edges carry no message labels:

```mermaid
%%{init: {"architecture": {"iconSize": 60}}}%%
architecture-beta
    service agent(server)[Crawl Agent single replica]
    service qdisc(cloud)["crawl-article-discovery"]
    service disc(server)[Discovery Worker]
    service tdisc(cloud)["article-discoveries"]
    service bqdisc(database)["crawl.article_discoveries"]
    service qart(cloud)["crawl-article"]
    service art(server)[Article Worker]
    service tart(cloud)[articles]
    service bqart(database)["crawl.articles"]
    group deps(database)[Dependencies shared by both workers]
    service zyte(internet)[Zyte API] in deps
    service redis(database)[Redis] in deps
    service corpus(internet)[Curated Corpus API]
    agent:R --> L:qdisc
    qdisc:R --> L:disc
    disc:R --> L:tdisc
    tdisc:R --> L:bqdisc
    disc:B --> T:qart
    qart:B --> T:art
    art:R --> L:tart
    tart:R --> L:bqart
    agent:B --> T:qart
    art:B --> T:zyte
    art:B --> T:redis
    art:B --> T:corpus
    disc:B --> T:zyte
    disc:B --> T:redis
```

The flowcharts share one visual language. Rectangles are services, stadium
shapes are Pub/Sub queues and topics, cylinders are data stores, gray boxes are
third party systems, and dotted lines mark a service reaching a shared
dependency rather than passing a message along the pipeline. The sequence
diagrams show the same types through participant symbols instead: a queue symbol
for Pub/Sub queues and topics, a database symbol for a store, and a boundary
symbol for an external API.

### Services

The **Crawl Agent** is the scheduler. It runs as a single replica and wakes on a
fixed interval of about a minute. On each tick it decides which publisher pages
and curated articles are due for a crawl and publishes the corresponding jobs.
It holds no queue itself and does no extraction. It takes its pages from the
committed list and its curated articles from the Corpus API.

The **Crawl Worker** is the workhorse, and it runs in two roles selected by the
`WORKER_ROLE` environment variable. As a **Discovery Worker** it reads a page,
finds the articles linked from it, and enqueues each article for extraction. As
an **Article Worker** it reads a single article and extracts its content. Both
roles are built from the same image and deploy as separate, independently
scalable groups of pods. Both are stateless, so Kubernetes can add or remove
replicas freely and Pub/Sub redelivers anything a crashed pod left unfinished.

### Queues and topics

Four Pub/Sub resources connect the pieces. The two **job queues**,
`crawl-article-discovery` and `crawl-article`, carry work to the two worker
roles. The two **event topics**, `article-discoveries` and `articles`, carry
results outward. Each event topic has a BigQuery subscription that writes every
message straight into the matching table, so there is no separate loading step.
Each job queue also has a dead letter topic that captures any message a worker
fails to process after repeated attempts.

### Shared packages

The shared packages keep the services thin and the responsibilities clear.

| Package | Responsibility |
|---|---|
| `crawl-common` | Domain types, message validation, Redis key names, the Corpus API client, and text helpers |
| `zyte` | Client for the Zyte extraction API, including retries on transient errors |
| `pubsub` | Consumer and publisher helpers with batching and graceful drain |
| `redis-state` | Timestamps and distributed locks over Redis |
| `metrics` | StatsD metrics client |
| `sentry` | Error reporting with per-message context |

The generic packages know nothing about the crawler. `crawl-common` layers the
crawl specific domain on top, and the two services combine them to do their work.

## How an article flows through the system

The pieces work together to move one article as follows. The happy path starts
with a publisher page and ends with a row in BigQuery, and the sequence below
traces a discovered article through both workers.

```mermaid
%%{init: {'theme':'base','sequence':{'diagramMarginX':270},'themeVariables':{'actorBkg':'#eef2f7','actorBorder':'#90a4ae','actorTextColor':'#1b2631','actorLineColor':'#5d6d7e','signalColor':'#5d6d7e','signalTextColor':'#1b2631','labelBoxBkgColor':'#eaf2f8','labelBoxBorderColor':'#aed6f1','labelTextColor':'#1b2631','loopTextColor':'#1b2631','noteBkgColor':'#fdf2e9','noteBorderColor':'#935116','noteTextColor':'#5b3410','sequenceNumberColor':'#ffffff'}}}%%
sequenceDiagram
    autonumber
    participant Agent as Crawl Agent
    participant DiscQ@{ "type": "queue" } as crawl-article-discovery
    participant Disc as Discovery Worker
    participant Zyte@{ "type": "boundary" } as Zyte API
    participant DiscT@{ "type": "queue" } as article-discoveries topic
    participant ArtQ@{ "type": "queue" } as crawl-article
    participant Art as Article Worker
    participant ArtT@{ "type": "queue" } as articles topic

    Agent-)DiscQ: publish page job with url and contexts
    DiscQ-)Disc: deliver page job
    Disc->>Zyte: extract the list of linked articles
    Zyte-->>Disc: article links
    Note over Disc: keep same domain links, drop duplicates
    Disc-)DiscT: publish one discovery event per article and context
    Disc-)ArtQ: publish one extraction job per new article
    ArtQ-)Art: deliver article job
    Art->>Zyte: extract the article content
    Zyte-->>Art: headline, body, authors, and more
    Art-)ArtT: publish an article event when the content changed
```

The diagram compresses one subtlety. The discovery worker emits a separate
discovery event for each surface and topic the page was crawled for, so a single
article is recorded once per audience it serves. It keeps only links on the
publisher's own domain and removes duplicates before that fan-out, then enqueues
each new article for its own extraction. The article worker extracts the content
and publishes an article event, and both kinds of event reach BigQuery through
their subscriptions.

Curated articles take a shorter path. The agent enqueues them straight onto the
`crawl-article` queue with their editorial record attached. When the article
worker extracts one, it compares the fresh headline and excerpt against that
record and writes any change back to the Curated Corpus API before publishing
the article event. This keeps the editorial copy and the crawled copy in step.

## Deduplication and idempotency

Pub/Sub delivers each message at least once, so the same job can arrive more than
once and two workers can pick up the same URL at the same time. The workers make
this harmless with a small amount of Redis state, as the sequence below shows.

```mermaid
%%{init: {'theme':'base','sequence':{'diagramMarginX':270},'themeVariables':{'actorBkg':'#eef2f7','actorBorder':'#90a4ae','actorTextColor':'#1b2631','actorLineColor':'#5d6d7e','signalColor':'#5d6d7e','signalTextColor':'#1b2631','labelBoxBkgColor':'#eaf2f8','labelBoxBorderColor':'#aed6f1','labelTextColor':'#1b2631','loopTextColor':'#1b2631','noteBkgColor':'#fdf2e9','noteBorderColor':'#935116','noteTextColor':'#5b3410','sequenceNumberColor':'#ffffff'}}}%%
sequenceDiagram
    autonumber
    participant Q@{ "type": "queue" } as crawl-article
    participant W as Article Worker
    participant R@{ "type": "database" } as Redis
    participant Z@{ "type": "boundary" } as Zyte API
    participant T@{ "type": "queue" } as articles topic

    Q-)W: deliver article job
    W->>R: fetched recently?
    alt within the freshness window
        W--)Q: acknowledge and skip
    else due for a fetch
        W->>R: acquire the article lock
        alt lock already held
            W--)Q: acknowledge and skip
        else lock acquired
            W->>R: record the fetch time before calling Zyte
            W->>Z: extract the article
            Z-->>W: article content
            W->>R: compare the content hash
            opt content changed
                W-)T: publish the article event
                W->>R: store the new content hash
            end
            W->>R: release the lock
            W--)Q: acknowledge
        end
    end
```

Three mechanisms make this work. The **freshness check** skips any URL that was
crawled within its interval, so the crawler does not re-fetch the same content
on every delivery. The **lock** serializes concurrent workers on the same URL,
so only one calls Zyte and the rest skip. Recording the fetch time **before** the
Zyte call means that if a crash interrupts the fetch, the redelivered job is
skipped within the freshness window instead of calling Zyte a second time.
Finally, the **content hash** means an article event is published only when the
content actually changed. This keeps unchanged articles from filling BigQuery
with duplicates.

The discovery worker uses this pattern against its own page keys, and it
checks each discovered article's freshness before enqueuing it, so an article
already in flight is not queued again. The agent applies the same idea one step
earlier. It records when it last enqueued each page and curated article, so a
slow crawl is not scheduled a second time.

Because delivery is at least once, some duplicate rows still reach BigQuery. Each
table carries a timestamp, `extracted_at` for articles and `crawled_at` for
discoveries. Downstream queries take the latest row per URL and resolve the
duplicates at read time.

### Redis state

| Key | Written by | Purpose |
|---|---|---|
| `page:fetch` | Discovery Worker | Last time a page was crawled |
| `page:lock` | Discovery Worker | Guard against concurrent page crawls |
| `article:fetch` | Article Worker | Last time an article was extracted |
| `article:lock` | Article Worker | Guard against concurrent extractions |
| `article:content` | Article Worker | Content hash for change detection |

Every key is scoped to a single URL. Fetch timestamps and content hashes expire
after a long retention window. Each lock expires a safe margin before the Pub/Sub
acknowledgement deadline, so a crashed worker cannot hold it forever.

## Message and event contracts

Four message shapes travel across the queues and topics. The producers and
consumers validate them at the boundary and reject anything malformed.

| Message | Direction | Required fields |
|---|---|---|
| `crawl-article-discovery` job | Agent to Discovery Worker | `url`, `interval_minutes`, `contexts` |
| `crawl-article` job | Agent or Discovery Worker to Article Worker | `url`, `source_url`, `crawl_id`, `enqueued_at` |
| `article-discoveries` event | Discovery Worker to BigQuery | `url`, `source_url`, `crawled_at`, `surface_id` |
| `articles` event | Article Worker to BigQuery | `url`, `extracted_at` |

A `crawl-article` job carries a `crawl_id` that identifies the crawl run, and
for a curated article it also carries an editorial record. Discovery events fan out
to one message per article and context, so every discovery job must name the
surface and topic through a context. Events keep only a small required core and
treat every extracted field as optional, since any given page may not supply all
of them.

## Infrastructure and deployment

The Dockerfile builds a single image that contains both services. Each
Kubernetes workload overrides the container command and, for the workers, sets
`WORKER_ROLE` to choose its role. The diagram below shows how a change reaches a
running environment and what the workloads depend on once they are there.

```mermaid
flowchart TB
    dev["Developer"]:::actor
    ci["GitHub Actions<br/>build and push"]:::platform
    gar[("Artifact Registry<br/>container image")]:::store
    argo["ArgoCD Image Updater<br/>deploys the new digest"]:::platform

    subgraph gke["GKE workloads, one namespace per environment"]
        agent["crawl-agent<br/>single replica"]:::service
        artw["crawl-article-worker<br/>autoscaled"]:::service
        discw["crawl-discovery-worker<br/>autoscaled"]:::service
    end

    gcp["Managed cloud services<br/>Pub/Sub, Memorystore Redis,<br/>BigQuery, Secret Manager"]:::store

    dev --> ci --> gar -->|new digest| argo
    argo -->|deploy| agent & artw & discw
    agent & artw & discw --> gcp

    classDef service fill:#2c3e50,stroke:#1a252f,color:#ecf0f1,stroke-width:1px
    classDef store fill:#0e6655,stroke:#073b31,color:#e8f8f5,stroke-width:1px
    classDef platform fill:#5d6d7e,stroke:#34495e,color:#f2f4f4,stroke-width:1px
    classDef actor fill:#935116,stroke:#5b3410,color:#fdf2e9,stroke-width:1px
    style gke fill:#eafaf1,stroke:#a9dfbf,color:#1b2631
```

Deployment runs through GitOps rather than a direct push. Continuous integration
in the application repository builds the image and pushes it to Artifact
Registry. ArgoCD Image Updater notices the new build by its digest and records
it, and ArgoCD then syncs the Helm chart so Kubernetes rolls the workloads
forward. The crawl agent runs as a single replica, while the two worker roles
scale on demand.

The cloud resources are defined as Terraform in a separate infrastructure
repository, and the tenant and delivery pipeline are defined in a platform
repository. The same image and chart run in three environments that map to two
GCP projects.

| Environment | GCP project | BigQuery dataset |
|---|---|---|
| dev | moz-fx-hnt-nonprod | crawl_dev |
| stage | moz-fx-hnt-nonprod | crawl_stage |
| prod | moz-fx-hnt-prod | crawl |

Each service reads its configuration from environment variables, and Pub/Sub and
BigQuery names are prefixed by the environment, so the same image runs unchanged
everywhere. Secrets live in Secret Manager and reach the pods as environment
variables through the deployment chart.

## Failure modes

The system is designed so that a failure degrades content freshness rather than
taking anything down.

| Situation | Behavior |
|---|---|
| Pause the crawler | Scale the agent to zero replicas, and the workers drain the queues and idle |
| Agent crashes | Kubernetes restarts it, and Redis state survives so no crawl is lost |
| Worker crashes | Pub/Sub redelivers the in-flight job after the deadline and another worker takes it |
| Zyte outage | Queues back up and drain automatically once Zyte recovers |
| Redis outage | Workers fail fast and Pub/Sub redelivers, and the highly available tier limits exposure |

Firefox New Tab keeps serving throughout any of these, since it reads from
BigQuery rather than from the crawler directly.

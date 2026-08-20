# Deduplication and Idempotency

This document explains how the crawl workers avoid redundant work and stay safe
under duplicate delivery. For the components and data flow, see
[ARCHITECTURE.md](ARCHITECTURE.md).

The same article often appears on several publisher pages, and Pub/Sub delivers
each message at least once, so a URL can be enqueued more than once and two
workers can pick it up at the same time. The workers guard against this with a
few Redis keys, each scoped to a single URL.

## Guarding an article extraction

```mermaid
%%{init: {'flowchart': {'rankSpacing': 16, 'nodeSpacing': 40, 'wrappingWidth': 300}}}%%
flowchart TD
    START([crawl-article job delivered]):::worker --> FRESH{"Extracted<br/>recently?"}:::worker
    FRESH -- Yes --> DONE
    FRESH -- No --> LOCK["Acquire <code>article:lock</code>"]:::redis
    LOCK --> HELD{"Already<br/>locked?"}:::worker
    HELD -- Yes --> DONE
    HELD -- No --> CLAIM["Claim <code>article:extracted</code><br/>for an hour"]:::redis
    CLAIM --> ZYTE[Extract the article via Zyte API]:::zyte
    ZYTE -- "recoverable failure" --> RETRY([Retried once the claim expires]):::done
    ZYTE -- "permanent failure" --> MARK["Confirm <code>article:extracted</code><br/>for the refresh window"]:::redis
    ZYTE -- content --> HASH["Compare with <code>article:content</code>"]:::redis
    HASH --> CHANGED{"Content<br/>changed?"}:::worker
    CHANGED -- Yes --> PUB[Publish event to articles topic]:::pub
    PUB --> STORE["Store <code>article:content</code>"]:::redis
    CHANGED -- No --> STORE
    STORE --> MARK
    MARK --> DONE([Done]):::done

    classDef worker fill:#2c3e50,stroke:#1a252f,color:#ecf0f1;
    classDef redis fill:#0e6655,stroke:#073b31,color:#e8f8f5;
    classDef zyte fill:#616a6b,stroke:#2c3232,color:#f2f4f4;
    classDef pub fill:#7d3c98,stroke:#4a235a,color:#f4ecf7;
    classDef done fill:#eaeded,stroke:#95a5a6,color:#2c3e50;
```

Three mechanisms make the workers idempotent:

1. The **freshness check** skips any URL extracted within its refresh window,
   so the crawler does not re-fetch the same content on every delivery.
2. The **lock** serializes concurrent workers on the same URL, so only one calls
   Zyte and the rest skip.
3. The **content hash**, taken over every content column of `crawl.articles`,
   limits publishing to changed content, so unchanged articles do not fill
   BigQuery with duplicates.

The marker is written twice. The worker claims the URL for an hour before the
Zyte call, then rewrites it for the full refresh window once the work is done,
meaning a successful extraction or a permanent failure. The claim stops one
failure from multiplying: Pub/Sub would otherwise redeliver the message up to
five times, and the same URL is often linked from several pages. A recoverable
failure leaves only the claim, so the URL is tried again on the first page crawl
after the hour is up.

## Refresh windows

Each window is configurable, and the defaults are what a deployment uses unless
the Helm chart overrides them.

| What | Window | Where it comes from |
|---|---|---|
| Publisher page | 20 min | `page_refresh_minutes`, carried per page on the job |
| Discovered article | 30 days | `DISCOVERED_ARTICLE_REFRESH_DAYS` |
| Live article | 15 min | `LIVE_ARTICLE_REFRESH_MINUTES`, set on the job by the scheduler |
| Attempt claim | 60 min | `ARTICLE_ATTEMPT_TTL_MINUTES`, written before the Zyte call |
| Lock | 270 s | `ACK_DEADLINE_SECONDS` minus 30 s |

A live article carries its window on the message, so it dedups on the
scheduler's cadence rather than the worker's longer default. Locks expire
shortly before the Pub/Sub acknowledgement deadline, so a crashed worker cannot
hold one forever.

## The scheduler and the discovery worker

The scheduler keeps its own pair of markers, recording when it last enqueued
each page or live article rather than when one was last fetched. It ticks every
minute over the whole list and skips anything whose marker is younger than its
interval, so each item goes out once per interval instead of once per tick.
Because the scheduler is a single replica, a plain check-then-set is enough
here, so no lock is needed.

The discovery worker guards its page crawls with a freshness check and a lock of
its own, and checks each discovered article against `article:extracted` so it
does not queue a URL that was extracted recently.

## Redis state

| Key | Written by | Purpose |
|---|---|---|
| `page:enqueued` | Crawl Scheduler | Last time a page was enqueued for discovery |
| `article:enqueued` | Crawl Scheduler | Last time a live article was enqueued |
| `page:fetch` | Discovery Worker | Last time a page crawl started |
| `page:lock` | Discovery Worker | Guard against concurrent page crawls |
| `article:extracted` | Article Worker | Last time an article extraction finished |
| `article:lock` | Article Worker | Guard against concurrent extractions |
| `article:content` | Article Worker | Content hash for change detection |

Markers and content hashes are retained for the longest refresh window, 30 days,
so the key space stays bounded by how many distinct URLs the crawler has seen
recently rather than growing forever. Lengthening a window means lengthening
retention with it.

## Duplicates that still reach BigQuery

None of this makes delivery exactly once, so some duplicate rows do land. Each
table carries a timestamp, `extracted_at` for articles and `crawled_at` for
discoveries. Downstream queries take the latest row per URL and resolve the
duplicates at read time.

## Validating what arrives

The Pub/Sub SDK hands the workers untyped JSON, so both job messages are checked
at the consumer boundary before a handler trusts the static type. The checks are
small hand-written guards in
[`crawl-common/src/validation`](https://github.com/mozilla/hnt-content/tree/main/packages/crawl-common/src/validation)
that name the offending field, and a malformed payload is nacked as a validation
error so a poison message is told apart from a transient failure.

The two event shapes need no such check, because the workers construct them
rather than receive them. Their TypeScript types constrain what the code can
build, and the BigQuery subscription rejects anything that does not match the
table schema. Zyte responses are parsed but not schema-checked, so a field the
extractor omits arrives as undefined and is treated as an optional field.

# Decisions log

Running log of non-obvious implementation decisions for the Article Crawler
(HNT-2086). One entry per decision, newest last, with its rationale. See the
tech spec (referenced in CLAUDE.local.md) for the design these decisions
implement.

## HNT-2086: integration branch baseline

The integration branch `claude/hnt-2086-crawling-pipeline-v2` already carries
the merged Milestone 1-4 work plus Sentry (HNT-2589) and the article worker
wired to Pub/Sub (HNT-2113). Remaining buildable work is Milestones 5-8 minus
the deploy, shadow-mode, and cutover tasks, which are human-gated. The build
order respects milestone numbering and dependencies: 5.9, then 6.1 and 6.2,
then 7.1 through 7.3, then 8.1, 8.2, and 8.4, with StatsD metrics (5.8) last
because it instruments code the earlier tasks build.

## HNT-2487: validate Pub/Sub messages at the consumer boundary

Validation is an injected `validate` hook on the generic subscriber rather
than logic baked into each handler. The hook keeps the Pub/Sub client
schema-agnostic (the validator is supplied per subscription) while letting the
client own the failure path: a validation failure nacks and reports a
`validation-error`, mirroring the existing `parse-error` path so a poison
payload is told apart from a transient handler failure. There is no schema
library in the repo, so validators are small hand-written guards that throw an
explicit error naming the offending field.

The `crawl-article-discovery` validator and its message types ship here even
though the discovery consumer arrives in HNT-2112, because this task's
acceptance criteria cover both queues. The validator is unit-tested now and
wired into the consumer in Task 6.2.

Validators reject malformed input but do not transform it (no trimming or
normalization), keeping the boundary a pure check. URL normalization for
deduplication is deferred to the Milestone 8 key-derivation helper, which is
the single place that hashes a URL, so trimming lives with the hash rather
than being half-applied at the edge.

## HNT-2111: article-list discovery handler

The cross-domain filter compares each discovered article's registrable domain
(eTLD+1) against the page's. Registrable-domain extraction uses tldts (the
same library content-monorepo uses) so multi-part suffixes like .co.uk resolve
correctly for non-US publishers. getDomain runs with allowPrivateDomains so
platform suffixes (e.g. blogspot.com) are the boundary, treating two
publishers on one platform as different domains.

The same-domain baseline and each discovery event's source_url are the
enqueued page URL (message.url), not Zyte's post-redirect URL. The publisher
pages come from a curated first-party list and do not cross-domain redirect,
and using the enqueued URL keeps the discovery event's source_url aligned with
the crawl-article job that triggered it. A page that did cross-domain redirect
would yield zero discoveries, which is a safe failure surfaced by monitoring
rather than bad data.

page_position is the article's 1-based index in the original Zyte list, so it
reflects true page placement; gaps after cross-domain and duplicate filtering
are intentional.

## HNT-2115: Redis state client

ioredis is the client. content-monorepo has no Redis precedent, so the choice
is on merit: ioredis is the de-facto Node client, with first-class Lua eval
for the token-checked lock release here and the distributed rate limiter
planned in HNT-2441.

Locks release through a Lua script that deletes the key only if the stored
token still matches the caller's. A plain DEL could release a lock that
already expired and was re-acquired by another worker; the token check makes
release safe under the at-least-once redelivery the workers assume.

Keys are not environment-prefixed because each environment has its own
Memorystore instance, so the keyspace is already isolated. hashUrl trims the
URL before hashing, which is the normalization deferred from the
message-validation boundary, kept here so the one place that derives keys also
owns it. Fetch timestamps and content hashes default to a 30-day TTL; lock
callers pass a short TTL derived from the Pub/Sub ack deadline. TTL-taking
operations reject a non-positive TTL so a misconfigured lock window fails fast
with a clear error rather than an opaque Redis one.

shutdownRedis uses the capture-then-null pattern but, unlike the Pub/Sub
client, has no shutdownPromise guard: Redis has no in-flight subscriber drain
to coordinate, and both services already guard their SIGTERM handler against
re-entry, so a concurrent or repeated shutdown cannot occur in practice.

## HNT-2117: agent tick loop

The agent dedups its own enqueues with agent-owned markers (page:enqueued and
article:enqueued), not the worker-written fetch keys. The tech spec's state
table omits these, but the agent must avoid re-enqueuing the same item every
60-second tick during the window between enqueue and the worker recording a
fetch, so an agent-side marker is required. The marker stores the enqueue
timestamp with the default 30-day TTL, and the tick re-enqueues only once the
crawl interval has elapsed since that timestamp. This diverges from the
work-breakdown's "TTL = interval minus a minute" because encoding the window
in the TTL is fragile near the tick cadence (a 1-2 minute interval would
re-enqueue every tick); comparing timestamps stays exact and independent of
the tick interval. The check-then-set is safe because the agent is
single-replica; validatePublisherList additionally rejects duplicate URLs so
no two list entries race on the same key within a tick. Publishing happens
before the marker is set, so a failed publish retries next tick rather than
being suppressed.

/healthz tracks loop liveness, not tick success: the run loop records the tick
time after every iteration including a failed one, so a transient Pub/Sub or
Redis outage (surfaced to Sentry) does not trip the staleness probe into a
restart that would not fix the upstream fault. Numeric config is validated at
load so a malformed env value fails fast rather than surfacing as a NaN TTL
mid-tick.

## HNT-2116: Redis fetch checks in the article worker

The article worker wraps extraction in Redis dedup (processArticle): a
fetch-recency skip, a per-article distributed lock, and a content-hash check
that gates publishing.

The fetch-recency skip applies only to discovered articles. Live articles
bypass it so they keep resyncing curated metadata on the agent's cadence; the
agent already throttles their enqueue interval, and the Corpus sync must run
each time. The lock and content-hash check apply to both.

The lock TTL is derived from the subscription ack deadline minus 30 seconds
(the tech spec's "ack deadline - 30s"), not from maxExtensionSeconds. An
earlier revision of this code sized the lock to maxExtensionSeconds - 30 on the
reasoning that the SDK holds a healthy message for up to maxExtensionSeconds.
That was wrong for the failure mode that matters: when a worker crashes the SDK
stops extending the lease, and Pub/Sub redelivers around the ack deadline (the
lease granularity, 300s), not around maxExtensionSeconds (570s). A lock sized
to 540s outlives that redelivery, so the legitimate retry on another worker
finds the lock held and skips the fetch, which is a lost fetch. Sizing the lock
to ackDeadline - 30 (270s) clears it just before redelivery so the retry
re-fetches. The lock can expire mid-processing on a healthy worker that runs
past 270s, but that worker still holds the message via lease extension, so no
competitor races the expired lock; a rare at-least-once duplicate in that
window is absorbed by the fetch and content-hash idempotency. ackDeadlineSeconds
is a config value (env ACK_DEADLINE_SECONDS, default 300) that must match the
Terraform subscription setting. That coupling is enforced only by convention,
not code; a deploy-time check that the configured value matches the live
subscription is a possible follow-up. The safe-failure direction is setting it
too low (a milder duplicate-fetch window the idempotency absorbs) rather than
too high (the lost fetch). This reversal was confirmed by an architectural
review of the crash-and-redelivery timeline.

The content hash excludes url (constant per key) and extracted_at (set fresh
each fetch); hashing them would change the digest every fetch and republish
unchanged articles. The Corpus sync for live articles runs inside the handler
regardless of the hash, so a curator-visible metadata change is still synced
even when the article body is unchanged.

## HNT-2119: Redis fetch checks in the discovery worker

The discovery worker wraps the crawl in Redis dedup (processDiscovery): a
page:fetch interval-skip (compared against the job's own interval_minutes), a
per-page lock, and a per-article page check. Discovery events are published
for every discovered article and context regardless of state, since a
discovery is a distinct occurrence worth recording each time; only the
crawl-article job is gated by article:fetch, so an article already crawled
recently is not re-enqueued. The page:fetch marker is written after publishing
(prefer a duplicate over a lost crawl, matching the article worker).

The discovery worker reads article:fetch through the same articleFetchTtlMinutes
window (default 60) the article worker writes it with, so a re-discovered
article is not re-enqueued for ~60 minutes even though its page re-crawls every
interval_minutes (e.g. 20). This is intended: page-crawl cadence and
article-fetch freshness are separate dimensions, and the article worker
double-gates on the same key, so a re-enqueued job that slipped through would
still be skipped there.

The recency predicate is shared within the worker as withinMinutes
(recency.ts), used by both processArticle and processDiscovery. It was not
lifted into crawl-common: a helper living there would call crawl-common's own
getTimestamp, which the per-package unit tests cannot mock, so the worker
keeps its own helper that imports the mockable getTimestamp. The agent's
equivalent enqueuedWithin stays separate for the same reason; the small
cross-package duplication is accepted over breaking test isolation.

## HNT-2441: distributed Zyte rate limiter

The Zyte rate limit is a Redis token bucket: an atomic Lua script refills at
ratePerMinute up to a burst capacity and takes one token per call. It uses the
Redis server clock (TIME) so all replicas measure elapsed time against one
clock rather than depending on synchronized client clocks. One bucket key is
shared by both worker roles because the limit is per Zyte API account; the key
is not environment-prefixed since each environment has its own Redis instance.

The limiter gates the Zyte client through an injected beforeRequest hook,
awaited before every request including each retry, so the client stays
decoupled from Redis and the agent (which makes no Zyte calls) is unaffected.
The worker's awaitZyteToken waits for a token up to a max, then throws so the
message nacks and redelivers, which sheds load when Zyte is saturated rather
than pinning a worker. It is disabled by default (rate 0) for local and test
runs; deployed environments set the plan's RPM. This limiter also bounds the
blast radius of the lock-TTL double-fetch noted in the backlog item.

## Task 5.8: operational metrics

Metrics live in a standalone packages/metrics, mirroring packages/sentry: a
module-singleton client with a transport-agnostic emit API (initMetrics, incr,
count, timing, time, shutdownMetrics). An empty STATSD_HOST disables emission,
like Sentry's empty DSN.

Transport is StatsD UDP via hot-shots to the MozCloud OTEL gateway, chosen over
the OTLP/OpenTelemetry SDK that the research recommended as the strategic
primary. StatsD is the MozCloud SRE docs' GA "Preferred" path, needs no Helm
plumbing (the OTLP path needs a human-gated OTEL_COLLECTOR_HOST from
status.hostIP), and is simple and unit-testable now. The emit API is
transport-agnostic, so swapping to OTLP later (the convention in the newest
Node/TS services) touches no call sites. Delivery to Yardstick is deploy-gated
(the gateway is in-cluster, unreachable from this workspace), so the transport
should be confirmed in dev before locking in.

Instrumentation avoids coupling crawl-common to packages/metrics: message
duration and a per-outcome counter come from a withMessageMetrics wrapper
(processArticle and processDiscovery return processed/skipped so a dedup/lock
skip is not counted as real work); Zyte latency wraps the extract calls with
the metrics time() helper at the handler call sites; Zyte retries use an
injected onRetry hook on the Zyte client, mirroring the beforeRequest hook; and
the agent emits tick duration and per-kind enqueue counts from its loop.

The onRetry hook destructures p-retry's onFailedAttempt context as
{ error, retriesLeft }, not the whole context as one error value. p-retry@8
passes onFailedAttempt a RetryContext object whose error field holds the
underlying error, so calling isRetryable on the context itself always returned
false and the counter never fired. This typechecks (isRetryable takes unknown,
and the context happens to carry retriesLeft), so a unit test asserting the
counter fires on a real retry guards it.

Per-operation Redis latency is deferred to a follow-up. It is the only metric
that would require wrapping every crawl-common Redis op behind an injected
timing hook, the most invasive change to a critical, heavily-tested module for
the lowest-value signal (Redis ops are sub-millisecond and local, and their
time is already captured in aggregate by tick and message duration). The
onTiming-hook approach is specified in the Task 5.8 plan.

## HNT-2120: agent main loop and health check

The once-a-minute tick loop, the /healthz staleness probe (500 if the last
tick is older than the threshold), and the SIGTERM drain are already
implemented in app.ts and main.ts (the latter finalized in HNT-2117), so this
task adds only agent operability: a .env.example and a dev script that loads
it. The single-replica requirement is met by the chart defaulting a
non-autoscaled workload to one replica; the matching strategy: Recreate (so a
deploy never runs two agents and breaks the single-replica enqueue dedup) is a
webservices-infra change, committed on a local branch since infra deploys are
human-gated.

Live articles have no discovery page, so their crawl-article job uses the
article's own URL as source_url. They share one configurable enqueue interval
(liveArticleIntervalMinutes) rather than a per-article interval, since the
publisher list does not carry one.

The publisher list is validated at startup via validatePublisherList in
crawl-common (reusing the message validators), so a malformed config fails
fast rather than enqueuing bad jobs.

## Publisher list generation from the legacy crawl pages

scripts/generate-publishers.py converts the legacy crawl pages (the curated
publisher Google Sheet exported as a Python PAGES list) into the agent's
publisher list. The legacy entries are {url, targets:[{locale, topics[]}]}; the
script flattens each to one discovery context per (locale, topic). A locale
maps to a New Tab scheduled surface as NEW*TAB*<LOCALE> (en_US to NEW_TAB_EN_US),
which is the surface id format the rest of the content system uses; all twelve
legacy locales have a matching surface. The topic is lowercased to match the
discovery context convention in publishers.example.json (the curated subtopic
label is otherwise kept verbatim, since the article_discoveries.topic column is
free text, the renamed page_subtopic). Entries are merged by URL so a page
crawled for several surfaces is one entry with several contexts, satisfying the
validator's unique-URL rule. interval_minutes defaults to 20 and live_articles
is empty (the legacy list has none; curated live articles arrive via the Corpus
API in Phase 5). The full generated publishers.json (about 3400 pages) is
committed at services/crawl-agent/publishers.json and ships in the image next to
the package, so the agent has its list at deploy time with no mounted config or
bucket fetch. Editors re-export it via the sheet exporter and commit the result,
so the list is reviewed like code; the large per-export diff is the accepted
cost of that. The agent resolves the path relative to its own module
(import.meta.url, ../publishers.json) rather than the working directory, because
the container runs from /app while the file sits next to the compiled code; this
also works under tsx in local dev. One list serves every environment, so there
is no PUBLISHER_LIST_PATH env var. publishers.example.json stays as the small
format reference. This supersedes the earlier decision to gitignore the list.

## End-to-end validation against dev

The full pipeline was validated against the real dev project (moz-fx-hnt-nonprod)
by running the agent and both workers locally (no deploy) against real dev
Pub/Sub, real Zyte, and local Docker Redis, with a 10-page en_US subset of the
generated publisher list. One agent tick enqueued 10 discovery jobs; the
discovery worker extracted article lists via Zyte and published 42 discovery
events and 42 crawl-article jobs; the article worker extracted each via Zyte and
published 42 article events. Both BigQuery subscriptions wrote correctly: 42 rows
in article_discoveries and 42 in articles, every article tracing back to a
discovery url, zero duplicate urls (the Redis fetch markers, locks, and content
hash held under at-least-once delivery), and correct fields (2000-char
body_truncated, language, authors, lowercase topic, NEW_TAB_EN_US surface,
1-based page_position). This exercises the discovery to crawl-article to article
flow, the event schemas the BigQuery subscriptions enforce, the publisher-list
mapping, and the dedup design at realistic throughput.

Local-dev note: metrics default to the in-cluster StatsD gateway host, which does
not resolve outside the cluster, so a local run logs benign getaddrinfo errors
unless STATSD_HOST is set empty. The empty-to-disable knob is documented in the
.env.example files; the unset default targeting the gateway is correct for
deployed environments.

## QA hardening of event mapping and lock release

A QA pass (parallel code-review agents plus a multi-locale dev run that confirmed
multilingual extraction and live cross-tick agent dedup) surfaced four fixes:

The BigQuery authors.name subfield is REQUIRED in both tables, but the Zyte
client does no runtime validation and Zyte can return an author carrying only
nameRaw. The event mappers projected { name: a.name } unconditionally, so a
nameless author serialized to an empty struct and would fail the BigQuery
subscription write. Those subscriptions have no dead-letter queue (schema
mismatches are treated as code bugs), so the message would wedge in endless
redelivery. The mappers now drop nameless authors via toEventAuthors, and the
Corpus update path filters them before falling back to the corpus item's authors.

published_at was passed through from Zyte unvalidated; an empty or malformed
value (the empty string slips past a nullish guard) would fail the BigQuery
TIMESTAMP parse and wedge the message the same way. It is now emitted only when
non-empty and parseable via toEventTimestamp. The two mapping helpers live in
handlers/event-fields.ts and are shared by both extractors.

releaseLock ran unguarded in a finally block. A transient Redis error during
release would propagate out of finally and replace a successful handler return,
nacking and redelivering a message whose work had already completed (and
re-running the Corpus sync for live articles). The lock self-expires on its TTL,
so a release failure is now caught and logged rather than thrown, so cleanup
never changes the message outcome.

Zyte request timeouts (AbortSignal.timeout rejects with a DOMException named
TimeoutError) were classified non-retryable, so a hung connection failed
immediately rather than retrying. They are now retryable, matching the Corpus
API client which already retried timeouts.

The discovery summary intentionally maps Zyte's description (the list-page dek),
not articleBody, despite the BigQuery column comment mentioning articleBody: the
dek is the closest analog to the legacy RSS summary field, and articleBody would
put full body text in a summary column. Left as is; flagged for human
confirmation if the legacy source differs.

## Capability gaps vs tech spec and legacy (content-ml-services)

Dated note (2026-06-25). This section is a capability gap analysis comparing
three sources against the current implementation on the integration branch:
the tech spec and implementation guide, the legacy Cloud Functions plus
Metaflow crawler in content-ml-services, and the code in packages/crawl-common,
services/crawl-agent, and services/crawl-worker. Each gap below was verified
against the actual code, not inferred from the spec text alone. Gaps already
captured as decisions above (the lock TTL sizing, the StatsD transport choice,
the Redis latency deferral) are not repeated here except where a concrete
follow-up remains. Severity is blocker (cutover or shadow mode cannot proceed
without it), important (needed for production parity or operability), or
nice-to-have.

The current pipeline already covers the core flow end to end: the agent tick
loop and publisher list, Zyte article and article-list extraction, both worker
roles wired to Pub/Sub, Redis fetch and lock and content-hash dedup, the
distributed Zyte rate limiter, message validation at the consumer boundary,
event mapping to both BigQuery tables, Sentry, and StatsD metrics. The gaps are
the pieces around that core.

### Blockers for shadow mode and cutover

1. Fetch live section items from the Corpus API and wire them to the agent.
   The spec's agent reads live articles from the Corpus API in Phase 5, and the
   legacy HydrateSectionItemsFlow (jobs/metaflow/prospecting/HydrateSectionItemsFlow.py)
   already does the read half: CorpusApiPublicBackend.fetch_sections and
   fetch_section_items_df (ml_shared/common/corpus_api/public_backend.py) query
   the public curated-corpus-api per ScheduledSurfaceGUID and flatten each
   sectionItem.corpusItem into a row with CORPUS_ITEM_ID, RESOLVED_URL, TITLE,
   TEXT (excerpt), TOPIC, PUBLISHER, TIME_SENSITIVE, IMAGE_URL, AUTHOR. The new
   Corpus client (packages/crawl-common/src/corpus-api/client.ts and index.ts)
   exports only initCorpusApiClient and updateApprovedCorpusItem, so it is
   write-only; there is no public-backend read, no getScheduledSurface query,
   and no LiveArticle source. The agent loads a static JSON file
   (services/crawl-agent/src/publisher-list.ts and config.ts), and the generated
   list ships live_articles empty (scripts/generate-publishers.py and the
   publisher-list-generation note above). Affected area: a new Corpus public
   read path in crawl-common plus agent wiring to populate live_articles.
   Severity: blocker for the live-article sync the spec's Article Worker step 5
   describes; the write path exists but is never exercised in production because
   nothing populates corpus_item.

2. Article parse-quality monitoring and alerting. The legacy
   article_monitoring.py (jobs/cloudfunctions/crawl/article_monitoring.py)
   computes, per locale, the percentage of discovered URLs that were successfully
   parsed (zyte_articleBody longer than 200 chars) over an 8-day window and
   raises an error when it falls below a target (default 94 percent,
   parse_min_percentage). The new system has Sentry for individual errors and
   StatsD success/failure counters, but no equivalent parse-yield ratio metric or
   threshold alert that would catch a silent degradation where Zyte returns 200
   but empty or thin bodies. Affected area: a derived metric or scheduled query
   plus an alert (the spec's Monitoring section and the Grafana dashboard task
   HNT-2129). Severity: blocker for the shadow-mode comparison and the
   content-alerts requirement, important thereafter.

### Important for production parity and operability

3. Deploy-time ACK_DEADLINE_SECONDS guardrail. The worker derives its lock TTL
   from config.ackDeadlineSeconds (services/crawl-worker/src/config.ts, default
   300, lockTtlSeconds = ackDeadlineSeconds - 30), and the Terraform subscription
   hardcodes ack_deadline_seconds = 300 (webservices-infra
   hnt/tf/modules/pubsub/main.tf). The two are coupled only by convention:
   ACK_DEADLINE_SECONDS is not set in the Helm values
   (webservices-infra hnt/k8s/hnt/values.yaml), so the worker silently relies on
   its default matching the Terraform value, and a drift between them would
   resize the lock window without any check. The lock-TTL decision note above
   already flags this as a possible follow-up; it remains unbuilt. Affected area:
   either set ACK_DEADLINE_SECONDS from the same source as the Terraform value, or
   add a startup or deploy check that the configured value matches the live
   subscription. Severity: important (mis-sizing the lock reintroduces the
   double-fetch the note describes).

4. StatsD delivery to Yardstick is unverified in a deployed environment. The
   metrics package defaults to the in-cluster gateway host
   (packages/metrics/src/config.ts) and the apps wire counters and timings, but no
   STATSD_HOST is set in the Helm values and the gateway is unreachable from this
   workspace, so end-to-end delivery to Yardstick has never been confirmed (see
   the metrics decision note and the end-to-end validation note above). The HPA in
   webservices-infra hnt/k8s/hnt/values.yaml also autoscales on CPU only, with the
   metric and replica-range tuning (HNT-2152) still a backlog deploy task.
   Affected area: a dev deploy to confirm metric flow, plus HPA tuning. Severity:
   important for operability before shadow mode.

5. Per-operation Redis latency metric. The spec's crawl-agent metrics list Redis
   latency, and the Task 5.8 plan specifies an onTiming hook. It was deliberately
   deferred (see the operational-metrics note above): wrapping every crawl-common
   Redis op is the most invasive change for the lowest-value signal. Affected
   area: an injected timing hook in packages/crawl-common/src/redis. Severity:
   nice-to-have, but listed because the spec names it explicitly.

6. crawl-common package split (HNT-2682). The spec's structure keeps a single
   crawl-common, but HNT-2682 plans to split it into independent packages to
   reduce coupling; packages/ still contains one crawl-common (plus the already
   separate metrics and sentry). Affected area: packages/crawl-common. Severity:
   nice-to-have (Backlog in Jira; explicitly out of the buildable set in the
   integration-baseline note above).

### Legacy capabilities intentionally not mirrored (scope confirmations)

These are legacy behaviors the new design deliberately drops or replaces.
Listed so a reviewer can confirm the scope decision rather than treat them as
oversights.

7. RSS and OPML feed discovery. The legacy crawl_handler.py
   (jobs/cloudfunctions/crawl/crawl_handler.py) ingests both RSS via OPML feed
   lists from a GCS bucket (split_opml_requests, listparser, crawl_type RSS) and
   PAGE crawling. The new system is PAGE-only: there is no feed parser, and the
   backfill migration takes only source = PAGE rows
   (migrations/002_backfill_article_discoveries.sql). This matches the spec
   (article_discoveries replaces rss_feed_items with PAGE-source discovery) and is
   a confirmed scope reduction, not a gap to close, unless any surface still
   depends on RSS-only publishers.

8. MERGE dedup-on-write and load_count. The legacy bq_merge.py
   (jobs/cloudfunctions/crawl/bq_merge.py) writes via a BigQuery MERGE keyed on
   canonical_url plus category plus surface, updating in place and incrementing a
   load_count column. The new pipeline writes append-only via BigQuery Pub/Sub
   subscriptions and resolves duplicates with latest-per-URL queries (the spec's
   at-least-once model). Consequently load_count and the in-place update are gone
   by design. Affected area: the comparison queries in the shadow-mode task
   (HNT-2131) should account for the append-only versus MERGE difference.

9. Dropped legacy columns. The spec's field tables drop origin_title, source,
   category, keywords, content_cleaned, engagement, unread, id, crawled_date,
   published_date, loaded_at, and load_count from article_discoveries, and the new
   articles and article_discoveries schemas omit them
   (packages/crawl-common/src/types/events.ts, migrations/001 and 002). This is the
   intended schema simplification; flagged only so the ML team confirms none of
   these are still consumed downstream during shadow mode.

10. Google Sheet exporter to generate the publisher list from the curated sheet.
    The legacy publisher source is a Google Apps Script ("Exporter, Generate
    Python") that converts the curated publisher Google Sheet into a hardcoded
    Python module; the legacy pages.py header
    (jobs/cloudfunctions/crawl/pages.py) references it, and the script itself
    lives at jobs/cloudfunctions/crawl/docs/sheets_app_script.js. hnt-content has
    no equivalent sheet-to-list exporter and no docs directory. Because such a
    script runs inside Google Sheets (Apps Script), not in this Node repo, it
    should be tracked under hnt-content/docs as non-executing reference rather
    than run here. This is distinct from scripts/generate-publishers.py, which
    only converts the already-exported legacy pages.py into publishers.json and
    does not talk to the sheet. Severity: nice-to-have until the hardcoded list is
    retired (Phase 5 replaces the list with the Corpus API per the spec, which
    supersedes the sheet path entirely).

## Corpus API read for live section items

The Corpus client gains a read alongside the existing write:
getScheduledSectionItems queries getSectionsWithSectionItems on the admin API for
a scheduled surface and maps the result to the agent's LiveArticle shape. This
mirrors the legacy HydrateSectionItemsFlow read half (which used the public
getSections). The admin sections query is chosen over the date-based
getScheduledCorpusItems because it matches the legacy "section items" semantics,
needs no date-window bookkeeping, returns the full ApprovedCorpusItem including
language (so non-EN surfaces are correct rather than defaulted), and is authorized
by the same scheduled_surface_curator_full JWT group the write path already uses,
so no new credential or scope is needed. The surface is passed as the bare string
(NEW_TAB_EN_US); the schema types it as ID, not an enum.

Only sections whose computed status is LIVE are kept; SCHEDULED, DISABLED, and
EXPIRED sections are skipped. This matters because the admin sections query,
unlike the public getSections the legacy flow used, does not apply the date-window
liveness filter, so it returns not-yet-live and expired custom sections too;
gating on status == LIVE restores the legacy "currently on the surface" semantics
(ML-created sections carry no date window and compute to LIVE, so they are
unaffected). Items are de-duplicated by URL across sections, because the agent's
publisher list requires unique live-article URLs (assertUniqueUrls) and the same
article can be scheduled in more than one section. The inline fetch, retry, and error handling
were factored out of updateApprovedCorpusItem into a shared graphqlRequest helper
so the read and write share one transport with identical semantics (retry 5xx and
network, fail fast on 4xx and GraphQL errors); the write path behavior and its
tests are unchanged. Corpus author names are non-null, so no nameless-author
filtering is needed here, unlike the Zyte path.

## Agent live articles from the Corpus API

The agent now sources live_articles from the Corpus API (getScheduledSectionItems)
when configured, mirroring the legacy HydrateSectionItemsFlow. pages still come
from the publisher list file; only live_articles move to the Corpus, since the
discovery-context mapping for pages is undefined and the legacy refresh is
scoped to section items. The Corpus source is gated on CORPUS_API_JWK_JSON being
set, like the worker's optional Corpus sync: with no JWK the agent falls back to
the file's live_articles (empty by default), so local and emulator runs work
without a key. tick.ts is unchanged because it still consumes the same
PublisherList.live_articles shape; the wiring sits in loadPublisherList's sibling
fetchLiveArticles and in main.ts.

The list is refreshed on its own interval (CORPUS_REFRESH_MINUTES, default 15,
matching the legacy cadence) rather than every tick, so editorial changes
propagate without a restart while a Corpus outage does not couple to every 60s
tick. The first load at startup fails fast (a misconfigured or unauthorized
client should not start a degraded agent), but a later refresh failure keeps the
last good list and retries next tick, reported to Sentry: degraded freshness is
preferred over dropping live articles, matching the spec's failure-mode stance.
Surfaces are a config list (default NEW_TAB_EN_US, matching the legacy en-US-only
deployment) so adding locales is a config change, not a redeploy. The same
curator-full JWT group authorizes the read, so no new credential is needed.

When the Corpus source is enabled, config load fails fast if no surfaces are
configured or the refresh interval is not positive, so a typo cannot silently
crawl zero live articles. The first Corpus read blocks startup and can retry for
tens of seconds on a cold blip, during which /healthz is not yet ready, so the
deploy should add a K8s startupProbe (noted for the webservices-infra follow-up)
to avoid a liveness restart loop.

## REDIS_HOST and PROJECT_ID config wiring

The crawl pods need REDIS_HOST and PROJECT_ID, which are non-secret runtime
config the mozcloud chart does not inject by default (only secrets arrive
automatically, via the platform ExternalSecret). The proper fix lives in
webservices-infra: PROJECT_ID and REDIS_HOST are added to the hnt-config
configMap for all three environments. PROJECT_ID reuses the per-env
global.mozcloud.project_id via a YAML anchor so the two cannot drift. REDIS_HOST
points at a new google_dns_record_set A record (hnt-redis-<env>) rather than the
Memorystore IP, mirroring the autopush and merino convention, so the name
survives an instance recreate; the zone comes from the projects remote state the
tenant already reads. That change is staged on a local-only webservices-infra
branch pending human review.

To unblock deploying the app before that infra change merges, this repo carries
a temporary fallback: crawl-common deployed-defaults maps ENVIRONMENT to the
known dev/stage/prod Memorystore IPs and project ids, and the agent and worker
config use it only when the env var is unset (process.env.X ?? deployedX(env)).
The env var always wins when set, so a configured deploy (post-infra-merge) and
local dev (which sets the values via .env) never hit the fallback, and the
behavior is unchanged for the prior empty-default case. The defaults live in
crawl-common because both services need the identical table (DRY). Every site is
marked TEMPORARY (HNT-2086); remove the module, its spec, and the two config
call sites once the chart sets both env vars. The dev subscriptions use a 300s
ack deadline, matching the worker default, so the lock-TTL derivation is
consistent in the deployed environment.

## Pub/Sub emulator integration-test startup

The four integration suites that start the Pub/Sub emulator (the pubsub client
test plus the agent tick and both worker consumers) intermittently hung their
beforeAll hook at the 120s timeout. Root cause: PubSubEmulatorContainer defaults
to waiting for a "Server started" log line, but the pinned cloud-cli emulator
image stays silent through its slow JVM boot (about 165s) and emits that line
only at the very end, so the log wait races the startup timeout. Fix: wait on
the emulator's listening port instead (Wait.forListeningPorts), the true
readiness signal and the same approach the Redis container in these suites
already uses; the createTopic call right after fails fast if the emulator is not
actually ready. The container startup budget was raised to 180s and each
beforeAll hook timeout set to that plus 30s, so testcontainers owns the deadline
and reports a clear error instead of vitest killing the hook first. Test files
only; no production change.

## Corpus live articles: tolerate a malformed item instead of crash-looping

The first dev deploy crash-looped the agent at startup: fetchLiveArticles ran
the Corpus API response through validatePublisherList, the same fail-fast
validator the static publisher-list file uses, and a real curated item with a
blank publisher threw a MessageValidationError that aborted startup. The static
file is config (a bad entry is an operator error worth failing fast on), but the
Corpus API is external input whose data quality we do not control, so the same
strictness is wrong there. Fix: fetchLiveArticles now validates each item on its
own (validateLiveArticle, newly exported from crawl-common) and skips the
malformed ones with a warning, so one bad curated item degrades freshness for
that item rather than taking down the whole crawler. Client and transport errors
from the Corpus read still propagate, so a misconfigured or unreachable Corpus
aborts startup as before, and the static file path stays fail-fast. This follows
the edge-validation principle: fail fast on our own config, tolerate and isolate
bad external data.

## Cross-platform test reliability (macOS) and Redis IPv4

The test suite passes on Linux CI but had latent edge cases that could flake on a
developer's macOS machine, which we cannot test directly. Four changes harden it.
First, the Redis client now sets ioredis `family: 4`. Memorystore is IPv4 only,
so this is correct in production, and it also fixes tests: on macOS Docker
Desktop a container host of `localhost` can resolve to IPv6 `::1`, which the
container does not listen on, hanging the connection; forcing IPv4 avoids that.
Second, the integration tests force the Pub/Sub emulator endpoint to `127.0.0.1`
(`getEmulatorEndpoint().replace('localhost', '127.0.0.1')`) for the same IPv6
reason on the gRPC dial. Third, the Redis `GenericContainer` now sets
`withStartupTimeout` (matching the Pub/Sub emulator) so a cold image pull on a
slow Docker VM does not trip the testcontainers 60s default; the redis-only suite
also gains a hook timeout that outlasts the startup budget so testcontainers owns
the deadline. Fourth, two real-time-dependent tests were made deterministic: the
agent `/healthz` boundary tests freeze `Date` (only Date, so HTTP timers stay
real) and assert at a 1ms boundary instead of a 1s wall-clock buffer, and the
Redis rate-limit refill test polls for the refill on the server clock rather than
sleeping a fixed span that could fall short under load. Two independent audits
(timing/race/nondeterminism and macOS/testcontainers) found no other reliability
hazards: endpoint construction, mock and fake-timer hygiene, `process.env`
restoration, per-file worker isolation, and sort-before-compare on async fan-out
were already correct.

## Guardian (and UA-allowlisted publishers): carry over the crawler User-Agent

The dev deploy surfaced a steady stream of `ZyteError: 451` (Unavailable For
Legal Reasons) on theguardian.com, the busiest publisher in the list. The legacy
crawler (ml-services `zyte_config.py`) sends a specific Mozilla New Tab crawler
User-Agent for theguardian.com, paired with `Zyte-Override-Headers: User-Agent`
so Zyte forwards our UA instead of its own; the Guardian allowlisted Mozilla's
crawler by that exact string, and presenting it clears the 451. We had the client
capability (`customHttpRequestHeaders`) but the worker never passed it, so we
dropped that behavior in the rewrite. Fix: a small `zyteOptionsForUrl` helper in
the worker builds the per-request Zyte options and, for a registrable-domain
allowlist (currently just theguardian.com), attaches the UA headers. The custom
UA only takes effect in `httpResponseBody` mode (a Zyte limitation), which both
crawl paths already use, so this is purely additive. The UA string is reproduced
byte for byte because the allowlist matches on it. Other dev errors were triaged
as not our bug: Zyte 520s are transient and already retried, and the Corpus
"could not generate an S3 URL" failures come from the Corpus API rejecting a few
curated items' source images on update, not from our payload (we pass the item's
existing imageUrl back unchanged, as the mutation requires).

## Cap Pub/Sub flow control so the article worker stops OOM-killing itself

The dev article-worker pods entered a crashloop: OOMKilled (exit 137) about 31
seconds after start, against the 512Mi container limit, while
dev-crawl-article carried a backlog of over 250,000 messages. The cause was in
the crawl-common Pub/Sub consumer, which set maxExtensionTime but never set
flowControl.maxMessages, so the @google-cloud/pubsub SDK applied its default of
1000 outstanding messages. Under a backlog the worker immediately leased about
1000 messages and ran that many concurrent Zyte fetches, each holding a large
response body in memory, which pegged CPU and exhausted 512Mi long before any
handler finished. By design the workers carry no in-process Zyte concurrency
cap, so the Pub/Sub flow-control limit is the intended bound and leaving it
unset was the bug. Fix: the consumer now sets flowControl with a configurable
maxMessages (default 16, with allowExcessMessages false so the SDK stops pulling
at the cap rather than overshooting on a single streaming-pull response). The
worker threads it through config as PUBSUB_MAX_MESSAGES so the cap can be raised
without a code change once the pod has more memory or a distributed Zyte rate
limiter (HNT-2441) lands. 16 is a deliberately conservative starting point: it
keeps peak memory well under 512Mi while still giving Pub/Sub enough in-flight
work to keep the single replica busy, and the deployed value can be tuned up
from the dashboard.

## Dev deploy chain: timing and the sync-wedge failure mode (2026-06-30)

Characterized the dev deploy chain end to end. A push to hnt-content main triggers
a GAR image build, then argocd-image-updater commits the new digest into
webservices-infra's .argocd-source-hnt-dev-us-west1-hnt.yaml, then ArgoCD auto-sync
applies it. Measured happy-path timing: push to digest committed about 1m50s, sync
applied to all pods healthy about 52s, roughly 3 minutes total. A long-horizon loop
should poll the deployed digest and pod health every ~30s and expect health in
about 3 minutes rather than blanket waiting.

The real risk is not latency but sync wedging. Two failure modes were observed: a
sync operation pinned to a stale revision keeps waiting for the healthy state of the
old unhealthy image and blocks new syncs ("another operation is already in
progress"), and the repo-server intermittently returns ComparisonError
DeadlineExceeded, leaving ArgoCD comparing against a stale main. Recovery required a
manual terminate-op, hard refresh, and sync to HEAD in the UI. Clearing these
programmatically needs ArgoCD API access (the argocd-iap-access SA needs
roles/iap.httpsResourceAccessor on the webservices IAP backend, which currently
returns 403), so a fully hands-off loop depends on that grant or on auto-sync not
wedging. Read-only cluster access for diagnosis is documented in CLAUDE.local.md
(shared cluster webservices-high-nonprod, namespace hnt-dev, via gcloud
get-credentials --dns-endpoint).

## Live articles: tolerate a blank publisher from the Corpus API (2026-06-30)

Observed in dev that the agent skipped 100% of live articles (179 of 179) with
"corpus_item.publisher must be a non-empty string", leaving the live-article path
fully dead. A schema check against content-monorepo confirmed publisher is a stored
scalar (ApprovedItem.publisher String, NOT NULL, no default) that the Corpus DB
legitimately holds as an empty string for these dev items, and getSectionsWithSectionItems
reads the full approvedItem row, so a blank is real data rather than a missing field
selection. The update mutation requires the key but accepts an empty string and writes
it verbatim with no re-derivation, and the legacy HydrateSectionItems flow round-tripped
publisher as-is without requiring it. Requiring non-empty publisher was therefore wrong:
it rejected every dev item for no schema-backed reason. Fix: validateCorpusItem now
allows an empty publisher (allowEmpty), the same treatment excerpt already gets. This
fixes both the agent enqueue and the worker's inbound message validation, which would
otherwise nack every live-article message. The worker still echoes publisher back to
updateApprovedCorpusItem verbatim, so a blank can never overwrite a real stored value,
which is the only data-corruption vector.

## Guardian 451: drop the custom User-Agent; httpResponseBody alone is the fix (2026-06-30)

The earlier Guardian UA fix did not clear the 451 in dev: theguardian.com section-page
articleList requests kept dead-lettering (DLQ peek showed 25 of 25 were guardian, +45
per crawl cycle). A cached real-Zyte eval in content-ml-services
(jobs/offline_eval/zyte-http-vs-browser/.../theguardian.com.json) is decisive: guardian
articleList returns 45 of 45 success in httpResponseBody mode and 45 of 45 HTTP 451 in
browserHtml mode, with no custom User-Agent in either case. So the 451 is the Guardian
WAF blocking Zyte's headless-browser fingerprint, not a geolocation, IP, or UA gate; the
UA was a red herring carried over from the legacy config and, paired with
Zyte-Override-Headers, was the only difference between our 451 request and the eval's
known-200 request. Removing the customHttpRequestHeaders special-casing (reverting the
zyteOptionsForUrl helper) leaves both crawl paths on a plain httpResponseBody request,
which the eval proves works. No geolocation or ipType is needed: a geo block would fail
both fetch modes identically, and it does not.

## Article worker throughput: raise flow-control cap; HPA is the real fix (2026-06-30)

The dev-crawl-article backlog grew unboundedly (253k to 395k over 90 min): discovery
waves add 60-90k crawl-article jobs every ~20-40 min while the article worker drained
only ~350/min. The binding constraint is concurrency, not memory or the Zyte rate
limiter: article pods used only ~90Mi of their 512Mi limit at maxMessages=16, and the
Zyte rate limiter is disabled in dev (ZYTE_RATE_LIMIT_PER_MINUTE defaults to 0). So
throughput was capped at maxMessages(16) x 3 replicas = 48 concurrent Zyte fetches. The
HPA cannot relieve this: it scales on CPU (sitting at 15% of a 50% target) but the
workers are I/O-bound on Zyte, so CPU stays low and the HPA pins at its max of 3
replicas. Code change here: raise the flow-control cap default 16 -> 64, a 4x throughput
increase that stays well within the memory budget. This is a stopgap. The proper fix is
infra in webservices-infra: scale the worker HPA on Pub/Sub queue depth
(num_undelivered) instead of CPU and raise max replicas, since an I/O-bound worker never
drives CPU high enough to autoscale. Flagged for the human; not deployable from this repo.

## Dedup: re-check the freshness marker under the lock (TOCTOU) (2026-06-30)

Dev showed the same page crawled 12 times within one minute (article_discoveries had a
single url+surface with 12 rows, 12 distinct crawled_at, span 0 min). Root cause is a
check-then-act race in processDiscovery, and the same shape in processArticle: the
page:fetch (article:fetch) freshness gate is checked only before acquiring the lock and
the marker is written only after the crawl, so the whole crawl duration is a window in
which concurrent duplicate jobs all pass the pre-lock check, then serialize through the
SET NX lock one by one and each re-crawl. The lock gives mutual exclusion but not
deduplication, because the dedup signal is never re-read inside the critical section.
Fix: re-read the freshness marker immediately after acquiring the lock (double-checked
locking) so the first job crawls and sets the marker and the rest skip; releaseLock
still runs in finally on the early return. Applied to both workers (the article re-check
is non-live only, mirroring the pre-lock gate; live articles always resync). This cuts
redundant Zyte calls and BigQuery rows and reduces crawl-article backlog amplification,
since each duplicate discovery would otherwise re-enqueue the page's articles.

## Article worker memory: stop requesting the raw Zyte page body (2026-06-30)

The article worker OOM-spiked under burst load (peak ~475Mi in dev; reproduced ~1GB
RSS at 64 concurrent x 2MB responses) because each in-flight message held the full Zyte
response across up to flowControl.maxMessages (64) concurrent handlers. The memory is a
load-correlated spike, not a leak: it returns to ~125Mi baseline when idle and tracks
the ack rate. The dominant field was the raw page body: buildRequestBody set the
top-level httpResponseBody flag whenever extractFrom was httpResponseBody, on the wrong
belief that the flag was needed for HTTP-mode (non-browser) extraction. It is not:
articleOptions.extractFrom alone drives the HTTP fetch; the top-level flag only makes
Zyte also return the entire raw page HTML (base64), which we never read. A live curl
A/B confirmed it: the same request without the flag returns a byte-identical article and
omits the raw body, e.g. an apnews hub page dropped from 1.93MB to 1.4KB and a Wikipedia
article from 473KB to 136KB. Fix: do not set the top-level httpResponseBody flag;
request only extractFrom. This removes the multi-MB-per-response driver at the source
(no transfer, no parse), for both article and discovery calls, and keeps Guardian
working since extractFrom (not the flag) selects HTTP mode. maxMessages stays 64 so the
worker still auto-catches-up on backlogs. Chose not requesting the large field over
dropping it after parse (an earlier attempt) since not requesting also avoids the
transfer and the response.json parse spike.

## Dedup: claim the freshness marker before the work, plus three guardrails (2026-06-30)

The TOCTOU re-check (above) closed the concurrent-burst gap but not the sequential one:
the freshness marker was still written only after the Zyte call and the publish fan-out,
so any partial failure (a failed publish, ack-deadline expiry under load, or a crash
mid-handler) left no durable record and the redelivery re-ran Zyte and re-published,
looping until one delivery completed fault-free. Fix: move setTimestamp to a claim,
written inside the lock right after the in-lock re-check and before the Zyte call and
all publishes, in both processDiscovery and processArticle. A redelivery after a partial
failure now hits the freshness check and skips, so Zyte is not re-paid and the fan-out
is not re-emitted. The accepted tradeoff is the 99.9% target: a claim-then-fail drops
that one interval's update for that URL, which self-heals on the next scheduled crawl;
we rank repeated Zyte cost above rare, self-healing under-emission. A publish failure
still nacks, but the redelivery skips rather than republishing.

Live articles previously bypassed the article:fetch check so they resynced every agent
tick, which left them exposed to the same redelivery storm. Replaced the bypass with a
per-message refresh window: the agent and discovery worker now set
refresh_interval_minutes on each crawl-article message (the live interval and the
article fetch TTL respectively), and the worker gates and claims on that value for all
articles. Live articles now dedup on their own interval; the Corpus sync still runs
whenever the article is actually fetched, so curated metadata stays fresh on content,
title, or excerpt changes. The field is optional on the message and the worker falls
back to the configured fetch TTL, so a rolling deploy does not reject messages enqueued
before the field existed.

Three smaller reliability guardrails shipped in the same batch. (1) Capped
maxExtensionSeconds at the lock TTL (ackDeadlineSeconds - 30) with a fail-fast startup
assertion: a lease longer than the lock let a slow handler keep the message after its
lock had expired, so a redelivery could acquire the lock and run the same URL
concurrently. The default dropped from 570 to the lock TTL. (2) Added a 5s commandTimeout
and a bounded maxRetriesPerRequest on the Redis client so a slow or unresponsive Redis
fails the command fast (handler throws, message nacks, Pub/Sub redelivers) instead of
hanging the handler and starving throughput while holding the lease. (3) Added a reason
tag to the skipped message metric (recent for a fetch marker within the interval,
lock_busy for a held lock) so the dashboard can tell dedup skips from lock contention.

## Enable the Zyte rate limiter by default at 2500 RPM (2026-06-30)

The distributed Redis Zyte rate limiter was built (HNT-2441) but dormant:
zyteRateLimitPerMinute defaulted to 0, which makes main.ts skip wiring
beforeRequest and awaitZyteToken early-return, so no env had throttling unless
it set the var. Changed the default to 2500 RPM so the limiter is on
everywhere by default; the env var still overrides per env and 0 disables it.
Burst is left at 0 because awaitZyteToken falls back to the per-minute rate, so
the burst becomes 2500 automatically.

## Split the 2500 Zyte RPM per worker role (2026-06-30)

A single shared bucket caps the combined rate at 2500 but lets a burst on one
role consume the whole budget and starve the other. Split it instead: each role
runs its own Redis bucket (key zyte:rate-limit:{role}) with its own share, and
the two shares sum to the per-account 2500 limit, so the account total is still
respected while neither role starves. The shares are set in application config
(config.ts derives the default from WORKER_ROLE) rather than infra env vars, per
the preference to keep this in app config; ZYTE_RATE_LIMIT_PER_MINUTE still
overrides per env.

The split is article 2200 / discovery 300, from the measured request mix. The
Zyte Stats API (org 612928) is shared with the legacy crawler, whose ratio is
inverted (articleList dominates), so org-wide windows are misleading. Isolating
the new crawler by subtracting the pre-deploy baseline from the post-deploy
steady state gives about 7.6:1 article:articleList, which is structurally sane
(one page lists many articles, so article extraction dominates). 300 rounds the
discovery share up slightly over the ~289 estimate because the articleList delta
is the noisier signal. Re-measure once the crawler runs at full steady state for
a few days; cleaner isolation needs a distinct Zyte tag or apikey_label on the
worker requests (the workers currently send only extractFrom, no tags).

## Per-environment crawl scaling (2026-06-30)

The Zyte account allows 10,000 RPM and is shared with the legacy system during
shadow mode. Each environment crawls at a scale that fits its purpose, set as
deployment policy in the per-env Helm values (not app defaults) so the
environments stay independent.

- Prod crawls the full page list at ~6,000 RPM (article 5,300, discovery 700),
  leaving headroom on the 10,000 RPM account for legacy during shadow mode. The
  article-to-discovery split (~7.6:1) is the ratio of article to article-list
  extraction requests the Zyte stats API reported on 2026-06-30.
- Stage crawls 1% of pages (PUBLISHER_PAGE_LIMIT 34) at 1% of the prod rate
  (~60 RPM: article 53, discovery 7), a cheap end-to-end smoke of the same code
  path at the same load intensity per page.
- Dev does not crawl on a schedule. It is a sandbox where a developer wires a
  locally run service to real dev GCP resources, so a scheduled crawl from the
  deployed pods would only compete and add cost.

Dev is disabled by ENVIRONMENT rather than a separate flag (crawlEnabled =
ENVIRONMENT != 'dev'): the agent serves health checks but skips the tick loop,
and /healthz reports healthy without a tick so the pod does not crash-loop. A
developer enables crawling locally by setting ENVIRONMENT=local. Disabling only
the agent is sufficient because it is the sole origin of crawl jobs; the workers
stay reactive and idle with nothing to consume, and remain available to process
anything a developer publishes.

PUBLISHER_PAGE_LIMIT caps how many pages the agent crawls, applied after loading
and validating the full list. The sample is an even stride across the list (not
the first N) so a subset keeps publisher and language variety. 0 (default) means
no limit, so prod loads the whole list; stage sets 34. The full list stays the
committed source of truth.

The per-role Zyte rate is set per env via the ZYTE_RATE_LIMIT_PER_MINUTE
override; the app-config default (article 2200, discovery 300) is only a local
fallback. Re-measure the 7.6:1 split once the crawler runs at full steady state
for a few days; cleaner isolation needs a distinct Zyte tag or apikey_label on
the worker requests (they currently send only extractFrom, no tags).

## HNT-2682: split crawl-common into reusable packages

crawl-common had become a grab-bag of generic infrastructure clients and
crawl-domain logic. The generic, reusable clients moved into their own
workspace packages mirroring the existing sentry and metrics packages: pubsub
(the Pub/Sub consumer/publisher and its Sentry error handler), redis-state (the
ioredis state client: timestamps, locks, the token-bucket rate limiter), and
zyte (the Zyte extraction client). crawl-common keeps only what is specific to
the article-crawl domain: the BigQuery event and message types, the message
validators, the Corpus API client, the utils (normalize, domain,
deployed-defaults), and the Redis key builders.

The Redis split is the one non-obvious call. The ioredis wrapper in client.ts is
fully generic and moved to redis-state, but the key builders in keys.ts
(pageFetchKey, articleFetchKey, and the rest) encode the crawl keyspace, so they
stay in crawl-common. keys.ts never imported client.ts, so the split is clean:
no coupling had to be broken. The package is named redis-state rather than redis
because it wraps ioredis with state-oriented helpers rather than re-exporting the
driver. pubsub depends on @sentry/node directly (the error handler is generic to
any subscriber), not on the workspace sentry package, matching how crawl-common
referenced it before.

The crawl-common barrel no longer re-exports the moved modules. Per the
greenfield, pre-production stance every call site was updated to import directly
from the owning package instead of keeping a re-export shim, so the dependency
edges are explicit: crawl-agent depends on pubsub and redis-state (it makes no
Zyte calls); crawl-worker depends on all three. No new shared base config was
introduced because sentry and metrics already share the root tsconfig.json and
each carry a tiny per-package tsup and vitest config; the three new packages copy
that exact layout rather than diverge from it. The Dockerfile and turbo.json need
no change: turbo prune follows the workspace dependency graph and pulls the new
packages in automatically once the services declare them.

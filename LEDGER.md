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
maps to a New Tab scheduled surface as NEW_TAB_<LOCALE> (en_US to NEW_TAB_EN_US),
which is the surface id format the rest of the content system uses; all twelve
legacy locales have a matching surface. The topic is lowercased to match the
discovery context convention in publishers.example.json (the curated subtopic
label is otherwise kept verbatim, since the article_discoveries.topic column is
free text, the renamed page_subtopic). Entries are merged by URL so a page
crawled for several surfaces is one entry with several contexts, satisfying the
validator's unique-URL rule. interval_minutes defaults to 20 and live_articles
is empty (the legacy list has none; curated live articles arrive via the Corpus
API in Phase 5). The full generated publishers.json (about 3400 pages) is
gitignored rather than committed: it is large, regenerable, and churns on every
sheet re-export, and how the agent gets it at deploy time (baked image, mounted
config, or bucket fetch) is a human-gated shadow-mode decision. The committed
artifacts are the generator and publishers.example.json.

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

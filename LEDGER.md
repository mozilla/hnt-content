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

The lock TTL is derived from maxExtensionSeconds (the worker's real maximum
hold on a message) minus 30 seconds, not from the subscription's initial ack
deadline. The tech spec says "ack deadline - 30s", but the SDK extends the
lease up to maxExtensionSeconds, so a lock sized to the initial deadline could
expire well before the worker stops holding the message. Deriving from
maxExtensionSeconds keeps the lock alive for almost the whole hold and clears
it around when a crashed worker's message redelivers, rather than letting a
stale lock outlive the lease and block the legitimate retry.

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

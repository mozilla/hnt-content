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

Live articles have no discovery page, so their crawl-article job uses the
article's own URL as source_url. They share one configurable enqueue interval
(liveArticleIntervalMinutes) rather than a per-article interval, since the
publisher list does not carry one.

The publisher list is validated at startup via validatePublisherList in
crawl-common (reusing the message validators), so a malformed config fails
fast rather than enqueuing bad jobs.

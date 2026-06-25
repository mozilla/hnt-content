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

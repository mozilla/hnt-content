# Alerting

This document proposes the alerts that tell us when the crawler stops working.
None exist yet, and two need metrics we have yet to add
([HNT-3137](https://mozilla-hub.atlassian.net/browse/HNT-3137)). Once the alerts
are built, we will update this document to describe them.

[HNT-3671](https://mozilla-hub.atlassian.net/browse/HNT-3671) will decide how
the alerts are built, delivered and tested. This document will cover it then.

## Approach

- Alerts watch symptoms, not causes such as pod restarts, CPU or Redis memory.
- Every alert catches at least one outage no other alert catches.
  Some outages unavoidably fire more than one alert.

Partial outages, such as one publisher or locale failing, and quality issues,
such as empty article bodies, are out of scope for now. The dashboard may show
these problems instead.

## The alerts

| Alert | Fires when | Signal |
|---|---|---|
| No New Discoveries | No messages on `article-discoveries` for 60 minutes[^gap] | Messages published ([`topic/message_sizes`](https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z#pubsub/topic/message_sizes)) |
| No New Extractions | No messages on `articles` for 60 minutes[^gap] | Messages published ([`topic/message_sizes`](https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z#pubsub/topic/message_sizes)) |
| BigQuery Writes Failing | A `*-to-bq` message unacked for 60 minutes | [`oldest_unacked_message_age`](https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z#pubsub/subscription/oldest_unacked_message_age) |
| Zyte Spend Surge | The last hour's billable requests exceed 3x[^spend] the 7-day average for that hour | `zyte_requests` counter |
| Workers Falling Behind | Jobs wait over 20 minutes[^cycle] to be picked up (p90, last hour) | `crawl_job_queue_wait_seconds` histogram |
| New Sentry Issue | A new kind of error | Sentry |

### No New Discoveries and No New Extractions

The article worker extracts two kinds of articles: those found by discovery,
and live articles, which the scheduler enqueues directly. When discovery stops,
No New Discoveries fires, but live articles may keep No New Extractions
quiet. When No New Extractions fires on its own, extraction itself is broken.

### BigQuery Writes Failing

If a message does not fit the table schema, for example a field of the wrong
type, BigQuery rejects it and Pub/Sub keeps redelivering it. If the subscription
cannot write at all, for example because the table was deleted or Pub/Sub lost
its write permission, every message stays queued. Either way the oldest unacked
message keeps getting older, which is what this alert watches. Without it, those
rows would be lost silently when Pub/Sub drops them after seven days. A
dead-letter topic would not replace the alert, because it only catches messages
rejected one at a time.

### Workers Falling Behind

This alert only counts a job's first delivery, so retries of failing jobs do not
trigger it. When no jobs run at all, it records nothing, and No New Discoveries
and No New Extractions fire instead.

## Which alert catches which outage

The first group lists real outages of the legacy pipeline in 2026, linked to
where they were reported. The second lists failures that could happen in the
new design.

| Outage | No New<br>Discoveries | No New<br>Extractions | BigQuery<br>Writes Failing | Zyte Spend<br>Surge | Workers<br>Falling Behind | New Sentry<br>Issue | Other monitoring |
|---|:---:|:---:|:---:|:---:|:---:|:---:|---|
| **Legacy pipeline, 2026** | | | | | | | |
| Crawler hung for 11 hours ([Oct 8](https://mozilla.slack.com/archives/C06PX8YFQBZ/p1791448229636159)) | 🔵 |  |  |  |  |  |  |
| Crawler ran out of memory ([Feb 19](https://mozilla-hub.atlassian.net/browse/HNT-1776), [Mar 24](https://mozilla-hub.atlassian.net/browse/HNT-2071)) | 🔵 |  |  |  |  |  |  |
| Zyte outage ([Feb 12](https://status.zyte.com/incidents/czp1lfm6z0bn)) | 🔵 | 🔵 |  |  |  |  |  |
| Zyte blocked The Guardian for five weeks ([Apr to Jun](https://mozilla.slack.com/archives/C09PBCCN0M6/p1780540369518059)) |  |  |  |  |  |  | Dashboard |
| ML sections stuck for four days ([Sep](https://mozilla-hub.atlassian.net/browse/HNT-3360)) |  |  |  |  |  |  | ML pipeline |
| **New design** | | | | | | | |
| Scheduler stops enqueuing | 🔵 | 🔵 |  |  |  |  |  |
| BigQuery rejects rows |  |  | 🔵 |  |  |  |  |
| Zyte API key revoked | 🔵 | 🔵 |  |  |  | 🔵 |  |
| Corpus API key revoked |  |  |  |  |  | 🔵 |  |
| Runaway Zyte calls |  |  |  | 🔵 |  |  |  |
| Workers fall behind |  |  |  |  | 🔵 |  |  |
| Zyte fails on many publishers |  |  |  |  |  |  | Dashboard |

[^gap]: The pipeline is expected to continuously discover and crawl articles,
    so an hour gap points to a failure. The longest gap in the legacy pipeline
    was 18 minutes, as measured during 7 days in October.

[^spend]: Legacy Zyte volume stayed within 1.3x of this average in 99% of hours
    from July to October. A runaway, such as re-extracting every article on
    every crawl, would far exceed 3x.

[^cycle]: Each publisher page is crawled every 20 minutes, so a longer wait
    means work is piling up.

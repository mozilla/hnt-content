# Crawler Runbook

Use this page when a crawler alert fires. For how the crawler works, see
[ARCHITECTURE.md](ARCHITECTURE.md). To declare an incident, follow the
[Mozilla incident process](https://mozilla-hub.atlassian.net/wiki/spaces/MIR/pages/2790621273).

When the crawler fails, New Tab keeps serving the stories it has, which grow
stale.

## First five minutes

1. Open the
   [crawler dashboard](https://yardstick.mozilla.org/d/mm29b84/hnt-crawler?from=now-6h&to=now&timezone=browser&var-env=prod&var-metrics_scope=adpvtjmrxoc1sb)
   to see which alerts fire, which metrics spike, and since when.
2. Message `@hnt-editors` in
   [#hnt-editorial](https://mozilla.enterprise.slack.com/archives/C05MVUFF4CW)
   to get support from the HNT editorial team.
3. Look for spikes in
   [Sentry errors](https://mozilla.sentry.io/issues/?environment=prod&groupStatsPeriod=auto&project=4511425365344256&query=is%3Aunresolved%20environment%3Aprod&referrer=issue-list&sort=freq&statsPeriod=7d).
   In a spiking error, open **View all tags and feature flags**: tags such as
   `server_name` and `domain` help narrow down the cause.
4. Check the [recent merges](https://github.com/mozilla/hnt-content/commits/main).
   Merging to `main` deploys to prod automatically. If the outage started right
   after a deploy, consider [rolling back](#roll-back-a-deploy).
5. Open the
   [prod Argo CD app](https://webservices.argocd.global.mozgcp.net/applications/argocd-webservices/hnt-prod-us-west1-hnt)
   and check for any signs of unhealthy pods.
6. Follow the steps for the firing alert under [Alerts](#alerts).

## Quick reference

**Code**

- [hnt-content](https://github.com/mozilla/hnt-content), the crawler
  application.
- [webservices-infra](https://github.com/mozilla/webservices-infra/tree/main/hnt),
  the Kubernetes values and Terraform for Pub/Sub, Redis, BigQuery and secrets.
- The `hnt`
  [tenant](https://github.com/mozilla/global-platform-admin/blob/main/tenants/hnt.yaml)
  and
  [workgroup](https://github.com/mozilla/global-platform-admin/blob/main/google-workspace-management/tf/workgroups/hnt.yaml)
  in global-platform-admin.

**Prod**

- Workloads run in namespace `hnt-prod` on cluster
  [webservices-high-prod](https://console.cloud.google.com/kubernetes/clusters/details/us-west1/webservices-high-prod/details?project=moz-fx-webservices-high-prod).
  Pub/Sub, Redis and BigQuery live in project
  [moz-fx-hnt-prod](https://console.cloud.google.com/home/dashboard?project=moz-fx-hnt-prod).
- [Argo CD app](https://webservices.argocd.global.mozgcp.net/applications/argocd-webservices/hnt-prod-us-west1-hnt)
- [Crawler dashboard](https://yardstick.mozilla.org/d/mm29b84/hnt-crawler?from=now-6h&to=now&timezone=browser&var-env=prod&var-metrics_scope=adpvtjmrxoc1sb)
- [Sentry](https://mozilla.sentry.io/issues/?environment=prod&groupStatsPeriod=auto&project=4511425365344256&query=is%3Aunresolved%20environment%3Aprod&referrer=issue-list&sort=freq&statsPeriod=7d)
- [Pub/Sub subscriptions](https://console.cloud.google.com/cloudpubsub/subscription/list?project=moz-fx-hnt-prod)
- [Redis](https://console.cloud.google.com/memorystore/redis/locations/us-west1/instances/hnt-prod-prod/details/monitoring?project=moz-fx-hnt-prod)
- [BigQuery](https://console.cloud.google.com/bigquery?project=moz-fx-hnt-prod)

**Queues and topics**

Every subscription keeps messages for 7 days.

- Job queues: [prod-crawl-article-discovery](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-crawl-article-discovery?project=moz-fx-hnt-prod) and
  [prod-crawl-article](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-crawl-article?project=moz-fx-hnt-prod).
- Dead-letter queues, for jobs that fail 5 times:
  [prod-crawl-article-discovery-dead-letter](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-crawl-article-discovery-dead-letter?project=moz-fx-hnt-prod)
  and
  [prod-crawl-article-dead-letter](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-crawl-article-dead-letter?project=moz-fx-hnt-prod).
- Event topics: [prod-article-discoveries](https://console.cloud.google.com/cloudpubsub/topic/detail/prod-article-discoveries?project=moz-fx-hnt-prod) and
  [prod-articles](https://console.cloud.google.com/cloudpubsub/topic/detail/prod-articles?project=moz-fx-hnt-prod).
- BigQuery subscriptions: [prod-article-discoveries-to-bq](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-article-discoveries-to-bq?project=moz-fx-hnt-prod)
  and
  [prod-articles-to-bq](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-articles-to-bq?project=moz-fx-hnt-prod).

**Dev and stage**

- Workloads run in namespaces `hnt-dev` and `hnt-stage` on cluster
  [webservices-high-nonprod](https://console.cloud.google.com/kubernetes/clusters/details/us-west1/webservices-high-nonprod/details?project=moz-fx-webservices-high-nonpro).
  Their resources live in project
  [moz-fx-hnt-nonprod](https://console.cloud.google.com/home/dashboard?project=moz-fx-hnt-nonprod).
- Argo CD apps for
  [dev](https://webservices.argocd.global.mozgcp.net/applications/argocd-webservices/hnt-dev-us-west1-hnt)
  and
  [stage](https://webservices.argocd.global.mozgcp.net/applications/argocd-webservices/hnt-stage-us-west1-hnt).

## Alerts

Grafana posts alerts to
[#hnt-dev-be-alerts](https://mozilla.enterprise.slack.com/archives/C05NFB32W93)
and links each one to its section below.

### No New Discoveries

This alert triggers if nothing is published to `article-discoveries` for 60
minutes, so no publisher page is being crawled.

Is [No New Extractions](#no-new-extractions) also firing?

- **Yes:** the whole pipeline has stopped. Narrow down the cause:
  1. Check in Argo CD or with [kubectl](#get-access-and-inspect-pods) that
     `crawl-scheduler` is running and logs `tick … pages=N` every minute.
  2. Check
     [Redis](https://console.cloud.google.com/memorystore/redis/locations/us-west1/instances/hnt-prod-prod/details/monitoring?project=moz-fx-hnt-prod).
     Every job needs Redis, so a Redis outage stops everything.
  3. Check [Zyte Status](https://status.zyte.com) and
     [Zyte errors](https://app.zyte.com/o/612928/stats/usage?statusCodes=400,403,421,422,429,451,500,503,520,521).
- **No:** live articles still go from the scheduler through the article worker,
  so only page crawls have stopped. Narrow down the cause:
  1. Check whether a spiking Sentry error has a `server_name` tag starting
     with `crawl-discovery-worker`.
  2. Check in Argo CD or with [kubectl](#get-access-and-inspect-pods) that
     `crawl-scheduler` logs `pages=N` with N above zero.

To mitigate:

- **If a deploy caused it:** [roll back](#roll-back-a-deploy).
- **If a workload is stuck or crashing:** [restart](#restart-a-deployment) it.
- **If Zyte is down or errors spike across domains:**
  [contact Zyte](#contact-zyte).

### No New Extractions

This alert triggers if nothing is published to `articles` for 60 minutes, so
no article is being extracted.

Is [No New Discoveries](#no-new-discoveries) also firing?

- **Yes:** the whole pipeline has stopped; follow
  [No New Discoveries](#no-new-discoveries).
- **No:** pages are crawled, but no article is extracted. This also stops live
  articles, so curated New Tab headlines are no longer corrected. Narrow down
  the cause:
  1. Is [Workers Falling Behind](#workers-falling-behind) also firing? If so,
     the worker is not consuming jobs; follow that alert.
  2. Check whether a spiking Sentry error has a `server_name` tag starting
     with `crawl-article-worker`. Its `has_corpus_item` tag is `true` for live
     articles and `false` for newly discovered ones.
  3. Check [Zyte errors](https://app.zyte.com/o/612928/stats/usage?statusCodes=400,403,421,422,429,451,500,503,520,521)
     for article extractions.
  4. Sentry provides the best error observability, but it could be worth
     reading the `crawl-article-worker` logs directly with
     [kubectl](#get-access-and-inspect-pods).

To mitigate:

- **If a deploy caused it:** [roll back](#roll-back-a-deploy).
- **If the worker is stuck or crashing:** [restart](#restart-a-deployment)
  `crawl-article-worker`.
- **If Zyte errors spike across domains:** [contact Zyte](#contact-zyte).
- **If only live articles fail with `CorpusApiError`:** follow the
  [Curated Corpus API runbook](https://mozilla-hub.atlassian.net/wiki/spaces/FPS/pages/390684792/Curated+Corpus+API+Availability+Runbook).

### Workers Falling Behind

This alert triggers if, over the last hour, 10% of jobs waited more than 20
minutes for their first delivery.

Narrow down the cause:

1. Check which backlog grows:
   [prod-crawl-article](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-crawl-article?project=moz-fx-hnt-prod)
   or
   [prod-crawl-article-discovery](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-crawl-article-discovery?project=moz-fx-hnt-prod).
2. Check whether
   [prod-crawl-article-dead-letter](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-crawl-article-dead-letter?project=moz-fx-hnt-prod)
   or
   [prod-crawl-article-discovery-dead-letter](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-crawl-article-discovery-dead-letter?project=moz-fx-hnt-prod)
   grows. Jobs only reach these when the worker fails before it starts the
   extraction, so a sharp rise usually means Redis errors; check
   [Redis](https://console.cloud.google.com/memorystore/redis/locations/us-west1/instances/hnt-prod-prod/details/monitoring?project=moz-fx-hnt-prod) and [Sentry](https://mozilla.sentry.io/issues/?environment=prod&groupStatsPeriod=auto&project=4511425365344256&query=is%3Aunresolved%20environment%3Aprod&referrer=issue-list&sort=freq&statsPeriod=7d).
3. Check for restarts or pods that started minutes ago, in
   [Argo CD](https://webservices.argocd.global.mozgcp.net/applications/argocd-webservices/hnt-prod-us-west1-hnt?view=pods)
   or with [kubectl](#get-access-and-inspect-pods). A restarting pod's jobs
   wait until Pub/Sub redelivers them.
4. Check whether jobs fail: look for a spiking error in
   [Sentry](https://mozilla.sentry.io/issues/?environment=prod&groupStatsPeriod=auto&project=4511425365344256&query=is%3Aunresolved%20environment%3Aprod&referrer=issue-list&sort=freq&statsPeriod=7d)
   and in
   [Zyte errors](https://app.zyte.com/o/612928/stats/usage?statusCodes=400,403,421,422,429,451,500,503,520,521).
5. Check the workers' CPU with `kubectl -n hnt-prod top pods`. Autoscaling
   adds pods once CPU passes 125m, half of each worker's 250m request.

To mitigate:

- **If jobs fail:** do not add workers, because more workers only fail faster
  and add Zyte throttling. [Roll back](#roll-back-a-deploy) if a deploy caused
  it, or [contact Zyte](#contact-zyte) if Zyte errors spike across domains.
- **If pods restart:** follow
  [Container Memory Near Limit](#container-memory-near-limit).
- **If jobs succeed, but workers stay below 125m CPU:** pods are mostly waiting
  on Zyte, so autoscaling does not add more. Raise `replicas.min` in
  [values-prod.yaml](https://github.com/mozilla/webservices-infra/blob/main/hnt/k8s/hnt/values-prod.yaml),
  or raise `maxMessages`, the number of jobs each pod handles at once, in
  [config.ts](../../services/crawl-worker/src/config.ts). A higher `maxMessages`
  holds more responses in memory; see [Container Memory Near
  Limit](#container-memory-near-limit).
- **If jobs succeed, and workers are above 125m CPU at `replicas.max`:** raise
  `replicas.max` in
  [values-prod.yaml](https://github.com/mozilla/webservices-infra/blob/main/hnt/k8s/hnt/values-prod.yaml).

### BigQuery Writes Failing

This alert triggers if a message on a BigQuery subscription stays unacked for
60 minutes, so rows are not reaching BigQuery.

Narrow down the cause: open
[prod-articles-to-bq](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-articles-to-bq?project=moz-fx-hnt-prod)
or
[prod-article-discoveries-to-bq](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-article-discoveries-to-bq?project=moz-fx-hnt-prod)
and read the error. A schema error means an event field no longer matches its
column's type, usually after a deploy that changed an event. A permission or
table error usually follows a recent change in
[webservices-infra](https://github.com/mozilla/webservices-infra/commits/main/hnt/tf).

To mitigate:

- **If it is a schema error:** [roll back](#roll-back-a-deploy), or fix the
  column.
- **If it is a permission or table error:** revert the webservices-infra change.

Pub/Sub keeps the messages for 7 days, and they land once the cause is fixed.
After 7 days they are lost. Once fixed, check that the
[latest rows in BigQuery](#inspect-the-latest-rows-in-bigquery) are recent and
have their fields filled.

### Zyte Spend Surge

This alert triggers if the last hour's billable Zyte requests on the
crawler's production API key exceed three times the 7-day average for that
hour.

Narrow down the cause:

1. Check [Zyte usage](https://app.zyte.com/o/612928/stats/usage), filtered
   to the crawler's production API key, for page crawls versus article
   extractions.
2. Check recent changes to
   [publishers.json](https://github.com/mozilla/hnt-content/commits/main/services/crawl-scheduler/src/data/publishers.json).
   A new market raises extractions for a few hours, which is expected.
3. Check whether
   [Redis](https://console.cloud.google.com/memorystore/redis/locations/us-west1/instances/hnt-prod-prod/details/monitoring?project=moz-fx-hnt-prod)
   was recently emptied or is full. Workers then re-extract articles they
   already have.

To mitigate:

- **If Redis is full:** follow
  [Redis Memory Near Limit](#redis-memory-near-limit).
- **If the cause is unclear and spend keeps rising:**
  [pause the crawler](#pause-the-crawler).

### Container Memory Near Limit

This alert triggers if a crawl container reached 90% of its 256 MiB limit in
the last 60 minutes. The container is killed at 100%, and
[kubectl](#get-access-and-inspect-pods) then shows `OOMKilled` for its pod.

Narrow down the cause: check on the
[crawler dashboard](https://yardstick.mozilla.org/d/mm29b84/hnt-crawler?from=now-6h&to=now&timezone=browser&var-env=prod&var-metrics_scope=adpvtjmrxoc1sb)
whether memory climbs steadily or rises and falls with load.

To mitigate:

- **If memory climbs steadily:** this is a leak.
  [Restart](#restart-a-deployment) the deployment to buy time, and fix the leak.
- **If memory rises with load:** raise the limit in
  [values.yaml](https://github.com/mozilla/webservices-infra/blob/main/hnt/k8s/hnt/values.yaml).

### Redis Memory Near Limit

This alert triggers if
[Redis](https://console.cloud.google.com/memorystore/redis/locations/us-west1/instances/hnt-prod-prod/details/monitoring?project=moz-fx-hnt-prod)
is more than 80% full. A full Redis evicts deduplication keys, so workers
re-extract articles and Zyte cost rises.

To mitigate, raise `memory_size_gb` in the
[Redis module](https://github.com/mozilla/webservices-infra/tree/main/hnt/tf/modules/redis).
Scaling keeps the data, but connections reset briefly while Redis fails over
to its replica; see
[scaling instances](https://docs.cloud.google.com/memorystore/docs/redis/about-scaling-instances).

### New Sentry Issue

This alert triggers on a new kind of error in
[Sentry](https://mozilla.sentry.io/issues/?environment=prod&groupStatsPeriod=auto&project=4511425365344256&query=is%3Aunresolved%20environment%3Aprod&referrer=issue-list&sort=freq&statsPeriod=7d).

Narrow down the cause with the issue's tags:

- `domain` shows whether one publisher or many are affected.
- `has_corpus_item:true` means live articles.

To mitigate:

- **If it is a `CorpusApiError`:** follow the
  [Curated Corpus API runbook](https://mozilla-hub.atlassian.net/wiki/spaces/FPS/pages/390684792/Curated+Corpus+API+Availability+Runbook).
- **If it is a `ZyteError` across many domains:** [contact Zyte](#contact-zyte).

## Actions

### Restart a deployment

In the
[prod Argo CD app](https://webservices.argocd.global.mozgcp.net/applications/argocd-webservices/hnt-prod-us-west1-hnt),
open the deployment and choose **Restart**. Unfinished jobs are redelivered.

### Roll back a deploy

Revert the pull request on `main`, then watch the
[prod Argo CD app](https://webservices.argocd.global.mozgcp.net/applications/argocd-webservices/hnt-prod-us-west1-hnt)
until it is synced and healthy.

### Pause the crawler

Set `replicas: 0` under `crawl-scheduler` in
[values-prod.yaml](https://github.com/mozilla/webservices-infra/blob/main/hnt/k8s/hnt/values-prod.yaml)
and merge. The workers then finish the queued jobs.

### Contact Zyte

1. [Create a ticket](https://support.zyte.com/support/tickets/new) with a
   priority that matches the impact. Include the URLs, the request payload and
   the rendering method (browser or no-JS).
2. Reach our customer success manager in the
   [Zyte Slack workspace](https://zytegroup.slack.com/archives/C0AA7HE9R1U).

### Skip queued jobs

To drop a backlog or bad jobs, seek the subscription to a time. Pub/Sub then
acknowledges every job published before that time, and workers continue with
newer jobs. This needs Pub/Sub access in prod, so first request a grant in
[PAM](https://console.cloud.google.com/iam-admin/pam/entitlements/my?project=moz-fx-hnt-prod).

```sh
gcloud pubsub subscriptions seek prod-crawl-article \
  --project moz-fx-hnt-prod --time=2026-01-01T12:00:00Z
```

Use `prod-crawl-article-discovery` for page jobs. Both queues are safe to
skip, because later crawls queue the articles again while they are still
featured. See
[seeking to a timestamp](https://cloud.google.com/pubsub/docs/replay-overview#seek_to_a_time).

### Replay dead-lettered jobs

Jobs that fail 5 times go to
[prod-crawl-article-dead-letter](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-crawl-article-dead-letter?project=moz-fx-hnt-prod)
or
[prod-crawl-article-discovery-dead-letter](https://console.cloud.google.com/cloudpubsub/subscription/detail/prod-crawl-article-discovery-dead-letter?project=moz-fx-hnt-prod),
where they expire after 7 days.

Page jobs never need replaying, because every page is crawled again on its
next interval. Missing a few hours of articles usually does not justify a
replay either, but ask the editorial team. We have no replay tool, so a replay
means writing a script that reads `prod-crawl-article-dead-letter` with
`gcloud pubsub subscriptions pull` and republishes each message's data to
`prod-crawl-article` with `gcloud pubsub topics publish`.

## Inspect the latest rows in BigQuery

The Sections Flow reads the crawl tables, so their latest rows show what it
receives. Run these in the
[BigQuery console](https://console.cloud.google.com/bigquery?project=moz-fx-hnt-prod).

The latest discoveries:

```sql
SELECT *
FROM `moz-fx-hnt-prod.crawl.article_discoveries`
WHERE crawled_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
ORDER BY crawled_at DESC
LIMIT 10
```

The latest extracted articles:

```sql
SELECT *
FROM `moz-fx-hnt-prod.crawl.articles`
WHERE extracted_at > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 DAY)
ORDER BY extracted_at DESC
LIMIT 10
```

## Get access and inspect pods

### Inspect pods with kubectl

Prod runs in namespace `hnt-prod` on the `webservices-high-prod` cluster. Add
the cluster to your `kubectl` config once:

```sh
gcloud container clusters get-credentials webservices-high-prod --region us-west1 --project moz-fx-webservices-high-prod --dns-endpoint
```

List the crawler pods with their restart counts:

```sh
kubectl -n hnt-prod get pods
```

Read a workload's recent logs, here the article worker:

```sh
kubectl -n hnt-prod logs deploy/crawl-article-worker --tail=200
```

See why the pods last restarted, such as `OOMKilled`, under Last State:

```sh
kubectl -n hnt-prod describe pods
```

### Prod access

The `hnt` developers group can use `kubectl` and read logs in prod without a
JIT grant, and can restart deployments in the
[prod Argo CD app](https://webservices.argocd.global.mozgcp.net/applications/argocd-webservices/hnt-prod-us-west1-hnt).
Skipping or replaying jobs needs Pub/Sub roles, which only a JIT grant gives.

For more access, request a temporary grant in
[PAM](https://console.cloud.google.com/iam-admin/pam/entitlements/my?project=moz-fx-hnt-prod),
or run `mzcld jit elevate "<reason>"`. A grant lasts up to 4 hours. See the
[JIT user guide](https://mozilla-hub.atlassian.net/wiki/spaces/SRE/pages/1373143084/Just-In-Time+Access+User+Guide).

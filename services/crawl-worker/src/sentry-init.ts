import { initSentry } from 'crawl-common';

// TODO(HNT-2113): the article and discovery workers run from the
// same image. Once the Pub/Sub consumer call site lands and pods
// know their role, source worker_role from a per-pod env var.
// Until then both pods share this hardcoded tag value.
initSentry({ service: 'crawl-worker', workerRole: 'article' });

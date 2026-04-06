# Migrations

One-off BigQuery backfill scripts that populate the new `crawl` dataset
from legacy tables. Run manually in BigQuery Console.

## Prerequisites

- BigQuery Data Viewer on `moz-fx-mozsoc-ml-prod.prod_articles` and
  `moz-fx-mozsoc-ml-prod.prod_rss_news`

## How to run

Each script has a `target_dataset` variable at the top:

| Environment | `target_dataset` | Project |
|-------------|------------------|---------|
| prod | `crawl` | `moz-fx-hnt-prod` |
| dev | `crawl_dev` | `moz-fx-hnt-nonprod` |
| stage | `crawl_stage` | `moz-fx-hnt-nonprod` |

Non-prod datasets automatically get a 30-day date filter.

1. Open BigQuery Console and select the target project.
2. Run `001_backfill_articles.sql`.
3. Run `002_backfill_article_discoveries.sql`.
4. Verify row counts (see below).

## Verification

```sql
-- articles: expect ~16.9M rows (prod) as of 2026-04-06
SELECT COUNT(*) FROM `crawl.articles`
WHERE extracted_at >= '2024-01-01';

-- article_discoveries: expect ~3.2M rows (prod) as of 2026-04-06
SELECT COUNT(*) FROM `crawl.article_discoveries`
WHERE crawled_at >= '2025-08-01';
```

## Key decisions

| Topic | Decision |
|-------|----------|
| Duplicates | Copied as-is; matches at-least-once delivery model |
| `zyte_cached_at` timezone | UTC (confirmed) |
| `zyte_datePublished = '2000-01-01'` | Mapped to NULL (sentinel for unparseable) |
| `zyte_authors` | Treated as single author string (commas are credentials, not separators) |
| `surface` to `surface_id` | `CONCAT('NEW_TAB_', UPPER(surface))` |
| `rss_feed_items` filter | `source = 'PAGE'` only (PAGE crawling started 2025-08-11) |
| Environments | Prod gets full data; dev/stage get last 30 days |

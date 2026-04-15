-- Backfill crawl.article_discoveries from legacy rss_feed_items table.
--
-- Run once per environment in BigQuery Console. Change the dataset
-- name in the INSERT target to match the environment:
--   prod:  crawl.article_discoveries           (project: moz-fx-hnt-prod)
--   dev:   crawl_dev.article_discoveries       (project: moz-fx-hnt-nonprod)
--   stage: crawl_stage.article_discoveries     (project: moz-fx-hnt-nonprod)
--
-- Only source = 'PAGE' rows are migrated (PAGE crawling started
-- 2025-08-11; there is no older PAGE data).

INSERT INTO `crawl.article_discoveries` (
  url,
  crawled_at,
  source_url,
  published_at,
  headline,
  authors,
  summary,
  language,
  topic,
  page_position,
  surface_id
)
SELECT
  canonical_url AS url,
  crawled_at,
  origin_url AS source_url,
  published_at,
  title AS headline,

  CASE
    WHEN author IS NOT NULL AND author != ''
    THEN ARRAY(SELECT AS STRUCT author AS name)
    ELSE []
  END AS authors,

  summary,
  language,
  page_subtopic AS topic,
  page_position,
  -- surface values like 'en_us' become 'NEW_TAB_EN_US' to match
  -- the Corpus API ScheduledSurfaceGUID format.
  CONCAT('NEW_TAB_', UPPER(surface)) AS surface_id

-- Duplicates are copied as-is; matches the at-least-once delivery
-- model of the new pipeline.
FROM `moz-fx-mozsoc-ml-prod.prod_rss_news.rss_feed_items`
WHERE source = 'PAGE'
;

-- Backfill crawl.article_discoveries from legacy rss_feed_items table.
--
-- Set target_dataset below:
--   prod:  'crawl'
--   dev:   'crawl_dev'
--   stage: 'crawl_stage'
--
-- Only source = 'PAGE' rows are migrated (PAGE crawling started
-- 2025-08-11; there is no older PAGE data). Non-prod datasets
-- automatically get a 30-day filter.

DECLARE target_dataset STRING DEFAULT 'crawl';

DECLARE cutoff TIMESTAMP DEFAULT IF(
  target_dataset = 'crawl',
  TIMESTAMP('2000-01-01'),
  TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
);

EXECUTE IMMEDIATE FORMAT("""
  INSERT INTO `%s.article_discoveries` (
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
    CONCAT('NEW_TAB_', UPPER(surface)) AS surface_id

  FROM `moz-fx-mozsoc-ml-prod.prod_rss_news.rss_feed_items`
  WHERE source = 'PAGE'
    AND crawled_at >= @cutoff
""", target_dataset)
USING cutoff AS cutoff;

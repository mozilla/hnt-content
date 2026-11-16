-- Gap backfill of crawl.article_discoveries from the legacy
-- rss_feed_items table (prod).
--
-- 002_backfill_article_discoveries.sql ran on 2026-11-04 (latest crawled_at
-- 20:03:12.323 UTC) and the new crawler wrote its first row at
-- 2026-11-10 20:16:10.754 UTC (12:16:10 PT, after the 12:12 PT deploy).
-- This copies only legacy PAGE rows strictly between those two times, so it
-- neither duplicates the old backfill nor overlaps the new crawler.
-- The NOT EXISTS guard makes a rerun a no-op. Unlike 002, exact duplicate
-- legacy rows (about 11% of the gap) are copied once. Same mapping as 002.

-- last row of 002
DECLARE gap_start TIMESTAMP DEFAULT TIMESTAMP '2026-11-04 20:03:12.323';
-- first new-crawler row (12:16:10 PT)
DECLARE gap_end TIMESTAMP DEFAULT TIMESTAMP '2026-11-10 20:16:10.754';

INSERT INTO `moz-fx-hnt-prod.crawl.article_discoveries` (
  url, crawled_at, source_url, published_at, headline, authors,
  summary, language, topic, page_position, surface_id
)
SELECT
  r.canonical_url AS url,
  r.crawled_at,
  r.origin_url AS source_url,
  r.published_at,
  r.title AS headline,
  CASE
    WHEN r.author IS NOT NULL AND r.author != ''
    THEN ARRAY(SELECT AS STRUCT r.author AS name)
    ELSE []
  END AS authors,
  r.summary,
  r.language,
  r.page_subtopic AS topic,
  r.page_position,
  CONCAT('NEW_TAB_', UPPER(r.surface)) AS surface_id
FROM `moz-fx-mozsoc-ml-prod.prod_rss_news.rss_feed_items` AS r
WHERE r.source = 'PAGE'
  AND r.crawled_at > gap_start
  AND r.crawled_at < gap_end
  AND NOT EXISTS (
    SELECT 1
    FROM `moz-fx-hnt-prod.crawl.article_discoveries` AS d
    WHERE d.crawled_at BETWEEN gap_start AND gap_end  -- partition filter
      AND d.url = r.canonical_url
      AND d.crawled_at = r.crawled_at
      AND d.source_url = r.origin_url
      AND d.topic IS NOT DISTINCT FROM r.page_subtopic
      AND d.surface_id = CONCAT('NEW_TAB_', UPPER(r.surface))
  )
-- The legacy crawler sometimes wrote the same discovery twice.
QUALIFY ROW_NUMBER() OVER (
  PARTITION BY
    r.canonical_url, r.crawled_at, r.origin_url, r.page_subtopic, r.surface
  ORDER BY r.page_position
) = 1;

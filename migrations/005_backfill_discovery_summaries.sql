-- Backfill crawl.article_discoveries.summary on new-crawler rows from the
-- legacy rss_feed_items table (prod).
--
-- Until HNT-4107 the new crawler mapped summary from the articleList item's
-- description, a field Zyte's articleList items don't have, so every row it
-- wrote has a NULL summary. The legacy crawler stored that item's articleBody, as the fixed
-- crawler now does. This copies the legacy summary for the same URL and
-- surface onto those rows.
--
-- Run once in prod, while the legacy crawler still writes rss_feed_items.
-- Set fix_deployed_at to when the fix was deployed, and run this at least
-- 30 minutes after the deploy: BigQuery can't update rows streamed in the
-- last 30 minutes, and fails without changes if you run it too early.
--
-- It recovers about three quarters of the summaries a fixed crawler would
-- have written: on 2026-11-12, legacy had a summary for 74,503 of 312,634
-- distinct new-crawler URLs, and about 33% of articleList items carry an
-- articleBody. The rest stay NULL. Rerunning is safe: rows that already
-- have a summary are skipped.

-- first new-crawler row (12:16:10 PT)
DECLARE cutover TIMESTAMP DEFAULT TIMESTAMP '2026-11-10 20:16:10.754';
-- Set to the HNT-4107 deploy time (UTC) before running.
DECLARE fix_deployed_at TIMESTAMP DEFAULT NULL;

ASSERT fix_deployed_at IS NOT NULL AS 'Set fix_deployed_at first';

UPDATE `moz-fx-hnt-prod.crawl.article_discoveries` AS d
SET summary = r.summary
FROM (
  -- Legacy has a row per topic, so several summaries can exist per URL and
  -- surface. Take the latest; break crawled_at ties on the summary itself.
  SELECT
    -- Some publishers add a fragment that changes on every page load.
    SPLIT(canonical_url, '#')[OFFSET(0)] AS url,
    CONCAT('NEW_TAB_', UPPER(surface)) AS surface_id,
    ARRAY_AGG(summary ORDER BY crawled_at DESC, summary LIMIT 1)[OFFSET(0)]
      AS summary
  FROM `moz-fx-mozsoc-ml-prod.prod_rss_news.rss_feed_items`
  WHERE source = 'PAGE'
    AND summary IS NOT NULL
    AND summary != ''
  GROUP BY url, surface_id
) AS r
WHERE d.crawled_at >= cutover  -- partition filter
  AND d.crawled_at < fix_deployed_at
  AND d.summary IS NULL
  AND SPLIT(d.url, '#')[OFFSET(0)] = r.url
  AND d.surface_id = r.surface_id;

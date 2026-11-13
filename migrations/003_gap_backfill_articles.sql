-- Gap backfill of crawl.articles from the legacy zyte_cache table (prod).
--
-- 001_backfill_articles.sql ran on 2026-11-04 (latest extracted_at
-- 20:09:55.842574 UTC) and the new crawler wrote its first row at
-- 2026-11-10 20:16:20.860 UTC (12:16:20 PT, after the 12:12 PT deploy).
-- This copies only legacy rows strictly between those two times, so it
-- neither duplicates the old backfill nor overlaps the new crawler.
-- The NOT EXISTS guard makes a rerun a no-op. Same mapping as 001.

-- last row of 001
DECLARE gap_start TIMESTAMP DEFAULT TIMESTAMP '2026-11-04 20:09:55.842574';
-- first new-crawler row (12:16:20 PT)
DECLARE gap_end TIMESTAMP DEFAULT TIMESTAMP '2026-11-10 20:16:20.860';

INSERT INTO `moz-fx-hnt-prod.crawl.articles` (
  url, canonical_url, extracted_at, headline, description, authors,
  main_image_url, body_truncated, published_at, breadcrumbs, language
)
SELECT
  z.canonical_url AS url,
  z.zyte_canonicalUrl AS canonical_url,
  CAST(z.zyte_cached_at AS TIMESTAMP) AS extracted_at,
  z.zyte_headline AS headline,
  z.zyte_description AS description,
  CASE
    WHEN z.zyte_authors IS NOT NULL
    THEN ARRAY(SELECT AS STRUCT z.zyte_authors AS name)
    ELSE []
  END AS authors,
  z.zyte_mainImage AS main_image_url,
  LEFT(z.zyte_articleBody, 2000) AS body_truncated,
  CASE
    WHEN z.zyte_datePublished IS NULL THEN NULL
    WHEN z.zyte_datePublished LIKE '2000-01-01%' THEN NULL
    ELSE COALESCE(
      SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', z.zyte_datePublished),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S', z.zyte_datePublished),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%S', z.zyte_datePublished)
    )
  END AS published_at,
  CASE
    WHEN z.zyte_breadcrumbs IS NOT NULL
    THEN ARRAY(
      SELECT AS STRUCT
        JSON_VALUE(bc, '$.name') AS name,
        JSON_VALUE(bc, '$.url') AS url
      FROM UNNEST(JSON_EXTRACT_ARRAY(z.zyte_breadcrumbs)) AS bc
    )
    ELSE []
  END AS breadcrumbs,
  z.zyte_inLanguage AS language
FROM `moz-fx-mozsoc-ml-prod.prod_articles.zyte_cache` AS z
WHERE z.zyte_canonicalUrl IS NOT NULL
  AND CAST(z.zyte_cached_at AS TIMESTAMP) > gap_start
  AND CAST(z.zyte_cached_at AS TIMESTAMP) < gap_end
  AND NOT EXISTS (
    SELECT 1
    FROM `moz-fx-hnt-prod.crawl.articles` AS a
    WHERE a.extracted_at BETWEEN gap_start AND gap_end  -- partition filter
      AND a.url = z.canonical_url
      AND a.extracted_at = CAST(z.zyte_cached_at AS TIMESTAMP)
  );

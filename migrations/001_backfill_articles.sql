-- Backfill crawl.articles from legacy zyte_cache table.
--
-- Run once per environment in BigQuery Console. Change the dataset
-- name in the INSERT target to match the environment:
--   prod:  crawl.articles           (project: moz-fx-hnt-prod)
--   dev:   crawl_dev.articles       (project: moz-fx-hnt-nonprod)
--   stage: crawl_stage.articles     (project: moz-fx-hnt-nonprod)

INSERT INTO `crawl.articles` (
  url,
  extracted_at,
  headline,
  description,
  authors,
  main_image_url,
  body_truncated,
  published_at,
  breadcrumbs,
  language
)
SELECT
  canonical_url AS url,
  CAST(zyte_cached_at AS TIMESTAMP) AS extracted_at,
  zyte_headline AS headline,
  zyte_description AS description,

  -- zyte_authors is a single string, not comma-separated
  -- (commas are credentials like "PhD", not separators).
  CASE
    WHEN zyte_authors IS NOT NULL
    THEN ARRAY(SELECT AS STRUCT zyte_authors AS name)
    ELSE []
  END AS authors,

  zyte_mainImage AS main_image_url,
  LEFT(zyte_articleBody, 2000) AS body_truncated,

  -- Zyte uses '2000-01-01' as a sentinel for unparseable dates.
  CASE
    WHEN zyte_datePublished IS NULL THEN NULL
    WHEN zyte_datePublished LIKE '2000-01-01%' THEN NULL
    ELSE COALESCE(
      SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S%Ez', zyte_datePublished),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%dT%H:%M:%E*S', zyte_datePublished),
      SAFE.PARSE_TIMESTAMP('%Y-%m-%d %H:%M:%S', zyte_datePublished)
    )
  END AS published_at,

  CASE
    WHEN zyte_breadcrumbs IS NOT NULL
    THEN ARRAY(
      SELECT AS STRUCT
        JSON_VALUE(bc, '$.name') AS name,
        JSON_VALUE(bc, '$.url') AS url
      FROM UNNEST(JSON_EXTRACT_ARRAY(zyte_breadcrumbs)) AS bc
    )
    ELSE []
  END AS breadcrumbs,

  zyte_inLanguage AS language

-- Duplicates are copied as-is; matches the at-least-once delivery
-- model of the new pipeline. zyte_cached_at is UTC.
FROM `moz-fx-mozsoc-ml-prod.prod_articles.zyte_cache`
;

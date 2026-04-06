-- Backfill crawl.articles from legacy zyte_cache table.
--
-- Set target_dataset below:
--   prod:  'crawl'
--   dev:   'crawl_dev'
--   stage: 'crawl_stage'
--
-- Non-prod datasets automatically get a 30-day filter.

DECLARE target_dataset STRING DEFAULT 'crawl';

DECLARE cutoff DATETIME DEFAULT IF(
  target_dataset = 'crawl',
  DATETIME('2000-01-01'),
  DATETIME_SUB(CURRENT_DATETIME(), INTERVAL 30 DAY)
);

EXECUTE IMMEDIATE FORMAT("""
  INSERT INTO `%s.articles` (
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

    CASE
      WHEN zyte_authors IS NOT NULL
      THEN ARRAY(SELECT AS STRUCT zyte_authors AS name)
      ELSE []
    END AS authors,

    zyte_mainImage AS main_image_url,
    LEFT(zyte_articleBody, 2000) AS body_truncated,

    CASE
      WHEN zyte_datePublished IS NULL THEN NULL
      WHEN zyte_datePublished LIKE '2000-01-01%%' THEN NULL
      ELSE COALESCE(
        SAFE.PARSE_TIMESTAMP('%%Y-%%m-%%dT%%H:%%M:%%E*S%%Ez', zyte_datePublished),
        SAFE.PARSE_TIMESTAMP('%%Y-%%m-%%dT%%H:%%M:%%E*S', zyte_datePublished),
        SAFE.PARSE_TIMESTAMP('%%Y-%%m-%%d %%H:%%M:%%S', zyte_datePublished)
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

  FROM `moz-fx-mozsoc-ml-prod.prod_articles.zyte_cache`
  WHERE zyte_cached_at >= @cutoff
""", target_dataset)
USING cutoff AS cutoff;

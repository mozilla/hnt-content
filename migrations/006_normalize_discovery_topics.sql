-- Rewrite crawl.article_discoveries.topic to the crawler's topic ids (prod).
--
-- Older rows spell the same topic differently. The legacy rows from 002 and
-- 004 hold display names ('Home & Garden'), and the old crawl-agent
-- deployment wrote lowercased ones ('home & garden') from 2026-11-10 20:16
-- until about 02:21 UTC on 2026-11-11. The crawler now writes ids ('home').
-- This maps each name to its id with the reverse of CRAWL_TOPIC_TO_LEGACY in
-- content-ml-services. That map is one-to-one except Education, which is
-- also history's name; no page in publishers.json uses history, so
-- Education becomes education. Three retired en_US topics from 2025 map to
-- their section's externalId in the curated corpus: Career is career, Life
-- Hacks is society, and Top Stories/News was the Headlines category's first
-- name.
--
-- Run once in prod, after 004: it inserts display names too, and its NOT
-- EXISTS guard matches on topic, so rerunning 004 after this would insert
-- its rows again. Rerunning this is safe: rows that already hold an id are
-- skipped.

UPDATE `moz-fx-hnt-prod.crawl.article_discoveries` AS d
SET topic = m.id
FROM UNNEST([
  STRUCT('arts' AS id, 'Entertainment' AS name),
  ('business', 'Business'),
  ('education', 'Education'),
  ('education-science', 'Science'),
  ('finance', 'Money'),
  ('food', 'Food'),
  ('government', 'Politics'),
  ('headlines', 'Headlines'),
  ('health', 'Health'),
  ('hobbies', 'Gaming'),
  ('home', 'Home & Garden'),
  ('mlb', 'MLB'),
  ('movies', 'Movies'),
  ('music', 'Music'),
  ('nba', 'NBA'),
  ('nfl', 'NFL'),
  ('nhl', 'NHL'),
  ('soccer', 'Professional soccer'),
  ('society-parenting', 'Parenting'),
  ('sports', 'Sports'),
  ('tech', 'Technology'),
  ('travel', 'Travel'),
  ('tv', 'TV'),
  ('career', 'Career'),
  ('society', 'Life Hacks'),
  ('headlines', 'Top Stories/News')
]) AS m
-- Partition filter; the crawler wrote only ids after this.
WHERE d.crawled_at < TIMESTAMP '2026-11-11 03:00:00'
  AND LOWER(d.topic) = LOWER(m.name)
  -- Skips names that are already ids, such as 'business'.
  AND d.topic != m.id;

import { crawlConfig } from 'crawl-common';

// A page crawl fans out to tens of article extractions, and nothing yet
// skips an article we extracted recently, so dev and stage cap how many
// of the pages due each minute go out, and production stays off. null
// means no limit, so every due page goes out.
// TODO: Change prod value to null to release.
const maxPagesPerTick: number | null =
  crawlConfig.environment === 'prod' ? 0 : 1;

export default {
  service: 'crawl-scheduler',
  port: Number(process.env.PORT ?? '8080'),
  staleTickThresholdMinutes: Number(
    process.env.STALE_TICK_THRESHOLD_MINUTES ?? '10',
  ),
  // While this service is under development we disable live updates in
  // production and limit dev and stage to three articles a tick. Every
  // job is a Zyte extraction and nothing yet skips an article we just
  // extracted, so a tick a minute costs sixty times this number an hour.
  liveArticlesPerTick: crawlConfig.environment === 'prod' ? 0 : 3,
  maxPagesPerTick,
  // How often we re-read a live article. Each job carries this window so
  // the worker knows when the article is due again. A publisher revises
  // a headline while a story develops, so we re-read a few times an
  // hour.
  liveArticleRefreshMinutes: 15,
};

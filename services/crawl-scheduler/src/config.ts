import { crawlConfig } from 'crawl-common';

export default {
  service: 'crawl-scheduler',
  port: Number(process.env.PORT ?? '8080'),
  tickIntervalMs: Number(process.env.TICK_INTERVAL_MS ?? '60000'),
  staleTickThresholdMinutes: Number(
    process.env.STALE_TICK_THRESHOLD_MINUTES ?? '10',
  ),
  // While this service is under development we disable live updates in
  // production and limit dev and stage to three articles a tick. Every
  // job is a Zyte extraction and nothing yet skips an article we just
  // extracted, so a tick a minute costs sixty times this number an hour.
  liveArticlesPerTick: crawlConfig.environment === 'prod' ? 0 : 3,
  // A page crawl fans out to tens of article extractions, and nothing
  // yet skips a page or an article we crawled recently, so one page a
  // minute keeps Zyte spend bounded while dev and stage prove the
  // discovery path out. Production stays off.
  pagesPerTick: crawlConfig.environment === 'prod' ? 0 : 1,
  // How often we re-read a live article. Each job carries this window so
  // the worker knows when the article is due again. A publisher revises
  // a headline while a story develops, so we re-read a few times an
  // hour.
  liveArticleRefreshMinutes: 15,
};

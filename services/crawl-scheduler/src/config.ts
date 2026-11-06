import { crawlConfig } from 'crawl-common';

// option to limit the number of publisher pages processed per system tick.
// a null value means no limit.
let maxPagesPerTick: number | null = 0;

// option to limit the number of live corpus articles processed per system
// tick.
// a null value means no limit.
let maxLiveArticlesPerTick: number | null = 0;

// if the current environment is enabled, set processing limits.
if (crawlConfig.environmentEnabled) {
  switch (crawlConfig.environment) {
    // for vi tests
    case 'test':
      maxLiveArticlesPerTick = 3;
      maxPagesPerTick = 1;

      break;
    case 'dev':
      maxLiveArticlesPerTick = 3;
      maxPagesPerTick = 1;

      break;
    case 'stage':
      maxLiveArticlesPerTick = 3;
      maxPagesPerTick = 1;

      break;
    case 'prod':
      // TODO: uncomment for release phase 2
      // maxLiveArticlesPerTick = null;
      maxPagesPerTick = null;

      break;
  }
}

export default {
  service: 'crawl-scheduler',
  port: Number(process.env.PORT ?? '8080'),
  staleTickThresholdMinutes: Number(
    process.env.STALE_TICK_THRESHOLD_MINUTES ?? '10',
  ),
  maxLiveArticlesPerTick,
  maxPagesPerTick,
  // How often we re-read a live article. Each job carries this window so
  // the worker knows when the article is due again. A publisher revises
  // a headline while a story develops, so we re-read a few times an
  // hour.
  liveArticleRefreshMinutes: 15,
};

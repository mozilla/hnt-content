export { normalizeText, getRegistrableDomain } from './utils/index.js';
// TEMPORARY (HNT-2086): remove with the deployed-defaults module.
export { deployedRedisHost, deployedProjectId } from './utils/index.js';
export {
  pageFetchKey,
  pageLockKey,
  pageEnqueuedKey,
  articleEnqueuedKey,
  articleFetchKey,
  articleLockKey,
  articleContentKey,
} from './redis/index.js';
export {
  initCorpusApiClient,
  updateApprovedCorpusItem,
  getScheduledSectionItems,
  CorpusApiError,
} from './corpus-api/index.js';
export type {
  CorpusApiClientOptions,
  UpdateApprovedCorpusItemInput,
  UpdateApprovedCorpusItemResponse,
} from './corpus-api/index.js';
export type {
  CorpusItem,
  CrawlArticleMessage,
  DiscoveryContext,
  CrawlArticleDiscoveryMessage,
  ArticleAuthor,
  ArticleBreadcrumb,
  ArticleEvent,
  ArticleDiscoveryEvent,
  LiveArticle,
  PublisherList,
} from './types/index.js';
export {
  MessageValidationError,
  validateCrawlArticleMessage,
  validateCrawlArticleDiscoveryMessage,
  validateLiveArticle,
  validatePublisherList,
} from './validation/index.js';

export { normalizeText } from './utils/index.js';
export {
  initCorpusApiClient,
  updateApprovedCorpusItem,
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

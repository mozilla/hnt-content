/** Shared static fixtures for Pub/Sub unit and integration tests. */

export const PROJECT_ID = 'test-project';
export const SUBSCRIPTION_NAME = 'test-subscription';
export const TOPIC_NAME = 'test-topic';

export interface TestPayload {
  url: string;
  crawl_id: string;
}

export const TEST_PAYLOAD: TestPayload = {
  url: 'https://example.com/article',
  crawl_id: 'test-crawl-id',
};

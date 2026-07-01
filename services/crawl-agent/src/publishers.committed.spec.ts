import { describe, expect, it } from 'vitest';
import config from './config.js';
import { loadPublisherList } from './publisher-list.js';

// Guards the committed publishers.json and its module-relative path: it
// must load via the real loader and pass validatePublisherList, so a
// malformed export or a path regression fails here rather than
// crash-looping the deployed agent.
describe('committed publisher list', () => {
  it('loads and validates the committed publishers.json', async () => {
    const list = await loadPublisherList(config.publisherListPath);
    expect(list.pages.length).toBeGreaterThan(0);
    expect(list.live_articles).toEqual([]);
  });
});

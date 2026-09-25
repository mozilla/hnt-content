import { describe, expect, it } from 'vitest';
import type { PublisherList } from 'crawl-common';
import publishers from './data/publishers.json' with { type: 'json' };

// The committed file is the deployed file: it is generated from the
// editorial spreadsheet and never validated at startup, so these tests
// are the only thing standing between a mangled export and a scheduler
// publishing jobs no worker can use.
const { pages }: PublisherList = publishers;

describe('publishers.json', () => {
  it('lists pages at unique, fetchable URLs', () => {
    expect(pages.length).toBeGreaterThan(0);
    for (const { url } of pages) {
      // One legacy publisher serves http only, so the scheme check is
      // deliberately loose; it is here to catch a relative or empty URL.
      expect(new URL(url).protocol).toMatch(/^https?:$/);
    }
    expect(new Set(pages.map((page) => page.url)).size).toBe(pages.length);
  });

  it('crawls every page for at least one surface and topic', () => {
    for (const { url, contexts } of pages) {
      expect(contexts.length, url).toBeGreaterThan(0);
      for (const { surface_id, topic } of contexts) {
        // A surface_id follows the Corpus API's ScheduledSurfaceGUID
        // format, and a topic is the id the spreadsheet maps its label
        // to, such as society-parenting.
        expect(surface_id, url).toMatch(/^NEW_TAB_[A-Z]{2}_[A-Z]{2,4}$/);
        expect(topic, url).toMatch(/^[a-z][a-z-]*$/);
      }
    }
  });
});

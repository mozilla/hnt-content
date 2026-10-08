import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const SCRIPT_PATH = new URL('./sheets-app-script.js', import.meta.url);

/** The exporter functions these tests reach into. */
interface Exporter {
  buildPublishersJson_(missingSheets: string[]): string;
  buildPythonModule_(missingSheets: string[]): string;
  readUrl_(cell: string): string;
}

/** A locale sheet, as getDisplayValues returns it: header row, then rows. */
function localeSheet(rows: string[][]): string[][] {
  return [['Topic', 'Section URL', 'Approved'], ...rows];
}

/** The Topics sheet, mapping a label to the id each export writes. */
function topicsSheet(rows: string[][]): string[][] {
  return [['Topic display value', 'Topic id', 'Legacy topic id'], ...rows];
}

/**
 * Evaluate the exporter against the given sheets. Apps Script exposes its
 * API and the script's own functions as globals rather than as modules,
 * so the file is run in a context holding a stub of the one API it reads.
 */
function load(sheets: Record<string, string[][]>): Exporter {
  const spreadsheet = {
    getSheetByName: (name: string) =>
      sheets[name]
        ? { getDataRange: () => ({ getDisplayValues: () => sheets[name] }) }
        : null,
    getSheets: () =>
      Object.keys(sheets).map((name) => ({ getName: () => name })),
  };
  const context = createContext({
    console,
    URL,
    SpreadsheetApp: { getActive: () => spreadsheet },
  });
  runInContext(
    `${readFileSync(SCRIPT_PATH, 'utf8')}
    this.exported = { buildPublishersJson_, buildPythonModule_, readUrl_ };`,
    context,
  );
  // The context is untyped by construction, so this is the one cast.
  return (context as { exported: Exporter }).exported;
}

/** Run the JSON export and return the parsed pages. */
function exportPages(sheets: Record<string, string[][]>) {
  return JSON.parse(load(sheets).buildPublishersJson_([])).pages as {
    url: string;
    contexts: { surface_id: string; topic: string }[];
  }[];
}

const TOPICS = topicsSheet([
  ['Technology', 'tech', 'Technology'],
  ['Education', 'education', 'Education'],
  ['History', 'education', 'Education'],
  ['Sports', 'sports', 'Sports'],
]);

describe('the JSON export', () => {
  it('gives a page crawled for several locales one entry per surface', () => {
    const pages = exportPages({
      Topics: TOPICS,
      US: localeSheet([['Technology', 'https://example.com/tech', 'Yes']]),
      UK: localeSheet([['Technology', 'https://example.com/tech', 'Yes']]),
    });

    expect(pages).toEqual([
      {
        url: 'https://example.com/tech',
        contexts: [
          { surface_id: 'NEW_TAB_EN_GB', topic: 'tech' },
          { surface_id: 'NEW_TAB_EN_US', topic: 'tech' },
        ],
      },
    ]);
  });

  it('collapses two labels that share a topic id into one context', () => {
    // Editors can file the same page under Education and under History,
    // and both resolve to `education`. Without deduplication the page
    // would carry the same context twice.
    const pages = exportPages({
      Topics: TOPICS,
      US: localeSheet([
        ['Education', 'https://example.com/past', 'Yes'],
        ['History', 'https://example.com/past', 'Yes'],
      ]),
    });

    expect(pages[0].contexts).toEqual([
      { surface_id: 'NEW_TAB_EN_US', topic: 'education' },
    ]);
  });

  it('skips rows that are not approved', () => {
    const pages = exportPages({
      Topics: TOPICS,
      US: localeSheet([
        ['Technology', 'https://example.com/keep', 'Yes'],
        ['Technology', 'https://example.com/drop', 'No'],
      ]),
    });

    expect(pages.map((page) => page.url)).toEqual(['https://example.com/keep']);
  });

  it('fails on a topic with no id, naming the topic', () => {
    expect(() =>
      exportPages({
        Topics: TOPICS,
        US: localeSheet([['Gardening', 'https://example.com/x', 'Yes']]),
      }),
    ).toThrow(/Gardening.*Topic id/s);
  });

  it('orders pages by host and path, whatever order the rows arrive in', () => {
    // A re-export should diff to what editors changed, so the output
    // cannot depend on where a row sits in the spreadsheet. A leading www
    // is ignored, so these three sort differently by host than they would
    // as plain strings.
    const rows = [
      ['Sports', 'https://banana.com/a', 'Yes'],
      ['Sports', 'https://apple.com/z', 'Yes'],
      ['Sports', 'https://www.apple.com/a', 'Yes'],
    ];
    const forward = load({ Topics: TOPICS, US: localeSheet(rows) });
    const reversed = load({
      Topics: TOPICS,
      US: localeSheet([...rows].reverse()),
    });

    expect(forward.buildPublishersJson_([])).toBe(
      reversed.buildPublishersJson_([]),
    );
    expect(
      exportPages({ Topics: TOPICS, US: localeSheet(rows) }).map((p) => p.url),
    ).toEqual([
      'https://www.apple.com/a',
      'https://apple.com/z',
      'https://banana.com/a',
    ]);
  });

  it('reports a sheet it cannot find rather than failing', () => {
    // Editorial renames a sheet to `DRAFT FR` while a market is being
    // prepared, and the export has to carry on without it.
    const missingSheets: string[] = [];
    load({ Topics: TOPICS, US: localeSheet([]) }).buildPublishersJson_(
      missingSheets,
    );

    expect(missingSheets).toContain('FR');
    expect(missingSheets).not.toContain('US');
  });
});

describe('readUrl_', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/a'],
    ['http://example.com/a', 'http://example.com/a'],
    // Editors leave notes beside a URL, so a scheme wins wherever it sits.
    ['https://example.com/a (paused)', 'https://example.com/a'],
    // Sheets links a bare host, so data validation cannot reject one.
    ['grist.org', 'https://grist.org'],
    [
      'www.example.com/sections/business',
      'https://www.example.com/sections/business',
    ],
    // A note is not a host.
    ['TBD', ''],
    ['ask editorial', ''],
    ['see grist.org for details', ''],
    ['', ''],
  ])('reads %j as %j', (cell, expected) => {
    expect(load({}).readUrl_(cell)).toBe(expected);
  });
});

describe('the Python export', () => {
  it('writes the legacy label where the JSON export writes the id', () => {
    // The two exports read different columns of the Topics sheet, which
    // is easy to wire up backwards.
    const sheets = {
      Topics: TOPICS,
      US: localeSheet([['Technology', 'https://example.com/tech', 'Yes']]),
    };

    expect(load(sheets).buildPythonModule_([])).toContain(
      '"topics": ["Technology"]',
    );
    expect(exportPages(sheets)[0].contexts[0].topic).toBe('tech');
  });
});

/**
 * @OnlyCurrentDoc
 * Export the publisher page list the crawl scheduler reads, from the
 * editorial section URL spreadsheet this script is bound to. See
 * PUBLISHERS.md for how editors run it and how to change it.
 *
 * The spreadsheet's Apps Script project also holds the exporter that
 * writes pages.py for the legacy crawler, and Apps Script puts every
 * file of a project in one global scope. So every name here is
 * prefixed to stay clear of that file, and the menu item is registered
 * from its onOpen, the only open hook a bound script gets:
 *
 *   .addItem('Generate publishers.json', 'cmdShowPublishersJson')
 */
const PUBLISHERS_CFG = {
  // One entry per locale sheet, mirroring the pages.py exporter. A
  // sheet named "DRAFT FR" is simply not found, so a locale starts
  // being crawled when editors drop the prefix.
  sources: [
    { sheetName: 'US', locale: 'en_US' },
    { sheetName: 'UK', locale: 'en_GB' },
    { sheetName: 'CA', locale: 'en_CA' },
    { sheetName: 'IE', locale: 'en_IE' },
    { sheetName: 'DE', locale: 'de_DE' },
    { sheetName: 'FR', locale: 'fr_FR' },
    { sheetName: 'IT', locale: 'it_IT' },
    { sheetName: 'AT', locale: 'de_AT' },
    { sheetName: 'CH', locale: 'de_CH' },
    { sheetName: 'BE', locale: 'fr_BE' },
    { sheetName: 'ES', locale: 'es_ES' },
    { sheetName: 'PL', locale: 'pl_PL' },
    { sheetName: 'EU EN', locale: 'en_XE' },
    { sheetName: 'Lat Am + US ES', locale: 'es_XA' },
    { sheetName: 'India', locale: 'en_INTL' },
  ],

  // Column headers on each locale sheet.
  topicHeader: 'Topic',
  urlHeader: 'Section URL',
  approvedHeader: 'Approved',

  // The shared topic mapping sheet. Section id is our column; the
  // pages.py exporter reads Topic id from the same sheet.
  topicsSheetName: 'Topics',
  topicDisplayHeader: 'Topic display value',
  sectionIdHeader: 'Section id',
};

/** Generate publishers.json and show it. Entry point for the menu. */
function cmdShowPublishersJson() {
  const missingSheets = [];
  const json = buildPublishersFile_(missingSheets);
  showPublishersDialog_(json, missingSheets);
}

/**
 * Build the text of publishers.json. Every approved row becomes one
 * context under its page URL, so a page approved for several locales or
 * topics is a single entry.
 */
function buildPublishersFile_(missingSheets) {
  const sectionIds = loadSectionIds_();

  // url -> Map(surface_id -> Set(topic)), which drops the duplicate
  // rows editors leave behind without a separate dedupe pass.
  const byUrl = new Map();
  for (const source of PUBLISHERS_CFG.sources) {
    readPublisherRows_(source, sectionIds, byUrl, missingSheets);
  }

  const pages = [];
  for (const [url, bySurface] of byUrl) {
    const contexts = [];
    for (const [surfaceId, topics] of bySurface) {
      for (const topic of topics) {
        contexts.push({ surface_id: surfaceId, topic: topic });
      }
    }
    contexts.sort(
      (a, b) =>
        a.surface_id.localeCompare(b.surface_id) ||
        a.topic.localeCompare(b.topic),
    );
    pages.push({ url: url, contexts: contexts });
  }

  // Sorting makes a re-export diff to what editors changed. The raw URL
  // breaks ties, because two URLs differing only in scheme or in a
  // leading www share a sort key and would otherwise land in sheet order.
  pages.sort(
    (a, b) =>
      publishersSortKey_(a.url).localeCompare(publishersSortKey_(b.url)) ||
      a.url.localeCompare(b.url),
  );

  return JSON.stringify({ pages: pages }, null, 2) + '\n';
}

/**
 * Add one locale sheet's approved rows to byUrl, keyed by page URL and
 * the surface its locale names. A sheet that is absent is recorded and
 * skipped, so one unreleased locale does not block the export.
 */
function readPublisherRows_(source, sectionIds, byUrl, missingSheets) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(source.sheetName);
  if (!sheet) {
    missingSheets.push(source.sheetName);
    return;
  }

  const rows = sheet.getDataRange().getDisplayValues();
  if (!rows || rows.length < 2) return;

  const headers = rows[0].map(String);
  const iTopic = publishersHeaderIndex_(headers, PUBLISHERS_CFG.topicHeader);
  const iUrl = publishersHeaderIndex_(headers, PUBLISHERS_CFG.urlHeader);
  const iApproved = publishersHeaderIndex_(
    headers,
    PUBLISHERS_CFG.approvedHeader,
  );
  const surfaceId = 'NEW_TAB_' + source.locale.toUpperCase();

  for (let r = 1; r < rows.length; r++) {
    const approved = String(rows[r][iApproved] || '')
      .trim()
      .toLowerCase();
    if (approved !== 'yes') continue;

    // A URL in the topic column marks a spacer row rather than a page.
    const topicDisplay = String(rows[r][iTopic] || '').trim();
    if (!topicDisplay || /^https?:\/\//i.test(topicDisplay)) continue;

    // Editors sometimes leave a note beside the URL, so take the URL.
    const match = String(rows[r][iUrl] || '')
      .trim()
      .match(/https?:\/\/[^\s"')]+/i);
    if (!match) continue;

    const topic = sectionIds.get(topicDisplay.toLowerCase());
    if (!topic) {
      throw new Error(
        'Topic "' +
          topicDisplay +
          '" has no "' +
          PUBLISHERS_CFG.sectionIdHeader +
          '" on the "' +
          PUBLISHERS_CFG.topicsSheetName +
          '" sheet.',
      );
    }

    const url = match[0];
    if (!byUrl.has(url)) byUrl.set(url, new Map());
    const bySurface = byUrl.get(url);
    if (!bySurface.has(surfaceId)) bySurface.set(surfaceId, new Set());
    bySurface.get(surfaceId).add(topic);
  }
}

/**
 * Map each topic display value, lowercased, to its New Tab section id.
 * Matching is lowercased and trimmed so a stray capital in a locale
 * sheet still resolves.
 */
function loadSectionIds_() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(
    PUBLISHERS_CFG.topicsSheetName,
  );
  if (!sheet) {
    throw new Error('Sheet not found: ' + PUBLISHERS_CFG.topicsSheetName);
  }

  const rows = sheet.getDataRange().getDisplayValues();
  if (!rows || rows.length < 2) {
    throw new Error(
      'The "' + PUBLISHERS_CFG.topicsSheetName + '" sheet has no data rows.',
    );
  }

  const headers = rows[0].map(String);
  const iDisplay = publishersHeaderIndex_(
    headers,
    PUBLISHERS_CFG.topicDisplayHeader,
  );
  const iSectionId = publishersHeaderIndex_(
    headers,
    PUBLISHERS_CFG.sectionIdHeader,
  );

  const sectionIds = new Map();
  for (let r = 1; r < rows.length; r++) {
    const display = String(rows[r][iDisplay] || '').trim();
    const sectionId = String(rows[r][iSectionId] || '').trim();
    if (display && sectionId) sectionIds.set(display.toLowerCase(), sectionId);
  }
  return sectionIds;
}

/** Return a header's column index, or throw naming the header. */
function publishersHeaderIndex_(headers, name) {
  const i = headers.findIndex(
    (h) => String(h).trim().toLowerCase() === String(name).trim().toLowerCase(),
  );
  if (i === -1) throw new Error('Missing required header: "' + name + '".');
  return i;
}

/**
 * Return the key pages are sorted by: host without www, then path and
 * query, so a publisher's pages group together whatever their scheme.
 */
function publishersSortKey_(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    return host + (url.pathname || '') + (url.search || '');
  } catch (e) {
    return String(rawUrl)
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .toLowerCase();
  }
}

/**
 * Show the generated file with a copy button and what to do with it, so
 * the steps sit beside the output rather than in a document nobody has
 * open, and warn about any locale sheet that was not found.
 */
function showPublishersDialog_(text, missingSheets) {
  const html = HtmlService.createHtmlOutput(
    `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Generated publishers.json</title>
  <style>
    body { color: #202124; font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 12px 14px; }
    ol { margin: 0 0 12px; padding-left: 22px; }
    li { margin-bottom: 6px; }
    pre { background: #0b1021; border-radius: 6px; color: #e8eaed; max-height: 330px; overflow: auto; padding: 10px; }
    .btn { background: #1a73e8; border: 0; border-radius: 4px; color: #fff; cursor: pointer; font: inherit; padding: 5px 12px; }
    .btn:hover { background: #1558b0; }
    .status { color: #188038; visibility: hidden; }
    .warning { background: #fef7e0; border: 1px solid #f9cc70; border-radius: 6px; margin-bottom: 12px; padding: 8px 10px; }
  </style>
</head>
<body>
  <div class="warning" id="warning" hidden><span id="warningText"></span></div>

  <ol>
    <li><button class="btn" id="copyBtn">Copy</button> the JSON below. <span class="status" id="status">Copied</span></li>
    <li>Paste it over <a href="https://github.com/mozilla/hnt-content/edit/main/services/crawl-scheduler/src/publishers.json" target="_blank" rel="noopener">publishers.json</a> and open a pull request.</li>
    <li>Merging that pull request to <code>main</code> deploys the new list.</li>
  </ol>

  <pre><code id="out"></code></pre>

  <button class="btn" onclick="google.script.host.close()">Close</button>

<script>
  const TEXT = ${JSON.stringify(text)};
  const MISSING = ${JSON.stringify(missingSheets || [])};
  document.getElementById('out').textContent = TEXT;

  if (MISSING.length) {
    const isOne = MISSING.length === 1;
    document.getElementById('warningText').textContent =
      (isOne ? "This sheet wasn't" : "These sheets weren't")
      + ' found, so ' + (isOne ? 'its locale is' : 'their locales are')
      + ' not included below: ' + MISSING.join(', ');
    document.getElementById('warning').hidden = false;
  }

  document.getElementById('copyBtn').addEventListener('click', async () => {
    try {
      // The dialog runs sandboxed, where the clipboard API is not always
      // granted, so fall back to a hidden textarea.
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(TEXT);
      } else {
        const ta = document.createElement('textarea');
        ta.value = TEXT;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      const status = document.getElementById('status');
      status.style.visibility = 'visible';
      setTimeout(() => (status.style.visibility = 'hidden'), 1200);
    } catch (e) {
      alert('Copy failed: ' + e);
    }
  });
</script>
</body>
</html>
  `,
  )
    .setWidth(760)
    .setHeight(620);

  SpreadsheetApp.getUi().showModalDialog(html, 'Generated publishers.json');
}

/**
 * @OnlyCurrentDoc
 * The Apps Script bound to the editorial section URL spreadsheet. It holds
 * both exporters of the publisher page list, reachable from the Exporter
 * menu:
 *
 * - Generate JSON, which writes the page list the crawl scheduler in
 *   this repository reads.
 * - Generate Python, which writes pages.py for the crawler in
 *   mozilla/content-ml-services. It goes away with that crawler, leaving
 *   the JSON export behind.
 *
 * Both read the same Topic, Section URL and Approved columns from one sheet
 * per locale, and take only the rows marked Approved. They differ in how a
 * topic is named: the JSON export resolves it to a New Tab section id via
 * the Section id column of the Topics sheet, while the Python export
 * resolves it to a Topic id via that sheet's Topic id column.
 *
 * This file is the source of truth. Paste it over the project's Code.gs
 * rather than editing the live copy, and see PUBLISHERS.md.
 */
const CFG = {
  // One entry per locale sheet. surfaceId is the New Tab surface the JSON
  // export tags a page with, spelled out rather than derived so a surface
  // that does not follow the pattern needs no special case. locale names
  // the same feed for the Python export only, and goes away with it.
  // Convention: sheets prefixed with "DRAFT " are skipped. Editors drop the
  // prefix (e.g. "DRAFT FR" → "FR") once the locale is ready to be crawled.
  sources: [
    { sheetName: 'US', locale: 'en_US', surfaceId: 'NEW_TAB_EN_US' },
    { sheetName: 'UK', locale: 'en_GB', surfaceId: 'NEW_TAB_EN_GB' },
    { sheetName: 'CA', locale: 'en_CA', surfaceId: 'NEW_TAB_EN_CA' },
    { sheetName: 'IE', locale: 'en_IE', surfaceId: 'NEW_TAB_EN_IE' },
    { sheetName: 'DE', locale: 'de_DE', surfaceId: 'NEW_TAB_DE_DE' },
    { sheetName: 'FR', locale: 'fr_FR', surfaceId: 'NEW_TAB_FR_FR' },
    { sheetName: 'IT', locale: 'it_IT', surfaceId: 'NEW_TAB_IT_IT' },
    { sheetName: 'AT', locale: 'de_AT', surfaceId: 'NEW_TAB_DE_AT' },
    { sheetName: 'CH', locale: 'de_CH', surfaceId: 'NEW_TAB_DE_CH' },
    { sheetName: 'BE', locale: 'fr_BE', surfaceId: 'NEW_TAB_FR_BE' },
    { sheetName: 'ES', locale: 'es_ES', surfaceId: 'NEW_TAB_ES_ES' },
    { sheetName: 'PL', locale: 'pl_PL', surfaceId: 'NEW_TAB_PL_PL' },
    { sheetName: 'EN ROW', locale: 'en_ROW', surfaceId: 'NEW_TAB_EN_ROW' }, // English rest-of-world
    { sheetName: 'ES ROW', locale: 'es_ROW', surfaceId: 'NEW_TAB_ES_ROW' }, // Spanish rest-of-world
    { sheetName: 'India', locale: 'en_INTL', surfaceId: 'NEW_TAB_EN_INTL' }, // misleading name: en_INTL is the India feed
  ],

  // Column headers present in each source sheet
  topicHeader: 'Topic',
  urlHeader: 'Section URL',
  approvedHeader: 'Approved',

  // Topic mapping sheet config (shared across locales)
  topicsSheetName: 'Topics',
  topicDisplayHeader: 'Topic display value',
  topicIdHeader: 'Topic id',
  sectionIdHeader: 'Section id',

  // Longest line makePythonPageItem_ emits before it wraps, matching Black.
  blackMaxLen: 120,
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Exporter')
    .addItem('Generate Python', 'cmdShowPython')
    .addItem('Generate JSON', 'cmdShowJson')
    .addToUi();
}

function cmdShowPython() {
  const missingSheets = [];
  const py = buildPythonModule_(missingSheets);
  showTextDialog_('Generated Python', py, missingSheets, PYTHON_STEPS);
}

function cmdShowJson() {
  const missingSheets = [];
  const json = buildPublishersJson_(missingSheets);
  showTextDialog_('Generated JSON', json, missingSheets, JSON_STEPS);
}

/** Build the publishers.json string read by the crawl scheduler. */
function buildPublishersJson_(missingSheets) {
  const sectionMap = loadTopicMap_(CFG.sectionIdHeader);

  // url -> Map(locale -> Set(topic display values))
  const urlLocaleTopics = new Map();

  // Ingest with an empty topic map so rows keep their topic display values;
  // buildPublisherPages_ resolves those to section ids.
  for (const src of CFG.sources) {
    ingestSourceSheet_(src, new Map(), urlLocaleTopics, missingSheets);
  }

  // ingestSourceSheet_ keys by locale, so map those back to surfaces.
  const surfaceIds = new Map(
    CFG.sources.map((src) => [src.locale, src.surfaceId]),
  );

  return (
    JSON.stringify(
      buildPublisherPages_(urlLocaleTopics, sectionMap, surfaceIds),
      null,
      2,
    ) + '\n'
  );
}

/**
 * Convert ingested sheet data into the {"pages": [...]} object, given
 * url -> Map(locale -> Set(topic display values)) and a lowercased topic
 * display value -> section id map. Throws when an approved row uses a topic
 * that has no section id.
 */
function buildPublisherPages_(urlLocaleTopics, sectionMap, surfaceIds) {
  const pages = [];

  for (const [url, localeToTopics] of urlLocaleTopics) {
    const seen = new Set();
    const contexts = [];

    for (const [locale, topicDisplays] of localeToTopics) {
      const surfaceId = surfaceIds.get(locale);
      for (const display of topicDisplays) {
        const topic = sectionMap.get(display.toLowerCase());
        if (!topic) {
          throw new Error(
            `Topic "${display}" has no "${CFG.sectionIdHeader}" in the ` +
              `"${CFG.topicsSheetName}" sheet.`,
          );
        }
        const key = surfaceId + '\u0000' + topic;
        if (seen.has(key)) continue;
        seen.add(key);
        contexts.push({ surface_id: surfaceId, topic });
      }
    }

    contexts.sort(
      (a, b) =>
        a.surface_id.localeCompare(b.surface_id) ||
        a.topic.localeCompare(b.topic),
    );
    pages.push({ url, contexts });
  }

  // Tie-break on the raw URL so two URLs with the same sort key stay ordered.
  pages.sort(
    (a, b) =>
      sortKeyForUrl_(a.url).localeCompare(sortKeyForUrl_(b.url)) ||
      a.url.localeCompare(b.url),
  );
  return { pages };
}

/** Build the COMPLETE Python module string (header + PAGES = <list>) */
function buildPythonModule_(missingSheets) {
  const listLiteral = buildPythonList_(missingSheets); // ends with "\n"
  const header = `"""
AUTO-GENERATED FILE. DO NOT EDIT DIRECTLY.

To regenerate this JSON, click Exporter → Generate Python at the top of the Google Sheet:
https://docs.google.com/spreadsheets/d/1xlZnDQjVnfhGvxuFhAvktRKaKdNIZBF1zypaOTdmnzQ/edit?gid=1566790416#gid=1566790416
"""
`;
  return header + 'PAGES = ' + listLiteral;
}

/**
 * Core converter:
 * - Loads the Topic display→id map from the "Topics" sheet.
 * - Scans each configured source sheet, collecting per-URL topic ids by locale.
 * - For each URL, emits a single Python dict:
 *     {"url": ..., "targets": [{"locale": ..., "topics": [...]}, ...]}
 */
function buildPythonList_(missingSheets) {
  const topicMap = loadTopicMap_(CFG.topicIdHeader);

  // url -> Map(locale -> Set(topicIds))
  const urlLocaleTopics = new Map();

  for (const src of CFG.sources) {
    ingestSourceSheet_(src, topicMap, urlLocaleTopics, missingSheets);
  }

  if (urlLocaleTopics.size === 0) return '[]\n';

  const urls = Array.from(urlLocaleTopics.keys()).sort((a, b) =>
    sortKeyForUrl_(a).localeCompare(sortKeyForUrl_(b)),
  );

  const items = [];
  for (const u of urls) {
    const localeToTopics = urlLocaleTopics.get(u); // Map(locale -> Set(topicIds))
    const locales = Array.from(localeToTopics.keys());
    locales.sort();

    const targetsData = [];
    for (const locale of locales) {
      const topicSet = localeToTopics.get(locale);
      const topics = Array.from(topicSet);
      topics.sort();
      targetsData.push({ locale, topics });
    }

    items.push(makePythonPageItem_(u, targetsData));
  }

  return '[\n' + items.join('') + ']\n';
}

/** Ingest one source sheet (locale) into urlLocaleTopics map. */
function ingestSourceSheet_(src, topicMap, urlLocaleTopics, missingSheets) {
  const sh = SpreadsheetApp.getActive().getSheetByName(src.sheetName);
  if (!sh) {
    missingSheets.push(src.sheetName);
    return;
  }

  const rows = sh.getDataRange().getDisplayValues();
  if (!rows || rows.length < 2) return;

  const headers = rows[0].map(String);
  const iTopic = getRequiredHeaderIndex_(
    headers,
    CFG.topicHeader,
    src.sheetName,
  );
  const iUrl = getRequiredHeaderIndex_(headers, CFG.urlHeader, src.sheetName);
  const iApproved = getRequiredHeaderIndex_(
    headers,
    CFG.approvedHeader,
    src.sheetName,
  );

  for (let r = 1; r < rows.length; r++) {
    const approved = String(rows[r][iApproved] || '')
      .trim()
      .toLowerCase();
    if (approved !== 'yes') continue;

    const topicDisplay = String(rows[r][iTopic] || '').trim();
    if (!topicDisplay || /^https?:\/\//i.test(topicDisplay)) continue;

    const url = readUrl_(rows[r][iUrl]);
    if (!url) continue;

    // Resolve display → id (case-insensitive, trimmed). Fallback to display if not found.
    const key = topicDisplay.toLowerCase();
    const topicId = topicMap.get(key) || topicDisplay;

    if (!urlLocaleTopics.has(url)) {
      urlLocaleTopics.set(url, new Map()); // locale -> Set(topicIds)
    }

    const localeToTopics = urlLocaleTopics.get(url);
    if (!localeToTopics.has(src.locale))
      localeToTopics.set(src.locale, new Set());
    localeToTopics.get(src.locale).add(topicId);
  }
}

/**
 * Read the page URL out of a Section URL cell, or return '' when the
 * cell holds none. An explicit scheme is taken from anywhere in the
 * cell, since editors sometimes leave a note beside the URL. A cell
 * that is nothing but a host and path is assumed to be https: Sheets
 * renders "grist.org" as a link, so data validation does not reject
 * one, and the row would otherwise be approved and never crawled. The
 * whole cell has to match for that, so a note is not read as a host.
 */
function readUrl_(raw) {
  const cell = String(raw || '').trim();
  const explicit = cell.match(/https?:\/\/[^\s"')]+/i);
  if (explicit) return explicit[0];

  const bare =
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:[/?#]\S*)?$/i;
  return bare.test(cell) ? 'https://' + cell : '';
}

/**
 * Load Topic display → id mapping from the Topics sheet, reading ids from the
 * given column (Topic id for Python, Section id for JSON). Keys are lowercased
 * & trimmed for robust matching.
 */
function loadTopicMap_(idHeader) {
  const sh = SpreadsheetApp.getActive().getSheetByName(CFG.topicsSheetName);
  if (!sh) throw new Error('Sheet not found: ' + CFG.topicsSheetName);

  const rows = sh.getDataRange().getDisplayValues();
  if (!rows || rows.length < 2)
    throw new Error('Topics sheet has no data rows.');

  const headers = rows[0].map(String);
  const iDisplay = getRequiredHeaderIndex_(
    headers,
    CFG.topicDisplayHeader,
    CFG.topicsSheetName,
  );
  const iId = getRequiredHeaderIndex_(headers, idHeader, CFG.topicsSheetName);

  const map = new Map();
  for (let r = 1; r < rows.length; r++) {
    const display = String(rows[r][iDisplay] || '').trim();
    const id = String(rows[r][iId] || '').trim();
    if (!display || !id) continue;
    map.set(display.toLowerCase(), id);
  }
  return map;
}

/**
 * Build one per-URL item:
 * {"url": "<url>", "targets": [{"locale": "en_US", "topics": ["A", "B"]}, ...]}
 * respecting 120-char total line length (indent + trailing comma included).
 */
function makePythonPageItem_(url, targetsData) {
  const indent4 = '    ';
  const indent8 = '        ';
  const indent12 = '            ';

  const urlS = pyString_(url);

  const targetChunks = [];
  for (const t of targetsData) {
    const localeS = pyString_(t.locale);
    const topicsS = '[' + t.topics.map(pyString_).join(', ') + ']';
    targetChunks.push(`{"locale": ${localeS}, "topics": ${topicsS}}`);
  }

  const targetsInline = '[' + targetChunks.join(', ') + ']';
  const oneLine = `${indent4}{"url": ${urlS}, "targets": ${targetsInline}},\n`;
  if (oneLine.length <= CFG.blackMaxLen) return oneLine;

  // Multiline formatting
  let out = `${indent4}{\n`;
  out += `${indent8}"url": ${urlS},\n`;

  if (targetChunks.length === 0) {
    out += `${indent8}"targets": [],\n`;
  } else if (
    targetChunks.length === 1 &&
    `${indent8}"targets": [${targetChunks[0]}],\n`.length <= CFG.blackMaxLen
  ) {
    out += `${indent8}"targets": [${targetChunks[0]}],\n`;
  } else {
    out += `${indent8}"targets": [\n`;
    for (const tLine of targetChunks) {
      out += `${indent12}${tLine},\n`;
    }
    out += `${indent8}],\n`;
  }

  out += `${indent4}},\n`;
  return out;
}

/** Quote as Python string literal using JSON escaping. */
function pyString_(s) {
  return JSON.stringify(String(s));
}

/**
 * Return a header's column index. Throws naming the sheet and the columns
 * it does have, so a renamed or missing column is fixed from the message
 * rather than from a stack trace.
 */
function getRequiredHeaderIndex_(headers, name, sheetName) {
  const i = headers.findIndex(
    (h) => String(h).trim().toLowerCase() === String(name).trim().toLowerCase(),
  );
  if (i === -1) {
    throw new Error(
      `The "${sheetName}" sheet has no "${name}" column. ` +
        `Its columns are: ${headers.filter(String).join(', ')}.`,
    );
  }
  return i;
}

/** Sort key that ignores scheme and leading 'www.' */
function sortKeyForUrl_(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    const path = url.pathname || '';
    const query = url.search || '';
    return host + path + query;
  } catch (e) {
    return String(u)
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .toLowerCase();
  }
}

// What to do with the copied text, as HTML for the numbered steps after
// "Copy". Each exporter passes its own list.
const PYTHON_STEPS = [
  `<span>Paste it into</span>
        <a href="https://github.com/mozilla/content-ml-services/edit/main/jobs/cloudfunctions/crawl/pages.py" target="_blank" rel="noopener">pages.py</a>
        <span>and merge a PR to <code>main</code>.</span>`,
  `<span>Merge a</span>
        <a href="https://github.com/mozilla/content-ml-services/compare/prod...main" target="_blank" rel="noopener">main → prod PR</a>
        <span>to deploy.</span>`,
];
const JSON_STEPS = [
  `<span>Paste it into</span>
        <a href="https://github.com/mozilla/hnt-content/edit/main/services/crawl-scheduler/src/data/publishers.json" target="_blank" rel="noopener">publishers.json</a>
        <span>in hnt-content and merge a PR to <code>main</code>, which deploys it.</span>`,
];

/** Modal: numbered instructions + generated text preview. */
function showTextDialog_(title, text, missingSheets, steps) {
  const sheetNames = SpreadsheetApp.getActive()
    .getSheets()
    .map((sheet) => sheet.getName());
  const stepsHtml = (steps || PYTHON_STEPS)
    .map(
      (step) =>
        `<div class="step">\n      <div class="step-content">\n        ${step}\n      </div>\n    </div>`,
    )
    .join('\n    ');
  const html = HtmlService.createHtmlOutput(
    `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    :root {
      --blue: #1a73e8;
      --blue-dark: #1558b0;
      --code-bg: #0b1021;
      --text: #202124;
      --muted: #5f6368;
      --step-bg: #f1f3f4;
      --step-border: #dfe3e7;
      --success: #188038;
    }

    * { box-sizing: border-box; }

    body {
      color: var(--text);
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      margin: 12px 14px;
    }

    .steps {
      counter-reset: step;
      display: grid;
      gap: 10px;
      margin: 4px 0 14px;
      padding: 0 2px;
    }

    .step {
      align-items: center;
      background: var(--step-bg);
      border: 1px solid var(--step-border);
      border-radius: 12px;
      display: flex;
      gap: 14px;
      min-height: 54px;
      padding: 10px 16px;
      position: relative;
    }

    .step::before {
      align-items: center;
      background: #8fd3ee;
      border: 4px solid #fff;
      border-radius: 999px;
      color: #17465a;
      content: counter(step);
      counter-increment: step;
      display: inline-flex;
      flex: 0 0 44px;
      font-size: 18px;
      font-weight: 700;
      height: 44px;
      justify-content: center;
      width: 44px;
    }

    .step-content {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 0;
    }

    .btn {
      background: var(--blue);
      border: none;
      border-radius: 7px;
      color: #fff;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
      padding: 8px 14px;
    }

    .btn:hover { background: var(--blue-dark); }
    .btn:active { transform: translateY(1px); }

    .status {
      color: var(--success);
      font-size: 12px;
      font-weight: 600;
      visibility: hidden;
    }

    a {
      color: var(--blue);
      font-weight: 600;
      text-decoration: none;
    }

    a:hover { text-decoration: underline; }

    .hint { color: var(--muted); }

    .warning {
      align-items: center;
      background: #fef7e0;
      border: 1px solid #f6d877;
      border-radius: 10px;
      color: #5f4400;
      display: flex;
      gap: 10px;
      margin: 4px 0 14px;
      padding: 10px 14px;
    }

    .warning[hidden] { display: none; }

    .warning-icon {
      flex: 0 0 auto;
      font-size: 16px;
      line-height: 1;
    }

    pre {
      background: var(--code-bg);
      border-radius: 10px;
      color: #e6edf3;
      height: 395px;
      margin: 0;
      overflow: auto;
      padding: 14px;
    }

    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      white-space: pre;
    }

    .footer {
      margin-top: 10px;
      text-align: right;
    }
  </style>
</head>
<body>
  <div class="warning" id="warning" role="alert" hidden>
    <span class="warning-icon" aria-hidden="true">⚠️</span>
    <span id="warningText"></span>
  </div>

  <div class="steps" aria-label="Instructions">
    <div class="step">
      <div class="step-content">
        <button class="btn" id="copyBtn">Copy</button>
        <span>the code below.</span>
        <span class="status" id="status">Copied</span>
      </div>
    </div>
    ${stepsHtml}
  </div>

  <pre><code id="out"></code></pre>

  <div class="footer">
    <button class="btn" onclick="google.script.host.close()">Close</button>
  </div>
<script>
  const TEXT = ${JSON.stringify(text)};
  const MISSING = ${JSON.stringify(missingSheets || [])};
  const SHEETS = ${JSON.stringify(sheetNames)};
  const out = document.getElementById('out');
  out.textContent = TEXT;

  if (MISSING.length) {
    const isOne = MISSING.length === 1;
    // A missing sheet is nearly always a tab that was renamed, so name the
    // tabs that do exist rather than leaving the reader to guess.
    document.getElementById('warningText').textContent =
      (isOne ? "This sheet wasn't" : "These sheets weren't")
      + " found, so " + (isOne ? "its locale is" : "their locales are")
      + " not included below: " + MISSING.join(", ")
      + ". The spreadsheet's tabs are: " + SHEETS.join(", ") + ".";
    document.getElementById('warning').hidden = false;
  }
  document.getElementById('copyBtn').addEventListener('click', async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(TEXT);
      else {
        const ta = document.createElement('textarea');
        ta.value = TEXT;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      const s = document.getElementById('status');
      s.style.visibility = 'visible';
      setTimeout(() => s.style.visibility = 'hidden', 1200);
    } catch (e) { alert('Copy failed: ' + e); }
  });
</script>
</body>
</html>
  `,
  )
    .setWidth(760)
    .setHeight(665);

  SpreadsheetApp.getUi().showModalDialog(html, title);
}

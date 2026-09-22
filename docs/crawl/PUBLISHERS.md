# Publisher pages

The crawler discovers stories by crawling a fixed list of publisher section pages, such as a newspaper's technology or sports page. That list is [`services/crawl-scheduler/src/publishers.json`](../../services/crawl-scheduler/src/publishers.json), and the scheduler enqueues pages from it on every tick. For where it sits in the wider system, see [ARCHITECTURE.md](ARCHITECTURE.md).

Editors decide which pages we crawl, not engineers. They maintain the [section URL spreadsheet](https://docs.google.com/spreadsheets/d/1xlZnDQjVnfhGvxuFhAvktRKaKdNIZBF1zypaOTdmnzQ/edit?gid=1566790416), one sheet per locale, and mark a row **Approved** once it is ready. The committed file is an export of that spreadsheet, so it is generated rather than written by hand.

## Updating the list

Open the spreadsheet and choose **Exporter > Generate publishers.json**. The dialog that opens carries the rest of the steps and the links they need.

<!-- Screenshot: the Exporter menu, with "Generate publishers.json" selected. -->

<!-- Screenshot: the generated publishers.json dialog, showing its copy button and steps. -->

A pull request that changes the list should be a plain re-export with nothing edited by hand, so that its diff shows exactly what editors changed.

## What the export produces

Each approved row becomes one context under its page URL, so a page approved for several locales or topics is a single entry:

```json
{
  "pages": [
    {
      "url": "https://example.com/news/technology",
      "contexts": [{ "surface_id": "NEW_TAB_EN_US", "topic": "tech" }]
    }
  ]
}
```

`url` comes from the **Section URL** column.

`surface_id` is `NEW_TAB_` followed by the uppercased locale of the sheet the row came from, which is the `ScheduledSurfaceGUID` the Corpus API answers to. The "India" sheet is the locale `en_INTL`, so its rows carry `NEW_TAB_EN_INTL`.

`topic` is the New Tab section id for the row's **Topic**, read from the **Section id** column of the "Topics" sheet. Section ids are what the recommendation pipeline keys on, so the crawler records `tech` rather than the display value "Technology". Use the unsuffixed id, as en-US spells it: the per-locale prospecting configs suffix theirs, but `surface_id` already carries the locale here. A topic with no section id fails the export with an error naming it, rather than quietly mislabelling articles.

A sheet whose name is prefixed `DRAFT ` is not found by the exporter, so a locale starts being crawled when editors drop the prefix. The dialog lists any sheet it could not find. Pages sort by URL and contexts by surface then topic, so a re-export diffs cleanly.

Nothing validates the file at runtime. [`publishers.spec.ts`](../../services/crawl-scheduler/src/publishers.spec.ts) checks the committed copy in CI instead, because the file that is committed is the file that deploys.

## Changing the exporter

The exporter is [`publishers-app-script.js`](publishers-app-script.js), running as Apps Script bound to the spreadsheet. Edit it here and paste it over the live copy, never the other way around, so the two cannot drift. To do that, open **Extensions > Apps Script** on the spreadsheet, replace the contents of the `publishers` file, save, and run the export once to confirm it still works.

That Apps Script project also holds the exporter that writes `pages.py` for the legacy crawler, which [content-ml-services owns](https://github.com/mozilla/content-ml-services/blob/main/jobs/cloudfunctions/crawl/docs/sheets_app_script.js). Apps Script puts every file of a project in one global scope, so the two exporters share a namespace: every name in ours is prefixed to keep them apart, and our menu item is registered from that file's `onOpen`, the only open hook a bound script gets. Once the legacy crawler is decommissioned and that file goes away, this one takes over `onOpen` and owns the menu.

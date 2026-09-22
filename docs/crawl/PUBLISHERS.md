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

## The script

[`sheets-app-script.js`](sheets-app-script.js) is the entire Apps Script project bound to the spreadsheet, and this repository is its source of truth. It carries both exporters behind one Exporter menu: **Generate publishers.json**, which this crawler reads, and **Generate Python**, which writes `pages.py` for the crawler in [content-ml-services](https://github.com/mozilla/content-ml-services/blob/main/jobs/cloudfunctions/crawl/pages.py). One file means one copy of the sheet-reading code and one place to look, and decommissioning the legacy crawler then deletes the Python half rather than untangling it.

To change it, edit the copy here and paste it over the live one, never the other way around, so the two cannot drift. Open **Extensions > Apps Script** on the spreadsheet, replace the contents of `Code.gs`, save, and run both exports once to confirm they still work. The menu is built by `onOpen`, a simple trigger that runs only when the spreadsheet is opened, so reload the spreadsheet tab to see a menu change. Saving the script is not enough.

The locale tabs the script reads are listed in its `sources`. A renamed tab is reported as missing in the export dialog, along with the tab names the spreadsheet actually has, so the fix is to correct `sources` here and paste again. Both exporters skip a tab they cannot find rather than failing, which is what lets a locale go live by renaming `DRAFT FR` to `FR`, so read that warning before shipping an export.

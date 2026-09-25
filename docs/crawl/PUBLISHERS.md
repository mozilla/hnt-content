# Publisher pages

The crawler discovers stories from a fixed list of publisher section pages, such as a newspaper's technology or sports page. Editors maintain that list in the [section URL spreadsheet](https://docs.google.com/spreadsheets/d/1xlZnDQjVnfhGvxuFhAvktRKaKdNIZBF1zypaOTdmnzQ/edit?gid=1566790416), one sheet per locale, and mark a row **Approved** when it is ready to crawl. Its export is committed here as [`publishers.json`](../../services/crawl-scheduler/src/data/publishers.json), which the scheduler reads on every tick. For where it fits in the wider system, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Updating the list

Choose **Exporter > Generate JSON** in the spreadsheet. The menu is built by a script that runs when the spreadsheet opens, so give it a moment to appear. **Generate Python** beside it writes the page list for the [older crawler](https://github.com/mozilla/content-ml-services/blob/main/jobs/cloudfunctions/crawl/pages.py), and stays until that pipeline is switched off.

![The Exporter menu](images/exporter-menu.png)

Then follow the two steps in the dialog, which takes a few seconds to appear because it reads every locale sheet.

![The Generated JSON dialog](images/generated-json.png)

## What the export writes

Each approved row becomes one context under its page URL, so a page approved for several locales or topics is a single entry with several contexts.

The topic is an id rather than the label editors see, taken from the **Topic id** column of the "Topics" sheet, so the crawler records `tech` where the spreadsheet says "Technology". A topic with no id fails the export with an error naming it.

Only the sheets named in the script are read. Editorial prefixes a sheet with `DRAFT` while a new market is being prepared, as in `DRAFT FR`, which keeps it out of the export until the prefix comes off. The dialog lists any named sheet it could not find.

[`publishers.spec.ts`](../../services/crawl-scheduler/src/publishers.spec.ts) checks the committed file in CI, because the file that is committed is the file that deploys.

## Deploying App Script changes

[`sheets-app-script.js`](sheets-app-script.js) is the script behind the Exporter menu, and this repository is its source of truth. It holds both exports, and the Python half is deleted along with the crawler that needs it. Edit the copy here and paste it over the live one, never the other way around, so the two cannot drift:

1. Open **Extensions > Apps Script** in the spreadsheet.
2. Replace the script with the copy from this repository, and save.
3. Reload the spreadsheet, which rebuilds the Exporter menu.

Then run both exports to confirm they still work.

The sheets the script reads are listed in its `sources`, each pairing a sheet name with the surface it feeds. A renamed sheet is reported as missing in the dialog, along with the sheets the spreadsheet does have, so correct `sources` here and paste again.

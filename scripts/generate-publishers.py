#!/usr/bin/env python3
"""Generate the crawl-agent publisher list from the legacy crawl PAGES.

Reads the legacy ``pages.py`` (an auto-generated export of the curated
publisher Google Sheet) and emits the publisher list JSON the crawl-agent
loads and validates (``PublisherList``: ``pages`` + ``live_articles``).

Mapping decisions:
  - Each PAGES entry has ``targets`` of ``{locale, topics[]}``. We flatten
    to one discovery ``context`` per (locale, topic): the locale becomes a
    New Tab scheduled-surface id ``NEW_TAB_<LOCALE>`` (e.g. en_US ->
    NEW_TAB_EN_US), and the topic is lowercased to match the discovery
    context convention in publishers.example.json (the curated subtopic
    label is otherwise kept verbatim).
  - ``interval_minutes`` defaults to 20 (the tech spec's example cadence);
    the legacy list carried no per-page interval.
  - Entries are merged by URL so a page crawled for several surfaces is one
    publisher entry with several contexts, as the agent's validator
    requires (page URLs must be unique). Contexts are de-duplicated.
  - ``live_articles`` is empty: the legacy PAGES list has no curated live
    articles (those come from the Corpus API in Phase 5).

Usage:
  generate-publishers.py <pages.py path> <output.json path> [--limit N]
                         [--locales en_US,de_DE,...]
"""
import argparse
import importlib.util
import json
import sys
from collections import OrderedDict


def load_pages(path):
    """Import the PAGES list from a legacy pages.py module by file path."""
    spec = importlib.util.spec_from_file_location("legacy_pages", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.PAGES


def surface_id(locale):
    """Map a legacy locale (en_US) to a New Tab surface id (NEW_TAB_EN_US)."""
    return f"NEW_TAB_{locale.upper()}"


def build_pages(raw_pages, interval_minutes, locales_filter):
    """Merge raw PAGES into unique-URL publisher entries with contexts."""
    by_url = OrderedDict()
    for entry in raw_pages:
        url = entry["url"]
        contexts = by_url.setdefault(url, OrderedDict())
        for target in entry.get("targets", []):
            locale = target["locale"]
            if locales_filter and locale not in locales_filter:
                continue
            for topic in target.get("topics", []):
                key = (surface_id(locale), topic.lower())
                contexts[key] = None
    pages = []
    for url, context_keys in by_url.items():
        if not context_keys:
            continue
        pages.append(
            {
                "url": url,
                "interval_minutes": interval_minutes,
                "contexts": [
                    {"surface_id": s, "topic": t} for (s, t) in context_keys
                ],
            }
        )
    return pages


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pages_path")
    parser.add_argument("output_path")
    parser.add_argument("--interval-minutes", type=int, default=20)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--locales", default="")
    args = parser.parse_args()

    locales_filter = set(filter(None, args.locales.split(",")))
    raw = load_pages(args.pages_path)
    pages = build_pages(raw, args.interval_minutes, locales_filter)
    if args.limit:
        pages = pages[: args.limit]

    out = {"pages": pages, "live_articles": []}
    with open(args.output_path, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")

    contexts = sum(len(p["contexts"]) for p in pages)
    print(
        f"wrote {len(pages)} pages, {contexts} contexts -> {args.output_path}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()

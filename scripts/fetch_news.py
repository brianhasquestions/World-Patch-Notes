#!/usr/bin/env python3
"""Fetch the week's headlines from RSS feeds into a raw JSON file.

Zero third-party dependencies - uses only the Python standard library, so it
runs anywhere Python 3.9+ is installed with no `pip install` step.

Output: data/raw/<week-id>.json  (e.g. data/raw/2026-W26.json)
The patch-notes-writer agent reads that file and turns it into a release.

Configure feeds in scripts/feeds.txt (one URL per line, '#' for comments).
"""

from __future__ import annotations

import datetime as dt
import json
import re
import sys
import urllib.request
from email.utils import parsedate_to_datetime
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
FEEDS_FILE = ROOT / "scripts" / "feeds.txt"
RAW_DIR = ROOT / "data" / "raw"

USER_AGENT = "WorldPatchNotes/1.0 (+https://github.com/) RSS fetcher"
DAYS_BACK = 7
TIMEOUT = 20

# Strip these XML namespaces so tag lookups are simple.
NS_RE = re.compile(r"\{[^}]+\}")


def tag(el: ET.Element) -> str:
    return NS_RE.sub("", el.tag).lower()


def find_text(item: ET.Element, *names: str) -> str:
    wanted = {n.lower() for n in names}
    for child in item:
        if tag(child) in wanted and child.text:
            return child.text.strip()
    return ""


def find_link(item: ET.Element) -> str:
    # RSS: <link>url</link>.  Atom: <link href="url" rel="alternate"/>.
    for child in item:
        if tag(child) != "link":
            continue
        if child.text and child.text.strip():
            return child.text.strip()
        href = child.get("href")
        rel = child.get("rel", "alternate")
        if href and rel in ("alternate", ""):
            return href.strip()
    return ""


def parse_date(item: ET.Element) -> dt.datetime | None:
    raw = find_text(item, "pubDate", "published", "updated", "date")
    if not raw:
        return None
    try:
        d = parsedate_to_datetime(raw)  # RFC 822 (RSS)
    except (TypeError, ValueError):
        try:
            d = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))  # ISO 8601 (Atom)
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=dt.timezone.utc)
    return d.astimezone(dt.timezone.utc)


def feed_title(root: ET.Element) -> str:
    channel = root.find("./{*}channel")
    scope = channel if channel is not None else root
    for child in scope:
        if tag(child) == "title" and child.text:
            return child.text.strip()
    return "unknown"


def fetch_feed(url: str) -> list[dict]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        data = resp.read()
    root = ET.fromstring(data)
    source = feed_title(root)
    items = []
    for el in root.iter():
        if tag(el) in ("item", "entry"):
            items.append(el)
    out = []
    for it in items:
        title = find_text(it, "title")
        if not title:
            continue
        out.append({
            "title": title,
            "link": find_link(it),
            "source": source,
            "published": (parse_date(it) or dt.datetime.now(dt.timezone.utc)).isoformat(),
            "summary": find_text(it, "description", "summary")[:500],
        })
    return out


def load_feeds(feeds_file: Path) -> list[str]:
    if not feeds_file.exists():
        sys.exit(f"No feeds file at {feeds_file}. Add RSS URLs, one per line.")
    feeds = []
    for line in feeds_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            feeds.append(line)
    return feeds


def normalize(title: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", title.lower()).strip()


def week_id(today: dt.date) -> tuple[str, str]:
    iso = today.isocalendar()  # (year, week, weekday)
    monday = today - dt.timedelta(days=today.weekday())
    sunday = monday + dt.timedelta(days=6)
    if monday.month == sunday.month:
        span = f"{monday.strftime('%b')} {monday.day}-{sunday.day}, {sunday.year}"
    else:
        span = f"{monday.strftime('%b')} {monday.day}-{sunday.strftime('%b')} {sunday.day}, {sunday.year}"
    return f"{iso.year}-W{iso.week:02d}", f"Week of {span}"


def main(feeds_file: Path = FEEDS_FILE, out_path: Path | None = None) -> None:
    today = dt.date.today()
    wid, title = week_id(today)
    cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=DAYS_BACK)

    all_items, seen = [], set()
    for url in load_feeds(feeds_file):
        try:
            items = fetch_feed(url)
            print(f"  ok   {len(items):>3} items  {url}")
        except Exception as e:  # noqa: BLE001 - keep going on a single bad feed
            print(f"  FAIL           {url}  ({e})")
            continue
        for it in items:
            pub = dt.datetime.fromisoformat(it["published"])
            if pub < cutoff:
                continue
            key = normalize(it["title"])
            if not key or key in seen:
                continue
            seen.add(key)
            all_items.append(it)

    all_items.sort(key=lambda x: x["published"], reverse=True)

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    out_path = (out_path or (RAW_DIR / f"{wid}.json")).resolve()
    payload = {
        "id": wid,
        "title": title,
        "version": f"v{wid.replace('-W', '.')}",
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(),
        "count": len(all_items),
        "headlines": all_items,
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        shown = out_path.relative_to(ROOT)
    except ValueError:
        shown = out_path
    print(f"\nWrote {len(all_items)} headlines -> {shown}")
    print(f"Week: {wid}  ({title})")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Fetch RSS headlines for World Patch Notes.")
    parser.add_argument("--feeds", type=Path, default=FEEDS_FILE,
                        help="Path to a feeds list (default: scripts/feeds.txt)")
    parser.add_argument("--out", type=Path, default=None,
                        help="Output JSON path (default: data/raw/<week-id>.json)")
    cli = parser.parse_args()
    main(feeds_file=cli.feeds, out_path=cli.out)

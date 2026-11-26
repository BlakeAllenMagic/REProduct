#!/usr/bin/env python3
"""Find datasheet links on Mouser for parts whose Datasheet link is blank.

Some manufacturers (Marki Microwave, for one) only list their PDF addresses on
pages that block programs. Mouser's free Search API returns a datasheet link
for each part it sells, so this fills the gaps:

  - Reads data/parts/*.csv and picks the parts with no Datasheet link.
  - Asks Mouser's part-number search, several part numbers per request.
  - Accepts a result only if the manufacturer and the part number match.
  - Saves what it learned in data/datasheet-links.json:
        { "<part id>": { "url": "https://..." or null, "checked": "YYYY-MM-DD" } }
    build_linecard.py uses these links only where the Sheet has none: a link
    typed into the Sheet always wins.

Parts are checked again after --recheck-days (Mouser may add a part or move
a link). Each run makes at most --max-requests requests, so it never uses up
the key's daily allowance; the rest are done on the next runs.

The key comes from the MOUSER_API_KEY environment variable (a GitHub secret),
never from the repo. Without it, the tool does nothing.

Usage:
  MOUSER_API_KEY=... python3 tools/find_datasheet_links.py [--limit 10]
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_linecard import display, make_part_id  # noqa: E402

API_URL = "https://api.mouser.com/api/v1/search/partnumber"
USER_AGENT = "RF-Line-Card-datasheet-links/1.0"


class StopRun(Exception):
    """Mouser said no more for now (limit reached, bad key): save progress and stop."""


def normalize(mpn: str) -> str:
    return re.sub(r"\s+", "", mpn).upper()


def maker_word(manufacturer: str) -> str:
    """'Marki Microwave' -> 'marki': matched against Mouser's manufacturer name."""
    return re.sub(r"[^a-z0-9]", "", manufacturer.split()[0].lower()) if manufacturer.strip() else ""


def read_parts(data_dir: Path) -> list[dict[str, str]]:
    """Every part as {id, manufacturer, mpn, sheet_link}."""
    parts = []
    for path in sorted((data_dir / "parts").glob("*.csv")):
        with path.open(encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                manufacturer, mpn = (row.get("manufacturer") or "").strip(), (row.get("mpn") or "").strip()
                if manufacturer and mpn:
                    parts.append({
                        "id": make_part_id(manufacturer, mpn),
                        "manufacturer": manufacturer,
                        "mpn": mpn,
                        "sheet_link": (row.get("datasheet_url") or "").strip(),
                    })
    return parts


def due_parts(parts: list[dict[str, str]], known: dict[str, Any], today: date, recheck_days: int) -> list[dict[str, str]]:
    """Parts without a Sheet link that were never checked, or not for recheck_days. Never-checked first."""
    cutoff = (today - timedelta(days=recheck_days)).isoformat()
    due = [p for p in parts if not p["sheet_link"] and known.get(p["id"], {}).get("checked", "") <= cutoff]
    return sorted(due, key=lambda p: known.get(p["id"], {}).get("checked", ""))


def clean_link(url: Any) -> str | None:
    if not isinstance(url, str) or not url.strip():
        return None
    url = url.strip()
    if url.startswith("//"):
        url = "https:" + url
    if url.startswith("http://"):
        url = "https://" + url[len("http://"):]
    return url if url.startswith("https://") else None


def match_results(batch: list[dict[str, str]], results: list[dict[str, Any]]) -> dict[str, str | None]:
    """Part id -> datasheet link (or None) for each part in the batch."""
    found: dict[str, str | None] = {p["id"]: None for p in batch}
    for part in batch:
        for result in results:
            same_part = normalize(str(result.get("ManufacturerPartNumber", ""))) == normalize(part["mpn"])
            same_maker = maker_word(part["manufacturer"]) in str(result.get("Manufacturer", "")).lower()
            link = clean_link(result.get("DataSheetUrl"))
            if same_part and same_maker and link:
                found[part["id"]] = link
                break
    return found


def mouser_search(api_key: str, timeout: float) -> Callable[[list[str]], list[dict[str, Any]]]:
    """A function that searches Mouser for several part numbers at once."""

    def search(mpns: list[str]) -> list[dict[str, Any]]:
        body = json.dumps({"SearchByPartRequest": {"mouserPartNumber": "|".join(mpns), "partSearchOptions": "Exact"}})
        request = urllib.request.Request(
            f"{API_URL}?apiKey={api_key}",  # Mouser takes the key here; never printed
            data=body.encode(),
            headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code in (401, 403, 429):
                raise StopRun(f"Mouser answered HTTP {error.code} (bad key or limit reached)") from None
            raise
        errors = payload.get("Errors") or []
        if errors:
            messages = "; ".join(str(e.get("Message") or e.get("Code") or e) for e in errors)
            raise StopRun(f"Mouser said: {messages}")
        return (payload.get("SearchResults") or {}).get("Parts") or []

    return search


def run(
    parts: list[dict[str, str]],
    known: dict[str, Any],
    search: Callable[[list[str]], list[dict[str, Any]]],
    *,
    today: date,
    batch_size: int,
    max_requests: int,
    limit: int | None,
    recheck_days: int,
    interval: float,
    sleep: Callable[[float], None] = time.sleep,
    log: Callable[[str], None] = print,
) -> tuple[dict[str, Any], bool]:
    """Look up the due parts. Returns (new contents of datasheet-links.json, any link changed)."""
    updated = dict(known)
    due = due_parts(parts, known, today, recheck_days)
    if limit is not None:
        due = due[:limit]
    log(f"{len(due)} parts to look up on Mouser.")
    changed = False
    requests = 0
    found_count = 0
    for start in range(0, len(due), batch_size):
        if requests >= max_requests:
            log(f"Stopping at {max_requests} requests; the rest are looked up on the next run.")
            break
        batch = due[start:start + batch_size]
        if requests:
            sleep(interval)
        requests += 1
        try:
            results = search([p["mpn"] for p in batch])
        except StopRun as stop:
            log(f"::warning::{stop}. Progress so far is saved.")
            break
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            log(f"::warning::Mouser request failed ({error}); these parts are tried again next run.")
            continue
        for part_id, link in match_results(batch, results).items():
            if link:
                found_count += 1
            if link != (known.get(part_id) or {}).get("url"):
                changed = True
            updated[part_id] = {"url": link, "checked": today.isoformat()}
    log(f"{requests} requests, {found_count} links found.")
    # Forget parts that are gone from the sheet, or now have their own link there.
    keep = {p["id"] for p in parts if not p["sheet_link"]}
    if set(updated) - keep:
        updated = {k: v for k, v in updated.items() if k in keep}
        changed = True
    return updated, changed


def main(argv: list[str] | None = None) -> int:
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Find datasheet links on Mouser for parts that have none.")
    parser.add_argument("--data", type=Path, default=repo / "data")
    parser.add_argument("--limit", type=int, help="look up at most this many parts (for a first test)")
    parser.add_argument("--batch", type=int, default=10, help="part numbers per request")
    # 60 per run x 12 runs a day stays under Mouser's daily allowance (about 1,000).
    parser.add_argument("--max-requests", type=int, default=60, help="requests per run")
    parser.add_argument("--interval", type=float, default=2.5, help="seconds between requests")
    parser.add_argument("--recheck-days", type=int, default=30)
    parser.add_argument("--timeout", type=float, default=30.0)
    args = parser.parse_args(argv)

    api_key = os.environ.get("MOUSER_API_KEY", "").strip()
    if not api_key:
        print("No MOUSER_API_KEY: skipping the Mouser lookup.")
        return 0

    links_path = args.data / "datasheet-links.json"
    known = json.loads(links_path.read_text(encoding="utf-8")) if links_path.exists() else {}
    updated, changed = run(
        read_parts(args.data), known, mouser_search(api_key, args.timeout),
        today=date.today(), batch_size=args.batch, max_requests=args.max_requests,
        limit=args.limit, recheck_days=args.recheck_days, interval=args.interval,
    )
    if updated != known:
        links_path.write_text(json.dumps(updated, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"Wrote {display(links_path)}.")
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a", encoding="utf-8") as f:
            f.write(f"links={'changed' if changed else 'unchanged'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

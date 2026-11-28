#!/usr/bin/env python3
"""Download every datasheet from the manufacturers and build the datasheet site.

Run weekly by .github/workflows/sync-datasheets.yml. For each part's
datasheet_url (once per distinct link):

  1. Ask the manufacturer for the PDF. If we have its ETag/Last-Modified from
     last time, ask "only if changed" (a 304 reply means unchanged).
  2. Check the reply really is a PDF (%PDF near the start), not an HTML error
     or login page, and isn't over the size limit (25 MiB on Cloudflare Pages).
  3. Hash it (SHA-256). A new hash means a new version.
  4. If the download failed or was "not modified", copy the previous version
     from the live datasheet site by its hash instead.

Then it writes the COMPLETE datasheet site into --out (a Pages upload replaces
the whole site): datasheets/<sha256>.pdf for every current datasheet, plus
index.html and _headers.

Safety rule (CLAUDE.md: never lose data): if a datasheet that is on the site
today can't be included, nothing is written and the exit code is 2, so the
workflow stops before uploading.

Only after the workflow has uploaded the site does it commit the updated
data/datasheets.json and public/linecard.json (see the workflow), so the app
never points at a PDF that isn't online yet.

Exit codes: 0 ok (individual parts may still have failed; see the report),
1 bad data or arguments, 2 stopped to protect existing datasheets.

Usage:
  python3 tools/sync_datasheets.py --site-url https://rf-datasheets.pages.dev --out build/datasheet-site
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_linecard  # noqa: E402

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
MAX_BYTES = 25 * 1024 * 1024  # Cloudflare Pages: 25 MiB per file
OUTPUT_MARKER = ".sync-output"

HEADERS_FILE = """\
# Written by tools/sync_datasheets.py. Cloudflare Pages reads this file.
/datasheets/*
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=31536000, immutable
  Content-Type: application/pdf
"""
# Access-Control-Allow-Origin: * lets the app (and a local `npm run preview`)
# download the PDFs. They're public datasheets, so allowing any site is fine.
# "immutable": a hash URL's content never changes, so it can be cached forever.

INDEX_FILE = """<!doctype html>
<meta charset="utf-8">
<title>Datasheets</title>
<p>Datasheet files for the RF Line Card app.</p>
"""


class FetchError(Exception):
    """A download that failed for a reason worth reporting."""


@dataclass
class Fetcher:
    """HTTP GETs with a browser User-Agent, retries and a per-website pause."""

    timeout: float = 60.0
    min_interval: float = 2.0  # seconds between requests to the same website
    retries: int = 2
    retry_delays: tuple[float, ...] = (2.0, 5.0)
    max_bytes: int = MAX_BYTES
    _last_request: dict[str, float] = field(default_factory=dict)

    def _pause_for(self, url: str, interval: float) -> None:
        host = urlsplit(url).netloc
        wait = self._last_request.get(host, 0.0) + interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last_request[host] = time.monotonic()

    def get(
        self, url: str, headers: dict[str, str] | None = None, polite: bool = True
    ) -> tuple[int, bytes, dict[str, str]]:
        """Returns (status, body, headers). 304 has an empty body. Raises FetchError."""
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            self._pause_for(url, self.min_interval if polite else 0.0)
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    body = response.read(self.max_bytes + 1)
                    return response.status, body, dict(response.headers)
            except urllib.error.HTTPError as error:
                if error.code == 304:
                    return 304, b"", dict(error.headers)
                last_error = FetchError(f"HTTP {error.code}")
                if error.code < 500 and error.code != 429:
                    break  # 403, 404...: retrying won't help
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                reason = getattr(error, "reason", error)
                last_error = FetchError(f"connection failed ({reason})")
            if attempt < self.retries:
                time.sleep(self.retry_delays[min(attempt, len(self.retry_delays) - 1)])
        raise last_error or FetchError("unknown error")


DRIVE_ID = re.compile(r"(?:/file/d/|[?&]id=)([A-Za-z0-9_-]{10,})")


def download_url(url: str) -> str:
    """The address to download a datasheet from.

    A Google Drive share link ("drive.google.com/file/d/<id>/view") opens
    Drive's viewer page, not the PDF; its direct-download address is used
    instead. That lets the rep host a datasheet a manufacturer only hands out
    by request (upload to Drive, share "Anyone with the link", paste the link
    in the Sheet). Every other link is used as is.
    """
    host = urlsplit(url).netloc.lower()
    if host in ("drive.google.com", "docs.google.com"):
        match = DRIVE_ID.search(url)
        if match:
            return f"https://drive.google.com/uc?export=download&id={match.group(1)}"
    return url


def looks_like_pdf(body: bytes) -> bool:
    # The PDF header must be in the first 1024 bytes (PDF specification).
    return b"%PDF-" in body[:1024]


@dataclass
class Outcome:
    """What happened to one datasheet link."""

    url: str
    part_ids: list[str]
    mpns: list[str]
    status: str  # new | changed | unchanged | kept | too_big | missing
    sha: str | None = None
    bytes: int | None = None
    etag: str | None = None
    last_modified: str | None = None
    note: str = ""


def sync(
    parts: list[dict[str, Any]],
    records: dict[str, dict[str, Any]],
    site_url: str,
    fetcher: Fetcher,
    log=print,
) -> tuple[list[Outcome], dict[str, bytes]]:
    """Fetch everything. Returns (outcomes, files by sha). Writes nothing."""
    by_url: dict[str, list[dict[str, Any]]] = {}
    for part in parts:
        url = part["datasheet"].get("sourceUrl")
        if url:
            by_url.setdefault(url, []).append(part)

    files: dict[str, bytes] = {}
    outcomes: list[Outcome] = []
    for url, url_parts in by_url.items():
        ids = [p["id"] for p in url_parts]
        mpns = [p["mpn"] for p in url_parts]
        previous = next((records[i] for i in ids if i in records), None)
        outcome = Outcome(url=url, part_ids=ids, mpns=mpns, status="missing")

        conditional: dict[str, str] = {}
        if previous:
            if previous.get("etag"):
                conditional["If-None-Match"] = previous["etag"]
            if previous.get("lastModified"):
                conditional["If-Modified-Since"] = previous["lastModified"]

        body: bytes | None = None
        problem = ""
        try:
            status, data, headers = fetcher.get(download_url(url), conditional)
            if status == 304:
                problem = "not modified"
            elif len(data) > fetcher.max_bytes:
                outcome.status = "too_big"
                outcome.note = f"over {fetcher.max_bytes // (1024 * 1024)} MiB"
                outcomes.append(outcome)
                log(f"TOO BIG   {', '.join(mpns)}: {url}")
                continue
            elif not looks_like_pdf(data):
                problem = "the reply was not a PDF (an error or login page?)"
            else:
                body = data
                outcome.etag = headers.get("ETag") or headers.get("Etag")
                outcome.last_modified = headers.get("Last-Modified")
        except FetchError as error:
            problem = str(error)

        if body is not None:
            sha = hashlib.sha256(body).hexdigest()
            files[sha] = body
            outcome.sha, outcome.bytes = sha, len(body)
            if previous is None:
                outcome.status = "new"
            elif previous["sha256"] == sha:
                outcome.status = "unchanged"
            else:
                outcome.status = "changed"
            log(f"{outcome.status.upper():9} {', '.join(mpns)}")
        elif previous is not None:
            # Keep the version we already host: copy it from the live site.
            sha = previous["sha256"]
            kept = files.get(sha) or fetch_from_site(site_url, sha, fetcher)
            if kept is None:
                raise SystemExit(
                    f"STOPPED: {', '.join(mpns)} could not be downloaded ({problem}) and its current "
                    f"version {sha[:12]}... could not be copied from {site_url}. Uploading now would "
                    "remove it from the datasheet site, so nothing was changed."
                )
            files[sha] = kept
            outcome.sha, outcome.bytes = sha, len(kept)
            outcome.etag, outcome.last_modified = previous.get("etag"), previous.get("lastModified")
            outcome.status = "unchanged" if problem == "not modified" else "kept"
            outcome.note = "" if problem == "not modified" else problem
            log(f"{outcome.status.upper():9} {', '.join(mpns)}{'' if not outcome.note else ': ' + outcome.note}")
        else:
            outcome.note = problem
            log(f"MISSING   {', '.join(mpns)}: {problem}")
        outcomes.append(outcome)
    return outcomes, files


def fetch_from_site(site_url: str, sha: str, fetcher: Fetcher) -> bytes | None:
    """The hosted copy of a datasheet, checked against its hash, or None."""
    url = f"{site_url.rstrip('/')}/datasheets/{sha}.pdf"
    try:
        status, data, _ = fetcher.get(url, polite=False)
    except FetchError:
        return None
    if status != 200 or hashlib.sha256(data).hexdigest() != sha:
        return None
    return data


def new_records(
    outcomes: list[Outcome], records: dict[str, dict[str, Any]], today: str
) -> dict[str, dict[str, Any]]:
    """datasheets.json after this run. Parts no longer in the CSVs are dropped."""
    result: dict[str, dict[str, Any]] = {}
    for outcome in outcomes:
        if outcome.sha is None:
            continue  # missing or too big: no datasheet in the app
        for part_id in outcome.part_ids:
            previous = records.get(part_id)
            same = previous is not None and previous["sha256"] == outcome.sha
            record: dict[str, Any] = {
                "sha256": outcome.sha,
                "bytes": outcome.bytes,
                "updated": previous["updated"] if same else today,
            }
            # "changed": the day this part's datasheet was replaced by a
            # different file (drives the app's "Updated" badge). A datasheet
            # saved for the first time has none: a new part isn't "updated".
            if previous is not None and not same:
                record["changed"] = today
            elif same and previous.get("changed"):
                record["changed"] = previous["changed"]
            if outcome.etag:
                record["etag"] = outcome.etag
            if outcome.last_modified:
                record["lastModified"] = outcome.last_modified
            result[part_id] = record
    return dict(sorted(result.items()))


def output_problem(out: Path) -> str | None:
    """Why --out can't be used, or None. Never empty a folder we didn't create."""
    if out.exists() and any(out.iterdir()) and not (out / OUTPUT_MARKER).exists():
        return f"{out} already has files that weren't made by this script; refusing to empty it."
    return None


def prepare_output(out: Path) -> None:
    """Empty --out (already checked by output_problem) and mark it as ours."""
    if out.exists() and any(out.iterdir()):
        shutil.rmtree(out)
    (out / "datasheets").mkdir(parents=True, exist_ok=True)
    (out / OUTPUT_MARKER).write_text("Created by tools/sync_datasheets.py\n")


def write_site(out: Path, files: dict[str, bytes]) -> None:
    prepare_output(out)
    for sha, body in files.items():
        (out / "datasheets" / f"{sha}.pdf").write_bytes(body)
    (out / "_headers").write_text(HEADERS_FILE)
    (out / "index.html").write_text(INDEX_FILE)


def report_markdown(outcomes: list[Outcome], data_changed: bool) -> str:
    labels = {
        "new": "New",
        "changed": "Changed",
        "unchanged": "Unchanged",
        "kept": "Download failed, previous version kept",
        "too_big": "Too big for the datasheet site (app shows the manufacturer link)",
        "missing": "No datasheet (download failed, nothing to keep)",
    }
    counts = {key: 0 for key in labels}
    for outcome in outcomes:
        counts[outcome.status] += 1
    lines = ["## Datasheet sync", "", "| Result | Count |", "|---|---|"]
    lines += [f"| {labels[key]} | {count} |" for key, count in counts.items()]
    lines += ["", "Line card data changed: " + ("**yes**, linecard.json updated" if data_changed else "no")]
    for status in ("changed", "new", "kept", "too_big", "missing"):
        items = [o for o in outcomes if o.status == status]
        if items:
            lines += ["", f"### {labels[status]}"]
            lines += [
                f"- {', '.join(o.mpns)}: {o.url}" + (f" ({o.note})" if o.note else "") for o in items
            ]
    return "\n".join(lines) + "\n"


def visible(linecard: dict[str, Any]) -> str:
    """linecard.json without its dataVersion, for "did anything change?"."""
    return json.dumps({k: v for k, v in linecard.items() if k != "dataVersion"}, sort_keys=True)


def main(argv: list[str] | None = None) -> int:
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Download datasheets and build the datasheet site.")
    parser.add_argument("--data", type=Path, default=repo / "data")
    parser.add_argument("--linecard", type=Path, default=repo / "public" / "linecard.json")
    parser.add_argument("--site-url", required=True, help="the live datasheet site, e.g. https://rf-datasheets.pages.dev")
    parser.add_argument("--out", type=Path, required=True, help="folder to write the complete site into")
    parser.add_argument("--report", type=Path, help="also write the Markdown report here")
    parser.add_argument("--interval", type=float, default=2.0, help="seconds between requests to one website")
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument("--max-bytes", type=int, default=MAX_BYTES)
    parser.add_argument("--retries", type=int, default=2, help="extra tries after a failed download")
    args = parser.parse_args(argv)

    linecard, report = build_linecard.build(args.data, "sync")
    if linecard is None:
        for error in report.errors:
            print(f"error: {error}", file=sys.stderr)
        return 1
    if problem := output_problem(args.out):
        print(f"error: {problem}", file=sys.stderr)
        return 1
    records_path = args.data / "datasheets.json"
    records = json.loads(records_path.read_text(encoding="utf-8")) if records_path.exists() else {}

    fetcher = Fetcher(
        timeout=args.timeout, min_interval=args.interval, max_bytes=args.max_bytes, retries=args.retries
    )
    try:
        outcomes, files = sync(linecard["parts"], records, args.site_url, fetcher)
    except SystemExit as stop:
        print(stop, file=sys.stderr)
        return 2

    # Everything needed is in memory; only now write anything.
    write_site(args.out, files)
    now = datetime.now(timezone.utc)
    updated_records = new_records(outcomes, records, now.strftime("%Y-%m-%d"))
    if updated_records != records:
        records_path.write_text(json.dumps(updated_records, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    old = json.loads(args.linecard.read_text(encoding="utf-8")) if args.linecard.exists() else {}
    rebuilt, _ = build_linecard.build(args.data, old.get("dataVersion", ""))
    data_changed = rebuilt is not None and visible(rebuilt) != visible(old)
    if data_changed:
        build_linecard.main(
            ["--data", str(args.data), "--out", str(args.linecard),
             "--data-version", now.strftime("%Y-%m-%dT%H:%M:%SZ")]
        )

    text = report_markdown(outcomes, data_changed)
    print("\n" + text)
    if args.report:
        args.report.write_text(text, encoding="utf-8")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a", encoding="utf-8") as f:
            f.write(text)
    print(f"Site written to {build_linecard.display(args.out)}: {len(files)} PDFs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

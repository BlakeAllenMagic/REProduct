#!/usr/bin/env python3
"""Import the parts list from the Google Sheet.

  1. Download the whole sheet as one Excel file (every tab). The sheet is
     shared as "Anyone with the link can view", so no login is needed.
  2. Match each tab to a category in categories.yaml (by name or id; tabs
     starting with "_" are notes and are skipped) and each heading to a column.
  3. Convert the tabs to the CSVs the rest of the pipeline uses, and validate
     them with build_linecard.py, in a scratch folder.
  4. Valid and different from data/parts/: write the new CSVs (the snapshot).
     Valid and the same: change nothing.
     Problems: change no parts at all; record the problems in
     public/import-status.json, which the app shows under Settings.
     The status also holds the sheet's link ("sheetUrl"), so Settings can
     open the sheet. This publishes the link with the app (agreed: the sheet
     is view-only).

Messages use the sheet's words: "Filters tab, row 7: IL (dB): ...".

The status file is only rewritten when its content changes, so a 2-hourly
check of an unchanged sheet doesn't publish a new app version.

Result (also written to $GITHUB_OUTPUT as result=...):
  changed     new parts snapshot written; the sync should run
  unchanged   sheet matches the snapshot
  problems    the sheet has problems; nothing imported
Exit code 0 for all three (problems are reported through the app, not by
failing the job every 2 hours); 1 only if the sheet couldn't be read at all.

Usage:
  python3 tools/import_sheet.py --sheet "$GOOGLE_SHEET_URL"
  python3 tools/import_sheet.py --xlsx my-copy.xlsx      (a downloaded copy)
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.request
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_linecard  # noqa: E402
from sheet_columns import (  # noqa: E402
    category_for_tab,
    headings_for,
    is_notes_tab,
    key_for_heading,
)

try:
    from openpyxl import load_workbook
except ImportError:  # pragma: no cover
    sys.exit("openpyxl is not installed. Run: pip install -r tools/requirements.txt")

EXPORT_URL = "https://docs.google.com/spreadsheets/d/{id}/export?format=xlsx"
# The link the app shows under Settings > Parts sheet. Rebuilt from the id
# alone, so nothing else from the secret (tab, sharing parameters) is published.
EDIT_URL = "https://docs.google.com/spreadsheets/d/{id}/edit"
SHEET_ID = re.compile(r"/spreadsheets/d/([A-Za-z0-9_-]{20,})")


class SheetError(Exception):
    """The sheet couldn't be read at all."""


def sheet_id(value: str) -> str:
    """Accepts the full sheet link or just its id."""
    value = value.strip()
    match = SHEET_ID.search(value)
    if match:
        return match.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{20,}", value):
        return value
    raise SheetError("That doesn't look like a Google Sheet link (…/spreadsheets/d/<id>/…).")


def download(url: str, timeout: float = 60) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "rf-linecard-import/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = response.read()
    except urllib.error.HTTPError as error:
        if error.code in (401, 403, 404):
            raise SheetError(
                f"Google refused the download (HTTP {error.code}). Is the sheet shared as "
                '"Anyone with the link can view", and is GOOGLE_SHEET_URL the right link?'
            ) from error
        raise SheetError(f"Download failed (HTTP {error.code}).") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise SheetError(f"Download failed ({getattr(error, 'reason', error)}).") from error
    if not data.startswith(b"PK"):  # Excel files are zip files
        raise SheetError(
            "Google sent a web page instead of the spreadsheet. The sheet is probably not shared as "
            '"Anyone with the link can view".'
        )
    return data


def cell_text(value: Any) -> str:
    """A cell as the text the CSV tools expect: 6.0 -> "6", 0.6 -> "0.6"."""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return str(int(value)) if value.is_integer() else format(value, ".12g")
    return str(value).strip()


def read_tabs(
    xlsx: bytes, categories: list[dict[str, Any]], problems: list[str]
) -> dict[str, list[list[str]]]:
    """{category id: [header keys, row, row, ...]} with one CSV row per sheet row."""
    book = load_workbook(io.BytesIO(xlsx), read_only=True, data_only=True)
    found: dict[str, list[list[str]]] = {}
    tab_of: dict[str, str] = {}
    for sheet in book.worksheets:
        title = sheet.title
        if is_notes_tab(title):
            continue
        category = category_for_tab(title, categories)
        if category is None:
            names = ", ".join(c["name"] for c in categories)
            problems.append(
                f'Tab "{title}" doesn\'t match a product type in the app ({names}). Rename it, '
                'or start its name with "_" if it\'s a notes tab.'
            )
            continue
        if category["id"] in tab_of:
            problems.append(f'Tabs "{tab_of[category["id"]]}" and "{title}" are both {category["name"]}. Keep one.')
            continue
        tab_of[category["id"]] = title
        found[category["id"]] = convert_tab(title, category, list(sheet.iter_rows(values_only=True)), problems)

    for category in categories:
        if category["id"] not in tab_of:
            problems.append(f'No tab for {category["name"]}. Add a tab named "{category["name"]}".')
    return found


def convert_tab(
    title: str, category: dict[str, Any], rows: list[tuple], problems: list[str]
) -> list[list[str]]:
    # CSV column order stays as build_linecard expects, whatever the sheet's order.
    keys = build_linecard.FIXED_COLUMNS + [spec["key"] for spec in category["specs"]]
    friendly = dict(headings_for(category))
    header = list(rows[0]) if rows else []

    columns: dict[str, int] = {}  # key -> column index in the sheet
    for index, heading in enumerate(header):
        if heading is None or not str(heading).strip():
            if any(len(r) > index and r[index] not in (None, "") for r in rows[1:]):
                problems.append(f"{title} tab: column {index + 1} has values but no heading.")
            continue
        key = key_for_heading(heading, category)
        if key is None:
            known = ", ".join(friendly.values())
            problems.append(f'{title} tab: column "{heading}" isn\'t a known column. Known columns: {known}.')
        elif key in columns:
            problems.append(f'{title} tab: the "{friendly[key]}" column appears twice.')
        else:
            columns[key] = index

    required = set(build_linecard.REQUIRED_FIXED) | {s["key"] for s in category["specs"] if s.get("required")}
    for key in keys:
        if key in required and key not in columns:
            problems.append(f'{title} tab: the "{friendly[key]}" column is missing.')

    out = [keys]
    for row_number, row in enumerate(rows[1:], start=2):
        values = []
        for key in keys:
            index = columns.get(key)
            value = row[index] if index is not None and index < len(row) else None
            if isinstance(value, (datetime, date, time)):
                problems.append(
                    f"{title} tab, row {row_number}: {friendly[key]}: Google Sheets turned this into a date "
                    f"({value}). Format the column as Plain text and type it again."
                )
                value = None
            values.append(cell_text(value))
        out.append(values)
    while len(out) > 1 and not any(out[-1]):
        out.pop()  # trailing empty rows
    return out


def csv_text(rows: list[list[str]]) -> str:
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="\n").writerows(rows)
    return buffer.getvalue()


def sheet_words(message: str, categories: list[dict[str, Any]], parts_dir: Path) -> str:
    """'…/parts/filter.csv:7: insertion_loss_db: …' -> 'Filters tab, row 7: IL (dB): …'"""
    for category in categories:
        csv_name = re.escape(str(parts_dir / f"{category['id']}.csv"))
        message = re.sub(rf"^.*?{csv_name}:(\d+): ", lambda m: f"{category['name']} tab, row {m.group(1)}: ", message)
        message = re.sub(rf"^.*?{csv_name}:? ", f"{category['name']} tab: ", message)
        for key, heading in headings_for(category):
            message = re.sub(rf"\b{re.escape(key)}\b", heading, message)
    return message


def write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return True


def main(argv: list[str] | None = None) -> int:
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Import the parts list from the Google Sheet.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--sheet", help="the sheet's link or id (default: $GOOGLE_SHEET_URL)")
    source.add_argument("--xlsx", type=Path, help="read a downloaded copy instead")
    parser.add_argument("--data", type=Path, default=repo / "data")
    parser.add_argument("--status", type=Path, default=repo / "public" / "import-status.json")
    parser.add_argument("--export-url", help=argparse.SUPPRESS)  # tests: a local fake Google
    args = parser.parse_args(argv)

    # 1. Read the sheet.
    sheet_url: str | None = None
    try:
        if args.xlsx:
            xlsx = args.xlsx.read_bytes()
        else:
            sid = sheet_id(args.sheet)
            sheet_url = EDIT_URL.format(id=sid)
            url = args.export_url or EXPORT_URL.format(id=sid)
            xlsx = download(url)
    except SheetError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    report = build_linecard.Report()
    categories = build_linecard.load_categories(args.data / "categories.yaml", report)
    if report.errors:
        print("\n".join(report.errors), file=sys.stderr)
        return 1

    # 2-3. Convert and validate in a scratch copy of data/.
    problems: list[str] = []
    try:
        tabs = read_tabs(xlsx, categories, problems)
    except Exception as error:  # a corrupt file, not a sheet mistake
        print(f"error: couldn't read the spreadsheet file ({error})", file=sys.stderr)
        return 1
    warnings: list[str] = []
    new_csvs = {cid: csv_text(rows) for cid, rows in tabs.items()}
    with tempfile.TemporaryDirectory() as scratch:
        trial = Path(scratch) / "data"
        shutil.copytree(args.data, trial, ignore=shutil.ignore_patterns("parts"))
        for cid, text in new_csvs.items():
            write_if_changed(trial / "parts" / f"{cid}.csv", text)
        if not problems:
            _, check = build_linecard.build(trial, "import-check")
            problems += [sheet_words(e, categories, trial / "parts") for e in check.errors]
            warnings += [
                sheet_words(w, categories, trial / "parts")
                for w in check.warnings
                if "datasheets.json" not in w  # the sync tidies those records
            ]

    # 4. Publish, or record why not.
    old_status = json.loads(args.status.read_text(encoding="utf-8")) if args.status.exists() else {}
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if problems:
        result = "problems"
        status = {"ok": False, "problems": problems, "warnings": warnings,
                  "importedAt": old_status.get("importedAt")}
    else:
        changed = [cid for cid, text in new_csvs.items()
                   if write_if_changed(args.data / "parts" / f"{cid}.csv", text)]
        result = "changed" if changed else "unchanged"
        status = {"ok": True, "problems": [], "warnings": warnings,
                  "importedAt": now if changed else old_status.get("importedAt")}
    # A downloaded copy (--xlsx) keeps the link from the last real import.
    status["sheetUrl"] = sheet_url or old_status.get("sheetUrl")
    # Only rewrite the status when what it says changes (see the docstring).
    if status != old_status:
        args.status.parent.mkdir(parents=True, exist_ok=True)
        args.status.write_text(json.dumps(status, indent=2) + "\n", encoding="utf-8")

    summary = {
        "changed": "Sheet changed: new parts snapshot written.",
        "unchanged": "Sheet unchanged.",
        "problems": f"The sheet has {len(problems)} problem(s); nothing was imported:",
    }[result]
    lines = [summary] + [f"- {p}" for p in problems] + [f"- warning: {w}" for w in warnings]
    print("\n".join(lines))
    if out := os.environ.get("GITHUB_OUTPUT"):
        with open(out, "a", encoding="utf-8") as f:
            f.write(f"result={result}\n")
    if step := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(step, "a", encoding="utf-8") as f:
            f.write("## Parts sheet import\n\n" + "\n".join(lines) + "\n\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

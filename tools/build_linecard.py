#!/usr/bin/env python3
"""Validate the line card data and generate public/linecard.json.

Inputs (all under --data, default "data/"):
  categories.yaml     category definitions and their spec columns
  parts/<id>.csv      one CSV per category, edited by hand in Numbers or Excel
  datasheets.json     datasheet hash records, written by tools/sync_datasheets.py

Output:
  public/linecard.json, the only data file the app reads.

Every problem found is collected and printed together, so one run shows
everything that needs fixing. If there is any error, the output file is left
untouched, so a bad CSV edit can never replace a good linecard.json.

Usage:
  python3 tools/build_linecard.py            # validate and write
  python3 tools/build_linecard.py --check    # validate only
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is not installed. Run: pip install -r tools/requirements.txt")

FIXED_COLUMNS = ["manufacturer", "mpn", "description", "datasheet_url"]
REQUIRED_FIXED = {"manufacturer", "mpn", "datasheet_url"}

CATEGORY_FIELDS = {"id", "name", "blocks", "specs"}
SPEC_FIELDS = {"key", "label", "unit", "type", "sort", "required"}
SPEC_TYPES = {"number", "text"}
SORT_DIRECTIONS = {"asc", "desc"}

ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# A number, optionally followed by a unit: "0.6", "-3", "1e3", "0.6 dB", "6GHz".
NUMBER_RE = re.compile(
    r"^(?P<num>[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*(?P<unit>\S+)?$"
)


def display(path: Path) -> str:
    """Show paths relative to the current directory, so messages stay short."""
    try:
        return os.path.relpath(path)
    except ValueError:  # different drive on Windows
        return str(path)


@dataclass
class Report:
    """Collects errors and warnings instead of stopping at the first one."""

    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def error(self, where: str, message: str) -> None:
        self.errors.append(f"{where}: {message}")

    def warn(self, where: str, message: str) -> None:
        self.warnings.append(f"{where}: {message}")


# ---------------------------------------------------------------------------
# categories.yaml
# ---------------------------------------------------------------------------


def load_categories(path: Path, report: Report) -> list[dict[str, Any]]:
    """Read and validate categories.yaml. Returns [] if it can't be used."""
    where = display(path)
    try:
        with path.open(encoding="utf-8") as f:
            doc = yaml.safe_load(f)
    except FileNotFoundError:
        report.error(where, "file not found")
        return []
    except yaml.YAMLError as exc:
        report.error(where, f"not valid YAML: {exc}")
        return []

    if not isinstance(doc, dict) or not isinstance(doc.get("categories"), list):
        report.error(where, 'top level must be a mapping with a "categories" list')
        return []

    categories: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, cat in enumerate(doc["categories"], start=1):
        cat_where = f"{where}: category #{index}"
        if not isinstance(cat, dict):
            report.error(cat_where, "must be a mapping")
            continue
        cat_id = cat.get("id")
        if isinstance(cat_id, str):
            cat_where = f"{where}: category {cat_id!r}"

        ok = True
        for unknown in sorted(set(cat) - CATEGORY_FIELDS):
            report.error(cat_where, f"unknown field {unknown!r}")
            ok = False
        if not isinstance(cat_id, str) or not ID_RE.match(cat_id):
            report.error(cat_where, "id must be lowercase letters, digits or _")
            ok = False
        elif cat_id in seen_ids:
            report.error(cat_where, "duplicate category id")
            ok = False
        else:
            seen_ids.add(cat_id)
        if not isinstance(cat.get("name"), str) or not cat["name"].strip():
            report.error(cat_where, "name is required")
            ok = False
        blocks = cat.get("blocks")
        if not isinstance(blocks, list) or not all(
            isinstance(b, str) and ID_RE.match(b) for b in blocks
        ):
            report.error(cat_where, "blocks must be a list of block ids")
            ok = False

        specs = _load_specs(cat.get("specs"), cat_where, report)
        if specs is None:
            ok = False
        if ok:
            categories.append(
                {"id": cat_id, "name": cat["name"].strip(), "blocks": blocks, "specs": specs}
            )
    return categories


def _load_specs(
    raw: Any, where: str, report: Report
) -> list[dict[str, Any]] | None:
    if not isinstance(raw, list) or not raw:
        report.error(where, "specs must be a non-empty list")
        return None

    specs: list[dict[str, Any]] = []
    seen: set[str] = set()
    ok = True
    for index, spec in enumerate(raw, start=1):
        spec_where = f"{where}: spec #{index}"
        if not isinstance(spec, dict):
            report.error(spec_where, "must be a mapping")
            ok = False
            continue
        key = spec.get("key")
        if isinstance(key, str):
            spec_where = f"{where}: spec {key!r}"
        for unknown in sorted(set(spec) - SPEC_FIELDS):
            report.error(spec_where, f"unknown field {unknown!r}")
            ok = False
        if not isinstance(key, str) or not ID_RE.match(key):
            report.error(spec_where, "key must be lowercase letters, digits or _")
            ok = False
        elif key in FIXED_COLUMNS:
            report.error(spec_where, f"key {key!r} is reserved for a fixed column")
            ok = False
        elif key in seen:
            report.error(spec_where, "duplicate spec key")
            ok = False
        else:
            seen.add(key)
        if not isinstance(spec.get("label"), str) or not spec["label"].strip():
            report.error(spec_where, "label is required")
            ok = False
        spec_type = spec.get("type")
        if spec_type not in SPEC_TYPES:
            report.error(spec_where, "type must be number or text")
            ok = False
        unit = spec.get("unit")
        if spec_type == "text" and unit is not None:
            report.error(spec_where, "text specs can't have a unit")
            ok = False
        if unit is not None and (not isinstance(unit, str) or not unit.strip() or " " in unit):
            report.error(spec_where, "unit must be a single word like GHz or dB")
            ok = False
        if "sort" in spec and spec["sort"] not in SORT_DIRECTIONS:
            report.error(spec_where, "sort must be asc or desc")
            ok = False
        if "required" in spec and not isinstance(spec["required"], bool):
            report.error(spec_where, "required must be true or false")
            ok = False

        specs.append(
            {
                "key": key,
                "label": spec.get("label", ""),
                "unit": unit,
                "type": spec_type,
                "sort": spec.get("sort"),
                "required": spec.get("required", False),
            }
        )
    return specs if ok else None


# ---------------------------------------------------------------------------
# parts/<category>.csv
# ---------------------------------------------------------------------------


def parse_number(text: str, unit: str | None) -> tuple[float | int | None, str | None]:
    """Parse "0.6" or "0.6 dB". Returns (value, None) or (None, error message)."""
    match = NUMBER_RE.match(text)
    if not match:
        return None, f"{text!r} is not a number"
    given_unit = match.group("unit")
    if given_unit is not None and given_unit != unit:
        expected = unit if unit else "no unit"
        return None, f"{text!r} has unit {given_unit}, expected {expected}"
    value = float(match.group("num"))
    return (int(value) if value.is_integer() else value), None


_MONTH = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
# Patterns Excel produces when it "helpfully" converts a text cell, and then
# writes back when the CSV is saved. Each matches the whole cell.
EXCEL_DAMAGE = [
    # "MAR-1" becomes "1-Mar", "MAR-10" becomes "Mar-10". Excel writes the month
    # as "Mar", so a real all-caps "MAR-10" is not flagged.
    (re.compile(rf"^\d{{1,2}}-{_MONTH}(?:-\d{{2,4}})?$"), "looks like a date Excel created"),
    (re.compile(rf"^{_MONTH}-\d{{2,4}}$"), "looks like a date Excel created"),
    (re.compile(r"^\d{1,2}/\d{1,2}/\d{2,4}$"), "looks like a date Excel created"),
    # "2E10" becomes "2.00E+10".
    (re.compile(r"^\d+(?:\.\d+)?E\+\d+$", re.IGNORECASE), "looks like scientific notation Excel created"),
]
# Chip sizes like 0201, 0402, 0603 lose their leading zero: "0603" becomes "603".
PACKAGE_LOST_ZERO = re.compile(r"^\d{3}$")


def excel_damage_hint(key: str, text: str) -> str | None:
    """Return a warning if a text cell looks like Excel converted it, else None.

    These are warnings, not errors: the value is valid text, it just might not
    be what was originally typed. Compare against `git diff` to be sure.
    """
    for pattern, reason in EXCEL_DAMAGE:
        if pattern.match(text):
            return f"{text!r} {reason}. Check it against the datasheet"
    if key == "package" and PACKAGE_LOST_ZERO.match(text):
        return f"{text!r} looks like Excel removed a leading zero (was it '0{text}'?)"
    return None


def make_part_id(manufacturer: str, mpn: str) -> str:
    """'Acme RF' + 'ALM-1234' -> 'acme-alm1234' (first word of the maker + the MPN)."""
    maker = re.sub(r"[^a-z0-9]", "", manufacturer.split()[0].lower())
    part = re.sub(r"[^a-z0-9]", "", mpn.lower())
    return f"{maker}-{part}"


def read_parts(
    path: Path,
    category: dict[str, Any],
    report: Report,
    seen_mpns: dict[tuple[str, str], str],
    seen_ids: dict[str, str],
) -> list[dict[str, Any]]:
    """Read and validate one category's CSV."""
    where = display(path)
    specs = {s["key"]: s for s in category["specs"]}
    expected = FIXED_COLUMNS + list(specs)

    try:
        # utf-8-sig quietly drops the byte-order mark that Excel adds.
        with path.open(encoding="utf-8-sig", newline="") as f:
            rows = list(csv.reader(f))
    except FileNotFoundError:
        report.error(where, f"missing CSV for category {category['id']!r}")
        return []
    except UnicodeDecodeError:
        report.error(where, 'not UTF-8. In Excel or Numbers, export as "CSV UTF-8"')
        return []

    if not rows:
        report.error(where, "file is empty, expected a header row")
        return []

    header = [h.strip() for h in rows[0]]
    header_ok = True
    for col in header:
        if col and col not in expected:
            report.error(f"{where}:1", f"unknown column {col!r}")
            header_ok = False
    for col in expected:
        if col not in header:
            report.error(f"{where}:1", f"missing column {col!r}")
            header_ok = False
    duplicates = sorted({c for c in header if c and header.count(c) > 1})
    for col in duplicates:
        report.error(f"{where}:1", f"column {col!r} appears more than once")
        header_ok = False
    if not header_ok:
        return []

    parts: list[dict[str, Any]] = []
    for line_no, row in enumerate(rows[1:], start=2):
        if not any(cell.strip() for cell in row):
            continue  # blank line, common at the end of a spreadsheet export
        row_where = f"{where}:{line_no}"
        if len(row) > len(header) and any(c.strip() for c in row[len(header):]):
            report.error(row_where, "more cells than header columns")
            continue
        cells = {col: (row[i].strip() if i < len(row) else "") for i, col in enumerate(header)}

        # Check for duplicates before the per-cell checks, so a duplicate is
        # still reported even when the first copy has other errors.
        unique = True
        maker, mpn = cells["manufacturer"], cells["mpn"]
        if maker and mpn:
            mpn_key = (maker.casefold(), mpn.casefold())
            part_id = make_part_id(maker, mpn)
            if mpn_key in seen_mpns:
                report.error(
                    row_where, f"duplicate part {maker} {mpn} (first seen at {seen_mpns[mpn_key]})"
                )
                unique = False
            elif part_id in seen_ids:
                report.error(
                    row_where,
                    f"part id {part_id!r} clashes with {seen_ids[part_id]}. "
                    "Two different parts produce the same id",
                )
                unique = False
            else:
                seen_mpns[mpn_key] = row_where
                seen_ids[part_id] = row_where

        part = _build_part(cells, specs, category["id"], row_where, report)
        if part is not None and unique:
            parts.append(part)
    return parts


def _build_part(
    cells: dict[str, str],
    specs: dict[str, dict[str, Any]],
    category_id: str,
    where: str,
    report: Report,
) -> dict[str, Any] | None:
    ok = True
    for col in FIXED_COLUMNS:
        if col in REQUIRED_FIXED and not cells[col]:
            report.error(where, f"{col} is required")
            ok = False
    url = cells["datasheet_url"]
    # http:// is allowed only for this machine, which the sync tests use.
    if url and not url.startswith(("https://", "http://127.0.0.1", "http://localhost")):
        report.error(where, f"datasheet_url must start with https:// (got {url!r})")
        ok = False

    text_columns = ["manufacturer", "mpn", "description"] + [
        k for k, s in specs.items() if s["type"] == "text"
    ]
    for col in text_columns:
        hint = excel_damage_hint(col, cells[col]) if cells[col] else None
        if hint:
            report.warn(where, f"{col}: {hint}")

    values: dict[str, Any] = {}
    for key, spec in specs.items():
        text = cells[key]
        if not text:
            if spec["required"]:
                report.error(where, f"{key} is required")
                ok = False
            continue
        if spec["type"] == "number":
            value, problem = parse_number(text, spec["unit"])
            if problem:
                report.error(where, f"{key}: {problem}")
                ok = False
                continue
            values[key] = value
        else:
            values[key] = text

    if not ok:
        return None
    return {
        "id": make_part_id(cells["manufacturer"], cells["mpn"]),
        "category": category_id,
        "manufacturer": cells["manufacturer"],
        "mpn": cells["mpn"],
        "description": cells["description"],
        "specs": values,
        "datasheet": {"sourceUrl": url},
    }


# ---------------------------------------------------------------------------
# datasheets.json
# ---------------------------------------------------------------------------


def load_datasheet_records(path: Path, report: Report) -> dict[str, dict[str, Any]]:
    """Read the hash records written by sync_datasheets.py. Missing file = none yet."""
    where = display(path)
    if not path.exists():
        return {}
    try:
        with path.open(encoding="utf-8") as f:
            doc = json.load(f)
    except json.JSONDecodeError as exc:
        report.error(where, f"not valid JSON: {exc}")
        return {}
    if not isinstance(doc, dict):
        report.error(where, "must be an object keyed by part id")
        return {}

    records: dict[str, dict[str, Any]] = {}
    for part_id, rec in doc.items():
        rec_where = f"{where}: {part_id}"
        if not isinstance(rec, dict):
            report.error(rec_where, "must be an object")
            continue
        sha = rec.get("sha256")
        size = rec.get("bytes")
        updated = rec.get("updated")
        ok = True
        if not isinstance(sha, str) or not SHA256_RE.match(sha):
            report.error(rec_where, "sha256 must be 64 lowercase hex characters")
            ok = False
        if not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            report.error(rec_where, "bytes must be a positive whole number")
            ok = False
        if not isinstance(updated, str) or not DATE_RE.match(updated):
            report.error(rec_where, "updated must be a date like 2026-10-02")
            ok = False
        if ok:
            records[part_id] = {"sha256": sha, "bytes": size, "updated": updated}
    return records


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


def build(data_dir: Path, data_version: str) -> tuple[dict[str, Any] | None, Report]:
    """Validate everything under data_dir. Returns (linecard, report).

    linecard is None when there are errors.
    """
    report = Report()
    categories = load_categories(data_dir / "categories.yaml", report)
    if report.errors:
        # Without valid categories the CSVs can't be checked meaningfully.
        return None, report

    parts_dir = data_dir / "parts"
    known = {c["id"] for c in categories}
    if parts_dir.is_dir():
        for csv_path in sorted(parts_dir.glob("*.csv")):
            if csv_path.stem not in known:
                report.error(display(csv_path), "no category with this id in categories.yaml")

    seen_mpns: dict[tuple[str, str], str] = {}
    seen_ids: dict[str, str] = {}
    parts: list[dict[str, Any]] = []
    for category in categories:
        parts += read_parts(
            parts_dir / f"{category['id']}.csv", category, report, seen_mpns, seen_ids
        )

    records = load_datasheet_records(data_dir / "datasheets.json", report)
    for part in parts:
        rec = records.get(part["id"])
        part["datasheet"].update(
            {
                "file": f"datasheets/{rec['sha256']}.pdf" if rec else None,
                "sha256": rec["sha256"] if rec else None,
                "bytes": rec["bytes"] if rec else None,
                "updated": rec["updated"] if rec else None,
            }
        )
    for stale in sorted(set(records) - set(seen_ids)):
        report.warn(display(data_dir / "datasheets.json"), f"record for unknown part {stale!r}")

    if report.errors:
        return None, report

    order = {c["id"]: i for i, c in enumerate(categories)}
    parts.sort(
        key=lambda p: (order[p["category"]], p["manufacturer"].casefold(), p["mpn"].casefold())
    )
    linecard = {
        "dataVersion": data_version,
        "categories": [_category_output(c) for c in categories],
        "parts": parts,
    }
    return linecard, report


def _category_output(category: dict[str, Any]) -> dict[str, Any]:
    specs = []
    for s in category["specs"]:
        out: dict[str, Any] = {"key": s["key"], "label": s["label"]}
        if s["unit"]:
            out["unit"] = s["unit"]
        out["type"] = s["type"]
        if s["sort"]:
            out["sort"] = s["sort"]
        specs.append(out)
    return {
        "id": category["id"],
        "name": category["name"],
        "blocks": category["blocks"],
        "specs": specs,
    }


def write_atomic(path: Path, content: str) -> None:
    """Write to a temp file, then rename over the target.

    The rename is atomic, so a crash halfway never leaves a half-written file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main(argv: list[str] | None = None) -> int:
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data", type=Path, default=repo / "data", help="data directory")
    parser.add_argument(
        "--out", type=Path, default=repo / "public" / "linecard.json", help="output file"
    )
    parser.add_argument("--check", action="store_true", help="validate only, write nothing")
    parser.add_argument(
        "--data-version",
        default=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        help="dataVersion value (default: current UTC time)",
    )
    args = parser.parse_args(argv)

    linecard, report = build(args.data, args.data_version)

    for warning in report.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    if linecard is None:
        for error in report.errors:
            print(f"error: {error}", file=sys.stderr)
        count = len(report.errors)
        print(
            f"\n{count} error{'s' if count != 1 else ''}. {display(args.out)} was not changed.",
            file=sys.stderr,
        )
        return 1

    counts: dict[str, int] = {}
    for part in linecard["parts"]:
        counts[part["category"]] = counts.get(part["category"], 0) + 1
    summary = ", ".join(f"{c['id']} {counts.get(c['id'], 0)}" for c in linecard["categories"])
    total = len(linecard["parts"])

    if args.check:
        print(f"OK: {total} parts ({summary}). Nothing written (--check).")
        return 0
    write_atomic(args.out, json.dumps(linecard, indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {display(args.out)}: {total} parts ({summary}), dataVersion {args.data_version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

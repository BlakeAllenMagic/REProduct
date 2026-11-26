#!/usr/bin/env python3
"""Turn Marki Microwave's product catalogs (PDF) into the parts sheet.

Reads the catalog tables (read_catalog.py), maps each family to one of the
product types (catalog_rules.py), and writes:
  <data-out>/categories.yaml      the product types and their spec columns
  <data-out>/parts/<type>.csv     one row per part, in the import's format
  <sheet-out>                     the Excel file to import into the Google Sheet,
                                  with a _Review tab listing rows to check by hand

Catalog values are typical values, copied as printed. Rows that look wrong
(edges out of order, a value that isn't a number) are flagged, never "fixed".

Usage (catalogs downloaded from markimicrowave.com first):
  python3 tools/marki/extract_catalogs.py CONNECTORIZED.pdf SMT_DIE.pdf \\
      --data-out build/marki-data --sheet-out build/marki-parts.xlsx
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import catalog_rules as rules  # noqa: E402
from read_catalog import read_tables, rows_as_dicts  # noqa: E402

FIXED = ["manufacturer", "mpn", "description", "datasheet_url", "product_url"]
PRODUCT_PAGE_PREFIXES = ("https://www.markimicrowave.com/", "https://markimicrowave.com/")
IGNORED_HEADINGS = {"Package", "ECCN"}  # handled by the common Case and ECCN columns


def all_specs(type_id: str) -> list[dict[str, Any]]:
    return rules.COMMON_FIRST + rules.TYPE_SPECS[type_id] + rules.COMMON_LAST


def fmt(number: Any) -> str:
    return "" if number is None else str(number)


def describe(table_name: str, family: str, record: dict[str, str]) -> str:
    """'Fixed filters, Bandpass, 21.9 to 26 GHz'."""
    words = [table_name] + ([family] if family and family != table_name else [])
    for base in ("pass", "freq", "rf_lo", "output", "tune"):
        lo, hi = record.get(f"{base}_min_ghz", ""), record.get(f"{base}_max_ghz", "")
        lo = "DC" if lo == "0" else lo
        if lo and hi:
            words.append(f"{lo} to {hi} GHz" if lo != hi else f"{lo} GHz")
            break
        if lo or hi:
            words.append(f"from {lo} GHz" if lo else f"up to {hi} GHz")
            break
    else:
        if record.get("freq_ghz"):
            words.append(f"{record['freq_ghz']} GHz")
    return ", ".join(words)


def fill_row(type_id: str, family: str, cells: dict[str, str], review: list[str]) -> dict[str, str]:
    """One part's spec values from its catalog cells (already split per variant)."""
    record: dict[str, str] = {}
    used: set[str] = set()
    notes: list[str] = []

    def take(*sources: str) -> tuple[str | None, str]:
        for source in sources:
            if source in cells and rules.clean_value(cells[source]):
                used.add(source)
                return source, rules.clean_value(cells[source])
        for source in sources:
            used.add(source) if source in cells else None
        return None, ""

    for s in rules.TYPE_SPECS[type_id]:
        key = s["key"]
        if "range_of" in s:
            if key in record:
                continue
            source, raw = take(*s["range_of"])
            lo, hi = rules.parse_range(raw)
            base = key.rsplit("_", 2)[0]
            if raw and lo is None:
                notes.append(f"{source}: {raw}")
            record[f"{base}_min_ghz"], record[f"{base}_max_ghz"] = fmt(lo), fmt(hi)
            continue
        if not s["sources"]:
            continue
        source, raw = take(*s["sources"])
        if s["type"] == "text":
            record[key] = raw
            continue
        number = rules.as_number(raw)
        if raw and number is None:
            notes.append(f"{s['label']}: {raw}")
        record[key] = fmt(number)

    if type_id == "filter":
        lo = hi = None
        if any(h in cells for h in ("F3dBc Low (GHz)", "F3dBc High (GHz)")):
            lo, hi = rules.filter_pass_band(family, cells)
        elif "3dBc Passband (GHz)" in cells:
            used.add("3dBc Passband (GHz)")
            lo, hi = rules.parse_range(cells["3dBc Passband (GHz)"])
        elif "1dBc Passband (GHz)" in cells:
            used.add("1dBc Passband (GHz)")
            lo, hi = rules.parse_range(cells["1dBc Passband (GHz)"])
            review.append("Pass Min/Max are the 1 dB edges (the catalog gives no 3 dB edges for this part)")
        record["pass_min_ghz"], record["pass_max_ghz"] = fmt(lo), fmt(hi)
    if type_id == "diplexer":
        bands: list[tuple[Any, Any]] = []
        if "LPF F Min (GHz)" in cells:
            used.update({"LPF F Min (GHz)", "LPF F Max (GHz)", "HPF F Min (GHz)", "HPF F Max (GHz)"})
            bands = [
                (rules.as_number(cells.get("LPF F Min (GHz)", "")), rules.as_number(cells.get("LPF F Max (GHz)", ""))),
                (rules.as_number(cells.get("HPF F Min (GHz)", "")), rules.as_number(cells.get("HPF F Max (GHz)", ""))),
            ]
        elif "Passband Low (GHz)" in cells:
            used.update({"Passband Low (GHz)", "Passband High (GHz)"})
            bands = [rules.parse_range(cells.get("Passband Low (GHz)", "")),
                     rules.parse_range(cells.get("Passband High (GHz)", ""))]
        elif "Passband (GHz)" in cells:
            used.add("Passband (GHz)")
            pieces = [p.strip() for p in cells["Passband (GHz)"].split("/")]
            bands = [rules.parse_range(p) for p in pieces]
            if len(pieces) > 2:
                notes.append(f"Passband: {cells['Passband (GHz)']}")
                review.append(f"{len(pieces)} passbands; the band columns hold the first two, Notes has all")
        for name, (lo, hi) in zip(("low", "high"), bands):
            record[f"{name}_min_ghz"], record[f"{name}_max_ghz"] = fmt(lo), fmt(hi)

    for heading, value in cells.items():
        if heading not in used and heading not in IGNORED_HEADINGS and rules.clean_value(value):
            notes.append(f"{heading or 'Unlabelled'}: {rules.clean_value(value)}")
    record["case"] = rules.clean_value(cells.get("Package", ""))
    record["eccn"] = rules.clean_value(cells.get("ECCN", ""))
    record["notes"] = "; ".join(notes)
    if notes:
        review.append("Some values aren't plain numbers; kept in Notes: " + record["notes"])
    return record


def extract(catalogs: list[Path]) -> tuple[dict[str, list[dict[str, str]]], list[list[str]]]:
    parts: dict[str, list[dict[str, str]]] = {t: [] for t in rules.PRODUCT_TYPES}
    review: list[list[str]] = []
    seen: dict[str, str] = {}
    for catalog in catalogs:
        last_header: dict[tuple[Any, str], list[dict[str, Any]]] = {}
        for table in read_tables(catalog):
            found = rules.product_type_for(table.title)
            if not found or not table.rows:
                continue
            type_id, family = found
            title = table.title.replace("(cont.)", "").strip()
            header = table.header or last_header.get((table.section, title), [])
            if table.header:
                last_header[(table.section, title)] = table.header
            package = rules.SECTION_TO_PACKAGE.get(table.section or "", table.section or "")
            table_name = rules.sentence_case(title.partition(",")[0])
            tab = rules.PRODUCT_TYPES[type_id][0]
            where = f"{catalog.name} p{table.page}"
            for row in rows_as_dicts(table, header):
                cells = {rules.HEADING_FIXES.get(h, h): v for h, v in row["values"].items()}
                printed = rules.clean_part_number(row["part"])
                variants = rules.expand_variants(printed)
                if "(" in printed and len(variants) == 1 and "(M-F)" not in printed:
                    review.append([tab, printed, where, "Part number has an optional part in brackets; "
                                   "check the exact orderable part numbers"])
                if "/" in printed and "(" not in printed:
                    review.append([tab, printed, where, "Part number lists two versions; split it by hand if needed"])
                for index, mpn in enumerate(variants):
                    split = {h: rules.split_variant_value(v, len(variants))[index] for h, v in cells.items()}
                    problems: list[str] = []
                    record = fill_row(type_id, family, split, problems)
                    record.update({
                        "manufacturer": rules.MANUFACTURER,
                        "mpn": mpn,
                        "datasheet_url": "",
                        "product_url": row["link"] if (row["link"] or "").startswith(PRODUCT_PAGE_PREFIXES) else "",
                        "family": family,
                        "package": package,
                    })
                    record["description"] = describe(table_name, family, record)
                    numbers = {k: rules.as_number(v) for k, v in record.items()}
                    problems += rules.sanity_problems(type_id, {k: v for k, v in numbers.items() if v is not None})
                    if mpn in seen:
                        review.append([tab, mpn, where, f"Listed twice; kept the first ({seen[mpn]})"])
                        continue
                    seen[mpn] = where
                    parts[type_id].append(record)
                    if problems:
                        review.append([tab, mpn, where, "; ".join(problems)])
    return parts, review


def categories_yaml(parts: dict[str, list[dict[str, str]]], header_comment: str) -> str:
    lines = [header_comment.rstrip(), "", "categories:"]
    for type_id, (name, blocks) in rules.PRODUCT_TYPES.items():
        lines += [f"  - id: {type_id}", f"    name: {json.dumps(name)}", f"    blocks: [{', '.join(blocks)}]", "    specs:"]
        for s in all_specs(type_id):
            # Drop columns no part of this type uses (keeps the table narrow), but always keep Family/Package.
            if s["key"] not in ("family", "package") and not any(p.get(s["key"]) for p in parts[type_id]):
                continue
            fields = [f"key: {s['key']}", f"label: {json.dumps(s['label'], ensure_ascii=False)}"]
            if s["unit"]:
                fields.append(f"unit: {json.dumps(s['unit'], ensure_ascii=False)}")
            fields.append(f"type: {s['type']}")
            direction = rules.sort_direction(s["label"]) if s["type"] == "number" else None
            if direction:
                fields.append(f"sort: {direction}")
            lines.append("      - { " + ", ".join(fields) + " }")
        lines.append("")
    return "\n".join(lines)


HEADER_COMMENT = """# Categories (product types) on the line card.
#
# Generated for Marki Microwave's line by tools/marki/extract_catalogs.py, then kept by hand.
# Each category is one tab in the parts sheet (Google Sheet); the import writes data/parts/<id>.csv.
#
# Fields:
#   id        short lowercase name, also the CSV file name
#   name      shown in the app, and the sheet tab's name
#   blocks    ids of diagram blocks that open this category
#   specs     the spec columns, in the order the parts table shows them
#     key       CSV column name (never shown to customers, safe to keep stable)
#     label     column heading in the app
#     type      number or text
#     unit      number columns only. Cells may be "0.6" or "0.6 dB", never another unit
#     sort      optional: asc (lower is better) or desc (higher is better)
#     required  optional: true means every part must have a value
#
# After editing, run: python3 tools/build_linecard.py
"""

READ_ME_EXTRA = [
    "",
    "Where these parts came from:",
    "  Marki Microwave's September 2026 product catalogs (connectorized/waveguide and surface mount/die),",
    "  read by tools/marki/extract_catalogs.py. Values are the catalog's TYPICAL values, as printed.",
    "  Filters: Pass Min and Max are the 3 dB edges. Lowpass filters start at 0 (DC);",
    "  highpass filters have no Pass Max in the catalog.",
    "  Values that aren't a plain number (like 24/22 or > 30) are kept in the Notes column.",
    "  The _Review tab lists rows worth checking against the datasheet. Delete it once done.",
]


def write_data(parts: dict[str, list[dict[str, str]]], out: Path) -> None:
    (out / "parts").mkdir(parents=True, exist_ok=True)
    yaml_text = categories_yaml(parts, HEADER_COMMENT)
    (out / "categories.yaml").write_text(yaml_text, encoding="utf-8")
    import yaml  # only to read back the column list we just wrote

    for category in yaml.safe_load(yaml_text)["categories"]:
        keys = FIXED + [s["key"] for s in category["specs"]]
        with (out / "parts" / f"{category['id']}.csv").open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(parts[category["id"]])


def write_sheet(data: Path, sheet: Path, review: list[list[str]]) -> None:
    import export_sheet_template
    from openpyxl import load_workbook
    from openpyxl.styles import Font

    if export_sheet_template.main(["--data", str(data), "--out", str(sheet)]) != 0:
        raise SystemExit("Couldn't write the sheet")
    book = load_workbook(sheet)
    readme = book["_Read me"]
    for line in READ_ME_EXTRA:
        readme.append([line])
    tab = book.create_sheet("_Review")
    tab.append(["Tab", "Part number", "Where in the catalog", "What to check"])
    for cell in tab[1]:
        cell.font = Font(bold=True)
    for row in review:
        tab.append(row)
    for letter, width in zip("ABCD", (26, 22, 24, 110)):
        tab.column_dimensions[letter].width = width
    tab.freeze_panes = "A2"
    book.save(sheet)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Turn Marki Microwave's catalogs into the parts sheet.")
    parser.add_argument("catalogs", type=Path, nargs="+", help="catalog PDFs")
    parser.add_argument("--data-out", type=Path, required=True, help="folder for categories.yaml and parts/*.csv")
    parser.add_argument("--sheet-out", type=Path, help="Excel file to import into the Google Sheet")
    args = parser.parse_args(argv)

    parts, review = extract(args.catalogs)
    write_data(parts, args.data_out)
    total = 0
    for type_id, rows in parts.items():
        print(f"{rules.PRODUCT_TYPES[type_id][0]}: {len(rows)} parts")
        total += len(rows)
    print(f"Total: {total} parts, {len(review)} review notes")
    if args.sheet_out:
        write_sheet(args.data_out, args.sheet_out, review)
        print(f"Wrote {args.sheet_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

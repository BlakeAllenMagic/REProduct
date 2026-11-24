#!/usr/bin/env python3
"""Write the starter parts sheet: an Excel file with one tab per category.

Made from the current data (categories.yaml and the data/parts/*.csv
snapshot). Upload it to Google Drive and open it with Google Sheets: every
tab comes along, and that Google Sheet becomes the parts list.

The file has friendly headings ("NF (dB)"), a frozen heading row, text
columns formatted as Plain text (so "0603" stays "0603"), and a "_Read me"
tab with instructions. Tabs starting with "_" are ignored by the import.

Usage:
  python3 tools/export_sheet_template.py --out build/linecard-parts.xlsx
"""

from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_linecard  # noqa: E402
from sheet_columns import headings_for, tab_title  # noqa: E402

try:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
except ImportError:  # pragma: no cover
    sys.exit("openpyxl is not installed. Run: pip install -r tools/requirements.txt")

TEXT_FORMAT = "@"  # "Plain text" in Excel and Google Sheets

READ_ME = [
    "RF Line Card: parts list",
    "",
    "One tab per product type. Each row is one part. Row 1 holds the column headings: don't rename them.",
    "",
    "How changes reach the app:",
    "  Every 2 hours, an automatic job reads this sheet. If anything changed and everything checks out,",
    "  it downloads any new datasheets and updates the app. The app shows the result under",
    "  Settings > Parts sheet, including any problems to fix (for example a wrong unit).",
    "",
    "Columns:",
    "  Part number, Manufacturer and Datasheet link are required. Datasheet link is the manufacturer's",
    "  direct link to the PDF (starting with https://).",
    "  Number columns: type just the number (0.6), or the number with the column's unit (0.6 dB).",
    "  Text columns are formatted as Plain text so codes like 0603 keep their leading zero.",
    "",
    "Tabs:",
    "  Tab names must match a product type in the app. Tabs whose name starts with _ (like this one)",
    "  are ignored, so you can add your own notes tabs.",
    "  A new product type needs a change to the app first; ask the developer.",
]


def cell_value(text: str, spec_type: str) -> object:
    """Numbers as real numbers, so the sheet can sort and format them."""
    if spec_type == "number" and text:
        try:
            number = float(text)
            return int(number) if number.is_integer() else number
        except ValueError:
            return text  # e.g. "0.6 dB": allowed, keep as typed
    return text


def main(argv: list[str] | None = None) -> int:
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Write the starter parts sheet (Excel).")
    parser.add_argument("--data", type=Path, default=repo / "data")
    parser.add_argument("--out", type=Path, default=repo / "build" / "linecard-parts.xlsx")
    args = parser.parse_args(argv)

    report = build_linecard.Report()
    categories = build_linecard.load_categories(args.data / "categories.yaml", report)
    if report.errors:
        print("\n".join(report.errors), file=sys.stderr)
        return 1

    book = Workbook()
    readme = book.active
    readme.title = "_Read me"
    for line in READ_ME:
        readme.append([line])
    readme["A1"].font = Font(bold=True, size=14)
    readme.column_dimensions["A"].width = 110

    heading_fill = PatternFill("solid", fgColor="E3EEFA")
    for category in categories:
        sheet = book.create_sheet(tab_title(category))
        columns = headings_for(category)
        spec_types = {s["key"]: s["type"] for s in category["specs"]}
        sheet.append([heading for _, heading in columns])
        for cell in sheet[1]:
            cell.font = Font(bold=True)
            cell.fill = heading_fill
            cell.alignment = Alignment(vertical="center")
        sheet.freeze_panes = "A2"

        csv_path = args.data / "parts" / f"{category['id']}.csv"
        rows = []
        if csv_path.exists():
            with csv_path.open(encoding="utf-8-sig", newline="") as f:
                rows = list(csv.DictReader(f))
        for row in rows:
            sheet.append([cell_value(row.get(key, "") or "", spec_types.get(key, "text")) for key, _ in columns])

        # Text columns as Plain text for the existing rows and plenty of new ones.
        for index, (key, heading) in enumerate(columns, start=1):
            letter = get_column_letter(index)
            sheet.column_dimensions[letter].width = max(12, min(len(heading) + 4, 48))
            if spec_types.get(key, "text") == "text":
                for row_number in range(2, 1001):
                    sheet[f"{letter}{row_number}"].number_format = TEXT_FORMAT
        print(f"{tab_title(category)}: {len(rows)} parts")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    book.save(args.out)
    print(f"Wrote {build_linecard.display(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

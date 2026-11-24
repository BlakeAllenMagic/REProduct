#!/usr/bin/env python3
"""Generate fake sample datasheets for development and for testing updates.

Writes each sample PDF twice:
  public/sample-upstream/<MPN>.pdf  the "manufacturer's website" copy. The app
                                    site serves it, and the sample parts' CSV
                                    links point to it, so the weekly sync job
                                    downloads it like a real datasheet.
  dev-datasheets/<sha256>.pdf       for `npm run dev`, which serves this
                                    folder as the datasheet site.

The PDFs are clearly marked as samples and contain no timestamps, so running
this again produces byte-identical files and the same hashes.

  --revise MPN      publish a new revision of one sample (its bytes and hash
                    change), to test the update flow. Revisions are remembered
                    in data/sample-revisions.json.
  --update-records  also write data/datasheets.json and rebuild linecard.json.
                    Normally the sync job does that, AFTER uploading the PDFs,
                    so the app never points at a file that isn't online yet.
                    Only for local development without the sync job.

Usage:
  python3 tools/make_sample_datasheets.py
  python3 tools/make_sample_datasheets.py --revise AFB-2450
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import zlib
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_linecard  # noqa: E402

# Part id -> (datasheet "updated" date, number of application-note pages).
# The other parts deliberately get no datasheet, so the app's
# "Not downloaded" state can be tested too.
SAMPLES: dict[str, tuple[str, int]] = {
    "acme-alm1234": ("2026-10-02", 4),  # longest one, for testing page navigation
    "northwind-nla0310": ("2026-11-10", 0),
    "acme-amx0750": ("2025-06-18", 1),
    "acme-afb2450": ("2026-03-30", 0),
    "kestrel-ksf1575": ("2026-11-12", 1),
}

PAGE_W, PAGE_H = 612, 792  # US Letter, in points
MARGIN = 54
BLUE = (0.04, 0.24, 0.47)
RED = (0.70, 0.15, 0.12)


# ---------------------------------------------------------------------------
# A tiny PDF writer: text, lines, rectangles, Helvetica. Enough for samples.
# ---------------------------------------------------------------------------


def _pdf_text(s: str) -> str:
    """Escape a string for a PDF literal. Non-Latin-1 characters become '?'."""
    s = s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return s.encode("latin-1", "replace").decode("latin-1")


class Page:
    def __init__(self) -> None:
        self.ops: list[str] = []

    def text(self, x: float, y: float, s: str, size: float = 10, bold: bool = False,
             color: tuple[float, float, float] = (0, 0, 0)) -> None:
        font = "F2" if bold else "F1"
        r, g, b = color
        self.ops.append(
            f"BT {r:.2f} {g:.2f} {b:.2f} rg /{font} {size} Tf {x:.1f} {y:.1f} Td ({_pdf_text(s)}) Tj ET"
        )

    def line(self, x1: float, y1: float, x2: float, y2: float, width: float = 0.75,
             gray: float = 0.6) -> None:
        self.ops.append(f"{gray:.2f} G {width} w {x1:.1f} {y1:.1f} m {x2:.1f} {y2:.1f} l S")

    def polyline(self, points: list[tuple[float, float]], width: float = 1.5,
                 color: tuple[float, float, float] = BLUE) -> None:
        r, g, b = color
        path = " ".join(
            f"{x:.1f} {y:.1f} {'m' if i == 0 else 'l'}" for i, (x, y) in enumerate(points)
        )
        self.ops.append(f"{r:.2f} {g:.2f} {b:.2f} RG {width} w {path} S")

    def rect(self, x: float, y: float, w: float, h: float,
             fill: tuple[float, float, float]) -> None:
        r, g, b = fill
        self.ops.append(f"{r:.2f} {g:.2f} {b:.2f} rg {x:.1f} {y:.1f} {w:.1f} {h:.1f} re f")

    def stream(self) -> bytes:
        return zlib.compress("\n".join(self.ops).encode("latin-1"), 9)


def write_pdf(pages: list[Page], title: str) -> bytes:
    """Assemble pages into a complete PDF file."""
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    catalog = add(b"")  # filled in below, once the Pages id is known
    pages_id = add(b"")
    font1 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    font2 = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>")
    info = add(f"<< /Title ({_pdf_text(title)}) /Producer (RF Line Card sample generator) >>".encode("latin-1"))

    kids = []
    for page in pages:
        data = page.stream()
        content = add(
            f"<< /Length {len(data)} /Filter /FlateDecode >>\nstream\n".encode() + data + b"\nendstream"
        )
        kids.append(
            add(
                (
                    f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] "
                    f"/Resources << /Font << /F1 {font1} 0 R /F2 {font2} 0 R >> >> "
                    f"/Contents {content} 0 R >>"
                ).encode()
            )
        )

    objects[catalog - 1] = f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode()
    kid_refs = " ".join(f"{k} 0 R" for k in kids)
    objects[pages_id - 1] = f"<< /Type /Pages /Kids [{kid_refs}] /Count {len(kids)} >>".encode()

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root {catalog} 0 R /Info {info} 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n"
    ).encode()
    return bytes(out)


# ---------------------------------------------------------------------------
# Datasheet layout
# ---------------------------------------------------------------------------


def frame(page: Page, part: dict[str, Any], number: int, total: int) -> None:
    """Header band, sample warning and footer shared by every page."""
    page.rect(0, PAGE_H - 48, PAGE_W, 48, BLUE)
    page.text(MARGIN, PAGE_H - 31, part["manufacturer"], 14, bold=True, color=(1, 1, 1))
    page.text(PAGE_W - MARGIN - 90, PAGE_H - 31, part["mpn"], 14, bold=True, color=(1, 1, 1))
    page.text(MARGIN, 40, "SAMPLE DATASHEET FOR APP DEVELOPMENT. NOT A REAL PRODUCT.", 8, color=RED)
    page.text(PAGE_W - MARGIN - 60, 40, f"Page {number} of {total}", 8)
    page.line(MARGIN, 54, PAGE_W - MARGIN, 54)


def heading(page: Page, y: float, s: str) -> float:
    page.text(MARGIN, y, s, 13, bold=True, color=BLUE)
    page.line(MARGIN, y - 6, PAGE_W - MARGIN, y - 6, 1, 0.3)
    return y - 26


def format_value(spec: dict[str, Any], value: Any) -> str:
    if value is None:
        return "-"
    text = f"{value:g}" if isinstance(value, (int, float)) else str(value)
    return f"{text} {spec['unit']}" if spec.get("unit") else text


def page_overview(part: dict[str, Any], category: dict[str, Any], updated: str, revision: int = 0) -> Page:
    page = Page()
    y = PAGE_H - 100
    page.text(MARGIN, y, part["mpn"], 30, bold=True)
    page.text(MARGIN, y - 24, part["description"], 14, color=(0.3, 0.3, 0.3))
    page.text(MARGIN, y - 42, f"{category['name']}  |  Rev. {updated}" + (f"  |  Sample revision {revision}" if revision else ""), 10, color=(0.4, 0.4, 0.4))
    page.rect(MARGIN, y - 82, PAGE_W - 2 * MARGIN, 26, (0.99, 0.92, 0.91))
    page.text(MARGIN + 10, y - 73, "Sample file generated for testing the RF Line Card app.", 10, color=RED)

    y = heading(page, y - 120, "Key Specifications")
    for spec in category["specs"]:
        value = part["specs"].get(spec["key"])
        page.text(MARGIN + 6, y, spec["label"], 11)
        page.text(MARGIN + 260, y, format_value(spec, value), 11, bold=True)
        page.line(MARGIN, y - 8, PAGE_W - MARGIN, y - 8, 0.5, 0.85)
        y -= 26

    y = heading(page, y - 20, "Features")
    for feature in [
        "Single positive supply",
        "Internally matched to 50 ohms",
        "RoHS compliant, lead-free package",
        "Sample text only: see the real manufacturer datasheet",
    ]:
        page.text(MARGIN + 6, y, "-  " + feature, 11)
        y -= 18
    return page


def page_performance(part: dict[str, Any], category: dict[str, Any]) -> Page:
    """A simple plot so the viewer has graphics to render and zoom into."""
    page = Page()
    y = heading(page, PAGE_H - 100, "Typical Performance")
    left, bottom, width, height = MARGIN + 30, y - 300, PAGE_W - 2 * MARGIN - 40, 270
    for i in range(6):  # grid
        gx = left + width * i / 5
        gy = bottom + height * i / 5
        page.line(gx, bottom, gx, bottom + height, 0.5, 0.85)
        page.line(left, gy, left + width, gy, 0.5, 0.85)
    page.line(left, bottom, left + width, bottom, 1, 0.2)
    page.line(left, bottom, left, bottom + height, 1, 0.2)

    # A smooth, deterministic curve shaped by the part's id.
    seed = int(hashlib.sha256(part["id"].encode()).hexdigest()[:8], 16)
    phase = (seed % 360) * math.pi / 180
    points = []
    for i in range(121):
        t = i / 120
        v = 0.55 + 0.25 * math.sin(2.2 * t * math.pi + phase) * (1 - 0.5 * t) + 0.1 * t
        points.append((left + width * t, bottom + height * v))
    page.polyline(points)

    first_spec = category["specs"][0]
    page.text(left, bottom - 22, f"Frequency ({first_spec.get('unit') or 'GHz'})", 10)
    page.text(MARGIN, bottom + height + 14, "Response (dB)", 10)
    page.text(MARGIN, bottom - 60, "Conditions: 25 C, 50 ohm system. Curve is illustrative only.", 10,
              color=(0.4, 0.4, 0.4))
    return page


def page_package(part: dict[str, Any], updated: str) -> Page:
    page = Page()
    y = heading(page, PAGE_H - 100, "Package and Ordering Information")
    package = part["specs"].get("package", "See manufacturer")
    for label, value in [
        ("Package", str(package)),
        ("Ordering part number", f"{part['mpn']}-TR"),
        ("Reel quantity", "3000"),
        ("MSL rating", "1"),
    ]:
        page.text(MARGIN + 6, y, label, 11)
        page.text(MARGIN + 260, y, value, 11, bold=True)
        page.line(MARGIN, y - 8, PAGE_W - MARGIN, y - 8, 0.5, 0.85)
        y -= 26

    y = heading(page, y - 30, "Revision History")
    page.text(MARGIN + 6, y, updated, 11, bold=True)
    page.text(MARGIN + 120, y, "Current sample revision", 11)
    page.text(MARGIN + 6, y - 22, "2024-01-15", 11, bold=True)
    page.text(MARGIN + 120, y - 22, "Initial release", 11)
    return page


def page_application(part: dict[str, Any], index: int) -> Page:
    page = Page()
    y = heading(page, PAGE_H - 100, f"Application Information ({index})")
    paragraph = (
        f"This page is filler text so the {part['mpn']} sample has enough pages to test "
        "scrolling, the page counter and the previous and next buttons in the viewer. "
        "Real datasheets often run to dozens of pages, so the viewer only renders the pages "
        "near the screen and releases the rest."
    )
    words, lines, current = paragraph.split(), [], ""
    for word in words:
        if len(current) + len(word) + 1 > 90:
            lines.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    lines.append(current)
    for line in lines * 3:
        page.text(MARGIN, y, line, 11)
        y -= 17
    page.text(MARGIN, y - 40, f"Section {index}", 48, bold=True, color=(0.85, 0.88, 0.93))
    return page


def make_datasheet(
    part: dict[str, Any], category: dict[str, Any], updated: str, extra: int, revision: int = 0
) -> bytes:
    pages = [page_overview(part, category, updated, revision), page_performance(part, category)]
    pages += [page_application(part, i + 1) for i in range(extra)]
    pages.append(page_package(part, updated))
    for number, page in enumerate(pages, start=1):
        frame(page, part, number, len(pages))
    return write_pdf(pages, f"{part['mpn']} sample datasheet")


# ---------------------------------------------------------------------------


def safe_name(mpn: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "-", mpn)


def main(argv: list[str] | None = None) -> int:
    repo = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Generate sample datasheets for development and update tests.")
    parser.add_argument("--data", type=Path, default=repo / "data")
    parser.add_argument("--out-dir", type=Path, default=repo / "dev-datasheets")
    parser.add_argument("--upstream-dir", type=Path, default=repo / "public" / "sample-upstream")
    parser.add_argument("--revise", action="append", default=[], metavar="MPN",
                        help="publish a new revision of this sample part (repeatable)")
    parser.add_argument("--update-records", action="store_true",
                        help="also write data/datasheets.json and rebuild linecard.json")
    args = parser.parse_args(argv)

    linecard, _report = build_linecard.build(args.data, "sample-generation")
    if linecard is None:
        print("Fix the data errors first (run tools/build_linecard.py).", file=sys.stderr)
        return 1
    parts = {p["id"]: p for p in linecard["parts"]}
    categories = {c["id"]: c for c in linecard["categories"]}
    by_mpn = {p["mpn"].casefold(): p["id"] for p in linecard["parts"] if p["id"] in SAMPLES}

    revisions_path = args.data / "sample-revisions.json"
    revisions: dict[str, int] = (
        json.loads(revisions_path.read_text(encoding="utf-8")) if revisions_path.exists() else {}
    )
    for mpn in args.revise:
        part_id = by_mpn.get(mpn.casefold())
        if part_id is None:
            names = ", ".join(sorted(parts[i]["mpn"] for i in by_mpn.values()))
            print(f"--revise {mpn}: not one of the sample parts ({names})", file=sys.stderr)
            return 1
        revisions[part_id] = revisions.get(part_id, 0) + 1
        print(f"{parts[part_id]['mpn']}: now sample revision {revisions[part_id]}")
    if args.revise:
        revisions_path.write_text(json.dumps(revisions, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    records_path = args.data / "datasheets.json"
    records = json.loads(records_path.read_text(encoding="utf-8")) if records_path.exists() else {}
    args.out_dir.mkdir(parents=True, exist_ok=True)
    args.upstream_dir.mkdir(parents=True, exist_ok=True)

    for part_id, (updated, extra) in SAMPLES.items():
        part = parts.get(part_id)
        if part is None:
            print(f"Skipping {part_id}: not in the line card", file=sys.stderr)
            continue
        revision = revisions.get(part_id, 0)
        pdf = make_datasheet(part, categories[part["category"]], updated, extra, revision)
        sha = hashlib.sha256(pdf).hexdigest()
        (args.upstream_dir / f"{safe_name(part['mpn'])}.pdf").write_bytes(pdf)
        # Older versions stay in dev-datasheets/, so the dev server can still
        # serve whichever version linecard.json currently lists.
        (args.out_dir / f"{sha}.pdf").write_bytes(pdf)
        records[part_id] = {"sha256": sha, "bytes": len(pdf), "updated": updated}
        print(f"{part['mpn']:10} {len(pdf):6} bytes  {sha[:12]}...  revision {revision}")

    print(f"Wrote {build_linecard.display(args.upstream_dir)}/ and {build_linecard.display(args.out_dir)}/")
    if not args.update_records:
        print("Records not changed: the sync job picks up new revisions (GitHub > Actions > Sync datasheets).")
        return 0
    records_path.write_text(json.dumps(records, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Updated {build_linecard.display(records_path)}. Rebuilding linecard.json:")
    return build_linecard.main([])


if __name__ == "__main__":
    sys.exit(main())

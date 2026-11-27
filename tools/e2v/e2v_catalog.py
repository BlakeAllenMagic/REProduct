#!/usr/bin/env python3
"""Teledyne e2v Semiconductors: product pages saved from a browser -> sheet rows.

e2v's site (semiconductors.teledyne-e2v.com) sits behind a bot check, so this
tool doesn't fetch anything: the rep saves a product page in a browser (as
.mht or .html) and this reads its product table. Run by hand; the Google Sheet
stays the source of truth afterwards.

Each table row gives: device name, channels, rate, resolution, package and
temperature range. A few more values (output bandwidth, MUX, power, grade)
come from each datasheet's first page, typed in DATASHEET_FACTS below with the
datasheet they came from. Values are typical, as published.

Usage:
  python3 tools/e2v/e2v_catalog.py --page dac.mht --out /tmp/e2v
"""

from __future__ import annotations

import argparse
import csv
import email
import html
import json
import re
from email import policy
from pathlib import Path

MANUFACTURER = "Teledyne e2v"

# From each datasheet's first page (what the product table doesn't list).
DATASHEET_FACTS: dict[str, dict[str, str]] = {
    "EV12DD700": {
        "description": "Dual 12-bit 10 GSps DAC",
        "notes": "Datasheet on request from Teledyne e2v (not available for direct download)",
    },
    "EV12DS480A": {  # DS 60S 217580 rev A.5
        "description": "Low power 12-bit 8 GSps DAC with 4/2:1 MUX",
        "bandwidth_ghz": "7.5", "mux": "4:1 or 2:1", "power_w": "2.6",
        "grade": "Commercial (C), Industrial (V), Military (M), ECSS Class 3, NASA Level 1",
        "notes": "6.4 GSps guaranteed (8.0 GSps with reduced data rate); RF synthesis up to 12 GHz, 24 GHz at reduced power",
    },
    "EV12DS460A": {  # DS1167 (EV12DS460AZP)
        "description": "Low power 12-bit 6 GSps DAC with 4/2:1 MUX",
        "bandwidth_ghz": "7.5", "mux": "4:1 or 2:1", "power_w": "2.6",
        "grade": "Commercial (C), Industrial (V), Military (M)",
        "notes": "7.0 GSps operation; RF synthesis up to 12 GHz, 24 GHz at reduced power",
    },
    "EV12DS400A": {  # DS1130 (EV12DS400AZP)
        "description": "Low power 12-bit 4.5 GSps DAC with 4/2:1 MUX",
        "bandwidth_ghz": "7", "mux": "4:1 or 2:1", "power_w": "2.6",
        "grade": "Commercial (C), Industrial (V), Military (M)",
        # The product page lists -65 to +150 °C: that's the storage range.
        # Ordering table: M grade -55 °C < Tc, Tj < 125 °C.
        "temp_range": "-55 to +125°C",
    },
    "EV12DS130xG": {  # DS 60S 221070 (EV12DS130AG / BG)
        "description": "Low power 12-bit 3 GSps DAC with 4/2:1 MUX",
        "bandwidth_ghz": "7", "mux": "4:1 or 2:1", "power_w": "1.4",
        "grade": "Space grade (engineering models and prototypes too)",
        "notes": "EV12DS130AG and EV12DS130BG; revision A has a SYNC/power-on-reset erratum (ES1125), fixed in B",
    },
    "EV12DS130xZP": {  # DS 60S 223692(K) (EV12DS130AZP / BZP)
        "description": "Low power 12-bit 3 GSps DAC with 4/2:1 MUX",
        "bandwidth_ghz": "7", "mux": "4:1 or 2:1", "power_w": "1.4",
        "grade": "Commercial (C), Industrial (V)",
        "notes": "EV12DS130AZP and EV12DS130BZP; revision A has a SYNC/power-on-reset erratum (ES1125), fixed in B",
    },
    "EV10DS130xG": {
        "description": "10-bit 3 GSps DAC",
        "notes": "EV10DS130AG and EV10DS130BG; revision A has a SYNC/power-on-reset erratum (ES1125), fixed in B",
    },
    "EV10DS130AZP": {  # DS 60S 223704 (EV10DS130AZP / BZP)
        "description": "Low power 10-bit 3 GSps DAC with 4/2:1 MUX",
        "bandwidth_ghz": "7", "mux": "4:1 or 2:1", "power_w": "1.4",
        "grade": "Commercial (C), Industrial (V)",
        "notes": "Datasheet covers EV10DS130AZP and EV10DS130BZP; revision A has a SYNC/power-on-reset erratum (ES1125), fixed in B",
    },
}


def page_html(path: Path) -> str:
    """The HTML of a page saved as .mht (MIME archive) or plain .html."""
    data = path.read_bytes()
    if path.suffix.lower() in (".mht", ".mhtml"):
        msg = email.message_from_bytes(data, policy=policy.default)
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                return part.get_content()
        raise ValueError(f"{path}: no HTML part")
    return data.decode("utf-8", errors="replace")


def text_of(fragment: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", " ", fragment)).split())


def number(text: str) -> str:
    m = re.search(r"\d+(?:\.\d+)?", text)
    return m.group(0) if m else ""


def read_table(page: str) -> list[dict[str, str]]:
    """Product rows: the main row (name, channels, rate, resolution), then its
    "+" details row (package, temperature range)."""
    table = re.search(r"<table.*?</table>", page, re.S)
    if not table:
        raise ValueError("no product table on the page")
    rows: list[dict[str, str]] = []
    headings: list[str] = []
    for tr in re.findall(r"<tr.*?</tr>", table.group(0), re.S):
        cells = re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", tr, re.S)
        texts = [text_of(c) for c in cells]
        if not headings:
            headings = [t.lower() for t in texts]
            continue
        if len(cells) >= 4 and re.search(r'href="[^"]*model=', cells[0]):
            row = dict(zip(headings, texts))
            row["link"] = html.unescape(re.search(r'href="([^"]+)"', cells[0]).group(1))
            rows.append(row)
        elif rows and texts:
            details = " ".join(texts)
            pkg = re.search(r"Package:\s*(.*?)\s*(?:Compliance|Temperature Range:|$)", details)
            temp = re.search(r"Temperature Range:\s*(.*?)\s*$", details)
            rows[-1]["package"] = pkg.group(1) if pkg else ""
            rows[-1]["temp"] = temp.group(1) if temp else ""
    return rows


def convert(rows: list[dict[str, str]]) -> tuple[list[dict[str, str]], list[list[str]]]:
    out: list[dict[str, str]] = []
    review: list[list[str]] = []
    for row in rows:
        mpn = row["device name"]
        facts = DATASHEET_FACTS.get(mpn, {})
        if not facts:
            review.append([mpn, "No datasheet facts typed in yet: only the product table's values"])
        temp = row.get("temp", "").replace("C", "°C") if row.get("temp") else ""
        if facts.get("temp_range"):
            temp = facts["temp_range"]  # the datasheet's operating range wins
        elif re.search(r"-65 to \+150", temp):
            review.append([mpn, f"Product page gives {temp}, which looks like a storage range; check the datasheet"])
        out.append({
            "manufacturer": MANUFACTURER,
            "mpn": mpn,
            "description": facts.get("description", ""),
            "datasheet_url": "",
            "product_url": row["link"],
            "resolution_bits": number(row.get("resolution", "")),
            "rate_gsps": number(row.get("rate", "")),
            "channels": number(row.get("channels", "")),
            "bandwidth_ghz": facts.get("bandwidth_ghz", ""),
            "mux": facts.get("mux", ""),
            "power_w": facts.get("power_w", ""),
            "package": row.get("package", ""),
            "temp_range": temp,
            "grade": facts.get("grade", ""),
            "notes": facts.get("notes", ""),
            "eccn": "",
        })
    return out, review


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--page", type=Path, required=True, help="saved e2v product page (.mht or .html)")
    parser.add_argument("--out", type=Path, required=True, help="folder for e2v-<type>.csv and review JSON")
    parser.add_argument("--type", default="dac", help="product type id (CSV name)")
    args = parser.parse_args(argv)
    rows, review = convert(read_table(page_html(args.page)))
    args.out.mkdir(parents=True, exist_ok=True)
    with (args.out / f"e2v-{args.type}.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    (args.out / f"e2v-{args.type}-review.json").write_text(json.dumps(review, indent=1), encoding="utf-8")
    print(f"{len(rows)} rows, {len(review)} to review")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

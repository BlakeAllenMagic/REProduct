#!/usr/bin/env python3
"""pSemi products -> rows for the power tabs (DC-DC Converters, Gate Drivers) and,
through psemi_rf.py, the RF tabs (Switches, Attenuators, Mixers...).

pSemi's website publishes each product's specs through its public WordPress
interface (https://psemi.com/wp-json/wp/v2/products), the same data its
product pages show. robots.txt allows it with a 10 second crawl delay, which
--fetch respects. Values are copied as published; anything that isn't a plain
number or range (e.g. "Div 2: 5.7-15 / Div 3: 8.4-15") also goes to Notes.

Obsolete products are left out (they can't be sold) and listed in the review.

Usage:
  python3 tools/power/psemi.py --fetch --out build/power        # download + convert
  python3 tools/power/psemi.py --json saved1.json saved2.json --out build/power
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from psemi_rf import convert_rf  # noqa: E402

API = "https://psemi.com/wp-json/wp/v2/products?per_page=100&page={page}"
SITE = "https://psemi.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
CRAWL_DELAY = 10  # seconds, from psemi.com/robots.txt
MANUFACTURER = "pSemi"

# pSemi family -> topology shown in the table (checked against each family's description).
TOPOLOGY = {
    "FlexiBK": "Buck",
    "UltraBK": "Buck module",
    "FlexiCP": "Charge pump (capacitor divider)",
    "Integrated module": "Charge pump module",
    "Multi-level Converters": "Multi-level buck",
    "LED Boost": "Boost (LED driver)",
}

NUM = r"\d+(?:\.\d+)?"


def clean(text: Any) -> str:
    """'Div 2: 5.7-15<br />Div 3: 8.4-15' -> 'Div 2: 5.7-15 / Div 3: 8.4-15'; trademark signs dropped."""
    s = html.unescape(str(text or ""))
    s = re.sub(r"<br\s*/?>", " / ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s).replace("™", "").replace("®", "")
    return re.sub(r"\s+", " ", s).strip()


def numbers(text: str) -> list[float]:
    return [float(n) for n in re.findall(NUM, text)]


def span(text: str) -> tuple[float | None, float | None, bool]:
    """'4.5-18.5' -> (4.5, 18.5, True); 'Div 2: 5.7-15 / Div 3: 8.4-15' -> (5.7, 15, False).

    The flag says whether the text was a plain number or range (else it belongs in Notes too).
    Labels like 'Div 2:' are ignored when collecting the numbers.
    """
    t = clean(text)
    if not t or t.upper() in {"N/A", "NA"}:
        return None, None, True
    plain = re.fullmatch(rf"({NUM})\s*(?:A|V|%)?(?:\s*-\s*({NUM}))?\s*(?:A|V|%)?", t)
    if plain:
        lo = float(plain.group(1))
        hi = float(plain.group(2)) if plain.group(2) else lo
        return lo, hi, True
    found = numbers(re.sub(r"Div \d+:", "", t))
    if not found:
        return None, None, False
    return min(found), max(found), False


def leading(text: str) -> tuple[float | None, bool]:
    """'90 (3.3Vin/0.5Vo)' -> (90, False); 'Div 2: 99% / Div 3: 98%' -> (99, False); '96' -> (96, True)."""
    t = clean(text)
    if not t:
        return None, True
    plain = re.fullmatch(rf"({NUM})\s*%?", t)
    if plain:
        return float(plain.group(1)), True
    found = numbers(re.sub(r"Div \d+:|\([^)]*\)", "", t))
    return (max(found) if found else None), False


def fmt(n: float | None) -> str:
    if n is None:
        return ""
    return str(int(n)) if float(n).is_integer() else str(n)


def datasheet_link(acf: dict[str, Any]) -> str:
    links = [l.strip() for l in (acf.get("technical_resource_links") or "").splitlines()]
    pdf = next((l for l in links if "/datasheets/" in l and l.lower().endswith(".pdf")), "")
    if pdf.startswith("/"):
        pdf = SITE + pdf
    return pdf.replace(" ", "%20") if pdf.startswith("https://") else ""


def convert(products: list[dict[str, Any]]) -> tuple[dict[str, list[dict[str, str]]], list[list[str]]]:
    out: dict[str, list[dict[str, str]]] = {"dc_dc": [], "gate_driver": []}
    review: list[list[str]] = []
    for item in products:
        if "/power-management/" not in item.get("link", ""):
            continue
        acf = item.get("acf") or {}
        mpn = clean(acf.get("product_name")) or clean(item["title"]["rendered"])
        status = clean(acf.get("lifecycle_pp"))
        if status.lower() == "obsolete":
            review.append(["pSemi", mpn, "Left out: pSemi lists it as Obsolete"])
            continue
        if "/gan-fet-drivers/" in item["link"]:
            target = "gate_driver"
        else:
            target = "dc_dc"
        family = clean(acf.get("product_family_pp"))
        notes = []
        row = {
            "manufacturer": MANUFACTURER,
            "mpn": mpn,
            "datasheet_url": datasheet_link(acf),
            "product_url": item["link"],
            "family": family,
            "package": "Surface mount",
            "status": status,
            "case": clean(acf.get("package_pp")),
            "eccn": clean(acf.get("eccn_number_pp")),
        }
        if target == "dc_dc":
            vin_lo, vin_hi, ok = span(acf.get("vin_vpp"))
            if not ok:
                notes.append(f"Vin: {clean(acf.get('vin_vpp'))}")
            vo_text = clean(acf.get("vo_vpp"))
            vo_lo, vo_hi, ok = span(vo_text)
            if "vin/" in vo_text.lower():  # a ratio, not a voltage
                vo_lo = vo_hi = None
                ok = False
            if not ok:
                notes.append(f"Vout: {vo_text}")
            _, io_hi, ok = span(acf.get("io_a_pp"))
            if not ok:
                notes.append(f"Iout: {clean(acf.get('io_a_pp'))}")
            eff, ok = leading(acf.get("efficiency_pp"))
            if not ok:
                notes.append(f"Efficiency: {clean(acf.get('efficiency_pp'))}")
            fsw = clean(acf.get("sw_frequency_khz_pp"))
            topology = TOPOLOGY.get(family, "")
            if not topology:
                review.append(["pSemi", mpn, f"Unknown family {family!r}: Topology left blank"])
            row.update({
                "topology": topology,
                "vin_min_v": fmt(vin_lo), "vin_max_v": fmt(vin_hi),
                "vout_min_v": fmt(vo_lo), "vout_max_v": fmt(vo_hi),
                "iout_max_a": fmt(io_hi), "efficiency_pct": fmt(eff),
                "fsw_khz": "" if fsw.upper() == "N/A" else fsw,
            })
            # "Buck, 3 to 3.6 V in, up to 20 A" (like the Marki descriptions)
            vin = f"{fmt(vin_lo)} to {fmt(vin_hi)} V in" if vin_lo is not None else ""
            iout = f"up to {fmt(io_hi)} A" if io_hi is not None else ""
            row["description"] = ", ".join(x for x in [topology or "DC-DC converter", vin, iout] if x)
        title = clean(item["title"]["rendered"])
        if "/" in title:
            review.append(["pSemi", mpn, f"pSemi's listing covers more than one part ({title}); add the others by hand if needed"])
        row["notes"] = "; ".join(notes)
        if not row["datasheet_url"]:
            review.append(["pSemi", mpn, "No datasheet link published: the app links to the product page"])
        out[target].append(row)
    return out, review


def fetch() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for page in range(1, 10):
        if page > 1:
            time.sleep(CRAWL_DELAY)
        req = urllib.request.Request(API.format(page=page), headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                batch = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 400:  # past the last page
                break
            raise
        if not batch:
            break
        items += batch
        if len(batch) < 100:
            break
    return items


def write(rows: dict[str, list[dict[str, str]]], out: Path, categories: Path) -> None:
    import yaml

    cats = {c["id"]: c for c in yaml.safe_load(categories.read_text(encoding="utf-8"))["categories"]}
    out.mkdir(parents=True, exist_ok=True)
    for cid, items in rows.items():
        keys = ["manufacturer", "mpn", "description", "datasheet_url", "product_url"] + [s["key"] for s in cats[cid]["specs"]]
        with (out / f"psemi-{cid}.csv").open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore", lineterminator="\n")
            w.writeheader()
            w.writerows(items)


def main(argv: list[str] | None = None) -> int:
    repo = Path(__file__).resolve().parents[2]
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--fetch", action="store_true", help="download from psemi.com")
    p.add_argument("--json", type=Path, nargs="*", default=[], help="saved API pages instead")
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--categories", type=Path, default=repo / "data" / "categories.yaml")
    a = p.parse_args(argv)
    items = fetch() if a.fetch else [x for f in a.json for x in json.loads(f.read_text(encoding="utf-8"))]
    rows, review = convert(items)
    rf_rows, rf_review = convert_rf(items)  # switches, attenuators... (psemi_rf.py)
    rows.update(rf_rows)
    review += rf_review
    write(rows, a.out, a.categories)
    (a.out / "psemi-review.json").write_text(json.dumps(review, indent=1), encoding="utf-8")
    for cid, r in rows.items():
        print(f"{cid}: {len(r)} parts")
    for line in review:
        print("review:", " | ".join(line))
    return 0


if __name__ == "__main__":
    sys.exit(main())

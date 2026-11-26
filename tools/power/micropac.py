#!/usr/bin/env python3
"""Teledyne Micropac's product catalog -> rows for the parts sheet.

Micropac's product pages on www.teledyne-ade.com embed the whole catalog as
data (`const PRODUCTS = [...]`): model, category, screening, package, specs
and a datasheet link for every part. robots.txt allows these pages. This tool
reads that data from a saved page (or fetches one page), maps each Micropac
category to a product type, and writes one CSV per type.

Values are copied as published. Short descriptions are written from the specs
(Micropac's own text is long and sometimes garbled). A part listed twice is
kept once and noted in the review.

Usage:
  python3 tools/power/micropac.py --fetch --out build/power
  python3 tools/power/micropac.py --page saved.html --out build/power
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any

PAGE = "https://www.teledyne-ade.com/companies/micropac/products"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
MANUFACTURER = "Teledyne Micropac"

# Micropac category -> (product type id, Family shown in the table)
CATEGORY = {
    "Solid State Relays": ("solid_state_relay", "Solid-state relay"),
    "Solid State Power Controllers": ("solid_state_relay", "Solid-state power controller"),
    "Industrial Power Controllers": ("solid_state_relay", "Industrial power controller"),
    "Standard": ("optocoupler", "Standard"),
    "Radiation Tolerant": ("optocoupler", "Radiation tolerant"),
    "Radiation Assured": ("optocoupler", "Radiation assured"),
    "LEDs": ("led", "LED"),
    "LED Displays": ("led", "LED display"),
    "Optical Sensors": ("optical_sensor", "Optical sensor"),
    "Fiber Optic Transceivers": ("fiber_optic", "Fiber-optic transceiver"),
    "Hall Effects": ("hall_sensor", "Hall-effect sensor"),
    "Temperature Control": ("temperature_controller", "Temperature controller"),
    "dc-dc Converters": ("dc_dc", "Isolated DC-DC converter"),
}

NUM = r"\d+(?:[.,]\d+)?"


def number(text: str, unit_scale: dict[str, float] | None = None) -> str:
    """'1KV' -> '1' (with {'kv': 1, 'v': 0.001}); '120mW' -> '120'; '850nm' -> '850'. '' if none."""
    t = (text or "").replace(",", "").strip()
    m = re.match(rf"^\s*({NUM})\s*([A-Za-zµ]*)", t)
    if not m:
        return ""
    value = float(m.group(1))
    if unit_scale:
        scale = unit_scale.get(m.group(2).lower())
        if scale is None:
            return ""
        value *= scale
    value = round(value, 6)
    return str(int(value)) if value.is_integer() else str(value)


def v_range(text: str) -> tuple[str, str]:
    """'70 – 130 VDC (100 VDC ±5% nominal)' -> ('70', '130')."""
    m = re.match(rf"\s*({NUM})\s*(?:V\w*)?\s*(?:–|-|to)\s*({NUM})", text or "")
    return (m.group(1), m.group(2)) if m else ("", "")


def first_clause(text: str) -> str:
    return re.split(r",|—| – ", text or "")[0].strip().rstrip(".")


def convert(products: list[dict[str, Any]]) -> tuple[dict[str, list[dict[str, str]]], list[list[str]]]:
    rows: dict[str, list[dict[str, str]]] = {}
    review: list[list[str]] = []
    seen: set[str] = set()
    for p in products:
        mpn = (p.get("model") or "").strip()
        mapped = CATEGORY.get(p.get("category", ""))
        if not mpn or not mapped:
            review.append(["Teledyne Micropac", mpn, f"Category {p.get('category')!r} not mapped: left out"])
            continue
        if mpn in seen:
            review.append(["Teledyne Micropac", mpn, "Listed twice in Micropac's catalog: kept once"])
            continue
        seen.add(mpn)
        type_id, family = mapped
        spec = {s["label"]: (s.get("value") or "").strip() for s in p.get("specs") or []}
        case = (p.get("package") or spec.get("Package") or "").strip()
        row = {
            "manufacturer": MANUFACTURER,
            "mpn": mpn,
            "datasheet_url": p.get("datasheet") or "",
            "product_url": "",
            "family": family,
            "grade": p.get("screening_tier") or "",
            "screening": spec.get("Screening / Grade", ""),
            "space": p.get("space_qualified") or "",
            "radiation": "Yes" if p.get("radiation_tolerant") or spec.get("Radiation Tolerant") == "Yes" else "",
            "qml": "Yes" if p.get("qml") else "",
            "cross_ref": spec.get("Industry Cross-Reference", ""),
            "case": case,
            "status": spec.get("Status", ""),
        }
        notes: list[str] = []
        if type_id == "solid_state_relay":
            row.update(relay_config=spec.get("Relay Configuration", ""), channels=spec.get("Number of Channels", ""),
                       lead_finish=spec.get("Lead Finish", ""))
            what = " ".join(x for x in [row["channels"], row["relay_config"]] if x)
            row["description"] = f"{(what + ' ') if what else ''}{family.lower()}, {case}".strip(", ")
        elif type_id == "optocoupler":
            iso = number(spec.get("Isolation Voltage", ""), {"kv": 1, "v": 0.001})
            row.update(channels=number(spec.get("Number of Channels", "")), output_type=spec.get("Output Type", ""),
                       isolation_kv=iso, forward_voltage=spec.get("Forward Voltage (25°C)", ""),
                       ic_on=spec.get("Iᴄ(ON) min. at Iғ", ""), collector=spec.get("Collector Configuration", ""),
                       op_temp=spec.get("Operating Temperature", ""))
            row["description"] = f"{row['channels'] or '?'}-channel {row['output_type']} optocoupler, {iso} kV isolation, {case}"
        elif type_id == "led":
            row.update(color=spec.get("Color", ""), lens=spec.get("Lens", ""),
                       power_mw=number(spec.get("Power Dissipation", ""), {"mw": 1, "w": 1000}),
                       character_type=spec.get("Character Type", ""), character_height=spec.get("Character Height", ""))
            if family == "LED display":
                row["description"] = ", ".join(x for x in ["LED display", row["character_type"], row["color"], case] if x and x != "other")
            else:
                row["description"] = ", ".join(x for x in [f"{row['color']} LED", f"{row['lens'].lower()} lens" if row["lens"] else "", case] if x)
        elif type_id == "optical_sensor":
            row.update(kind=spec.get("Type", ""), power_mw=number(spec.get("Power Dissipation", ""), {"mw": 1, "w": 1000}),
                       op_temp=spec.get("Operating Temperature", ""))
            row["description"] = f"{row['kind']} optical sensor, {case}"
        elif type_id == "fiber_optic":
            row.update(kind=spec.get("Type", ""), wavelength_nm=number(spec.get("Peak Wavelength", ""), {"nm": 1}),
                       data_rate=spec.get("Data Rate", ""), optical_power=spec.get("Power", ""),
                       rise_time_ns=number(spec.get("Rise Time", ""), {"ns": 1}),
                       reverse_v=number(spec.get("Reverse Voltage", ""), {"v": 1}), fiber=spec.get("Characterization Fiber", ""))
            row["description"] = f"Fiber-optic {row['kind'].lower()}, {row['wavelength_nm']} nm, {case}"
        elif type_id == "hall_sensor":
            row.update(output_type=spec.get("Output Type", ""), supply_voltage=spec.get("Supply Voltage", ""),
                       supply_current_ma=number(spec.get("Supply Current", ""), {"ma": 1}),
                       magnetic=spec.get("Magnetic Operate / Release / Hysteresis (Bₒₚ/Bᵣₚ/Bₕᵧₛ)", ""),
                       op_temp=spec.get("Operating Temperature", ""))
            row["description"] = f"{row['output_type']} Hall-effect sensor, {row['supply_voltage']} supply, {case}"
        elif type_id == "temperature_controller":
            row.update(operating_v=number(spec.get("Operating Voltage", ""), {"vdc": 1, "v": 1}),
                       power_w=number(spec.get("Power", ""), {"w": 1}), operating_current=spec.get("Operating Current", ""))
            row["description"] = f"Temperature controller (heater hybrid), {row['operating_v']} V, {row['power_w']} W"
        elif type_id == "dc_dc":
            lo, hi = v_range(spec.get("Input Voltage Range", ""))
            eff = number(spec.get("Efficiency (typical)", ""), {"%": 1, "": 1})
            row.update(topology="Isolated", vin_min_v=lo, vin_max_v=hi, efficiency_pct=eff, package="Through hole")
            for label in ("Outputs", "Total Output Power", "Input-to-Output Isolation", "Radiation Tolerance", "Screening / Grade"):
                if spec.get(label):
                    notes.append(f"{label}: {spec[label]}")
            power = spec.get("Total Output Power", "")
            row["description"] = ", ".join(x for x in ["Isolated DC-DC converter", f"{lo} to {hi} V in" if lo else "", power] if x)
        row["notes"] = "; ".join(notes)
        rows.setdefault(type_id, []).append(row)
    return rows, review


def products_from_page(html: str) -> list[dict[str, Any]]:
    start = html.index("const PRODUCTS = ") + len("const PRODUCTS = ")
    data, _ = json.JSONDecoder().raw_decode(html[start:])
    return data


def write(rows: dict[str, list[dict[str, str]]], out: Path, categories: Path) -> None:
    import yaml

    cats = {c["id"]: c for c in yaml.safe_load(categories.read_text(encoding="utf-8"))["categories"]}
    out.mkdir(parents=True, exist_ok=True)
    for cid, items in rows.items():
        keys = ["manufacturer", "mpn", "description", "datasheet_url", "product_url"] + [s["key"] for s in cats[cid]["specs"]]
        with (out / f"micropac-{cid}.csv").open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore", lineterminator="\n")
            w.writeheader()
            w.writerows(items)


def main(argv: list[str] | None = None) -> int:
    repo = Path(__file__).resolve().parents[2]
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--fetch", action="store_true", help=f"download {PAGE}")
    ap.add_argument("--page", type=Path, help="a saved copy of that page instead")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--categories", type=Path, default=repo / "data" / "categories.yaml")
    a = ap.parse_args(argv)
    if a.fetch:
        req = urllib.request.Request(PAGE, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            html = r.read().decode("utf-8", errors="replace")
    else:
        html = a.page.read_text(encoding="utf-8", errors="replace")
    rows, review = convert(products_from_page(html))
    write(rows, a.out, a.categories)
    (a.out / "micropac-review.json").write_text(json.dumps(review, indent=1), encoding="utf-8")
    for cid, r in rows.items():
        print(f"{cid}: {len(r)} parts")
    for line in review:
        print("review:", " | ".join(line))
    return 0


if __name__ == "__main__":
    sys.exit(main())

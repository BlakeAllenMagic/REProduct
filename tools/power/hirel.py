#!/usr/bin/env python3
"""Teledyne HiRel's product catalog -> rows for the parts sheet.

The catalog page on www.teledyne-ade.com (HiRel-Catalog.aspx) holds the whole
catalog as JavaScript data (`const PRODUCTS = [...]`): model, category,
subcategory, a frequency field, a long description, space qualification and
ECCN. There are no separate spec fields, so specs are read from the
descriptions ("650 V / 60 A ... 25 mΩ", "0.4 dB noise figure, 17.5 dB gain").

Rules:
- Only values a pattern clearly finds are filled in; nothing is guessed.
- The catalog's frequency field is often the whole family's range, so the
  part's own range is taken from its description. When the two disagree, the
  row is listed in the review (the description may have a typo, or the field).
- A part listed under two categories is kept once.
- The data is parsed as data (a small reader for this JavaScript notation);
  nothing from the page is run.

Usage:
  python3 tools/power/hirel.py --fetch --out build/power
  python3 tools/power/hirel.py --page saved.html --out build/power
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any

PAGE = "https://www.teledyne-ade.com/en-us/companies/e2v%20HiRel%20Electronics/products/SiteAssets/HiRel-Catalog.aspx"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
MANUFACTURER = "Teledyne HiRel"

# HiRel category -> (product type id, Family shown in the table, or None to use the subcategory)
CATEGORY = {
    "GaN HEMTs": ("power_transistor", None),
    "GaN Gate Drivers": ("gate_driver", None),
    "Point-of-Load Regulators (POLs)": ("dc_dc", None),
    "GaN Power Modules": ("ldo", None),
    "High-Reliability Power Modules": ("ldo", None),
    "Low Noise Amplifiers (LNAs)": ("amplifier", None),
    "Microwave Gain Blocks": ("amplifier", None),
    "Driver Amplifiers": ("amplifier", None),
    "RF Power Amplifiers": ("amplifier", None),
    "RF Switches": ("switch", None),
    "RF Limiters & Receiver Protectors": ("limiter", None),
    "RF Mixers": ("mixer", None),
    "RF Frequency Multipliers": ("multiplier", None),
    "Digital Step Attenuators (DSA)": ("attenuator", None),
    "PLL Frequency Synthesizers": ("pll", None),
    "RF Prescalers": ("prescaler", None),
}

NUM = r"-?\d[\d,]*(?:\.\d+)?"
UNIT_GHZ = {"khz": 1e-6, "mhz": 1e-3, "ghz": 1.0}
CASES = [
    r"\d+-lead CQFP", r"\d+-lead CQFN", r"\d+-lead CFP", r"\d+-lead CLGA", r"\d+-pin [\w ×.]*?DFN",
    r"SOIC-\d+ NB", r"GaNPX® package", r"hermetic QFN", r"QFN", r"DFN", r"CQFP", r"CFP", r"CLGA",
    r"wire bond die", r"bare die", r"\bdie\b",
]


# ---------------------------------------------------------------------------
# Reading the page's data
# ---------------------------------------------------------------------------

def js_array(html: str) -> list[dict[str, Any]]:
    """The PRODUCTS array, read as data: unquoted keys and 'single quoted' strings -> JSON."""
    start = html.index("const PRODUCTS = ") + len("const PRODUCTS = ")
    end = html.index("\n];", start) + 2
    src = html[start:end]
    out: list[str] = []
    i = 0
    while i < len(src):
        c = src[i]
        if c == "'":
            i += 1
            buf = []
            while src[i] != "'":
                if src[i] == "\\":
                    i += 1
                buf.append(src[i])
                i += 1
            out.append(json.dumps("".join(buf)))
            i += 1
        elif re.match(r"[A-Za-z_]", c):
            m = re.match(r"[A-Za-z_]\w*", src[i:])
            word = m.group(0)
            i += len(word)
            out.append(json.dumps(word) if src[i:i + 1] == ":" else word)
        else:
            out.append(c)
            i += 1
    return json.loads(re.sub(r",\s*([}\]])", r"\1", "".join(out)))


# ---------------------------------------------------------------------------
# Reading values from the descriptions
# ---------------------------------------------------------------------------

def num(text: str) -> float:
    return float(text.replace(",", ""))


def fmt(value: float | None) -> str:
    if value is None:
        return ""
    value = round(value, 6)
    return str(int(value)) if float(value).is_integer() else str(value)


RANGE = re.compile(
    rf"(?P<lo>DC|{NUM})\s*(?P<u1>kHz|MHz|GHz)?\s*(?:–|-|to|-to-)\s*(?P<hi>{NUM})\s*(?P<u2>kHz|MHz|GHz)", re.I
)


def ranges(text: str) -> list[tuple[float, float]]:
    """Every frequency range in the text, in GHz: '40 MHz to 3.0 GHz' -> (0.04, 3.0); 'DC to 20 GHz' -> (0, 20)."""
    found = []
    for m in RANGE.finditer(text.replace("DC-to-", "DC to ")):
        u2 = UNIT_GHZ[m.group("u2").lower()]
        u1 = UNIT_GHZ[m.group("u1").lower()] if m.group("u1") else u2
        lo = 0.0 if m.group("lo").upper() == "DC" else num(m.group("lo")) * u1
        found.append((lo, num(m.group("hi")) * u2))
    return found


def first(pattern: str, text: str) -> float | None:
    m = re.search(pattern, text, re.I)
    return num(m.group(1)) if m else None


def watts_to_dbm(w: float) -> float:
    return round(10 * math.log10(w * 1000), 1)


def case_of(text: str) -> str:
    for pattern in CASES:
        m = re.search(pattern, text, re.I)
        if m:
            found = m.group(0)
            return "Bare die" if "die" in found.lower() else found.replace("hermetic ", "Hermetic ")
    return ""


def grade_of(text: str) -> str:
    t = text.lower()
    if "radiation-hardened" in t:
        return "Radiation hardened"
    if re.search(r"space[- ](?:qualified|screen|grade|enhanced)|full space screening|space qualification", t):
        return "Space"
    if "military-grade" in t:
        return "Military"
    if "enhanced plastic" in t or "ruggedized plastic" in t:
        return "Enhanced plastic"
    if "hi-rel" in t:
        return "Hi-Rel"
    return ""


def bias(text: str) -> tuple[str, str]:
    """'5 V / 80 mA' -> ('+5', '80'); '+5 V' -> ('+5', '')."""
    m = re.search(rf"\+?({NUM}) V / ({NUM}) mA", text)
    if m:
        return f"+{m.group(1)}", m.group(2)
    m = re.search(rf"at \+({NUM}) V\b", text)
    return (f"+{m.group(1)}", "") if m else ("", "")


# ---------------------------------------------------------------------------
# Converting
# ---------------------------------------------------------------------------

def convert(products: list[dict[str, Any]]) -> tuple[dict[str, list[dict[str, str]]], list[list[str]]]:
    rows: dict[str, list[dict[str, str]]] = {}
    review: list[list[str]] = []
    seen: dict[str, str] = {}
    for p in products:
        model = (p.get("model") or "").strip()
        cat = p.get("category", "")
        if cat not in CATEGORY:
            review.append([MANUFACTURER, model, f"Category {cat!r} not mapped: left out"])
            continue
        if model in seen:
            review.append([MANUFACTURER, model, f"Also listed under {cat!r}; kept once (under {seen[model]!r})"])
            continue
        seen[model] = cat
        type_id, _ = CATEGORY[cat]
        d = p.get("description") or ""
        sub = (p.get("subcategory") or "").replace("—", "-").strip()
        case = case_of(d)
        r: dict[str, str] = {
            "manufacturer": MANUFACTURER,
            "mpn": model,
            "datasheet_url": "",
            "product_url": PAGE,
            "family": sub,
            "package": "Bare die" if case == "Bare die" else "Surface mount",
            "case": "" if case == "Bare die" else case,
            "eccn": p.get("eccn") or "",
        }
        notes: list[str] = []
        problems: list[str] = []
        found = ranges(d)
        catalog = ranges(p.get("freq_range") or "")
        own = found[0] if found else None

        def check_range(rng: tuple[float, float] | None) -> None:
            if rng and catalog and not (catalog[0][0] - 1e-9 <= rng[0] and rng[1] <= catalog[0][1] + 1e-9):
                problems.append(f"description gives {fmt(rng[0])}–{fmt(rng[1])} GHz, the catalog's frequency field "
                                f"{p.get('freq_range')}: check the datasheet")

        if type_id in ("power_transistor", "gate_driver", "dc_dc", "ldo"):
            r["grade"] = grade_of(d)
            if (p.get("freq_range") or "").strip().upper() == "LTB":
                notes.append("Catalog lists LTB")
                problems.append("catalog's frequency field says 'LTB' (Last Time Buy?): confirm the status")

        if type_id == "power_transistor":
            m = re.search(rf"({NUM}) V / ({NUM}) A", d)
            r.update(technology="GaN", vds_max_v=fmt(num(m.group(1))) if m else "", id_max_a=fmt(num(m.group(2))) if m else "",
                     rds_on_mohm=fmt(first(rf"({NUM})\s*mΩ", d)))
            dims = re.search(r"\(([\d.]+×[\d.]+×[\d.]+ mm)\)", d)
            r["case"] = f"GaNPX ({dims.group(1)})" if dims else "GaNPX"
            r["description"] = f"GaN FET, {r['vds_max_v']} V, {r['id_max_a']} A, {r['rds_on_mohm']} mΩ"
        elif type_id == "gate_driver":
            r["channels"] = "2" if "half-bridge" in (sub + d).lower() else "1"
            for pat, label in ((rf"(?:up to|to) ({NUM}) V", "Rated to (V)"), (rf"({NUM}) kV RMS isolation", "Isolation (kV RMS)"),
                               (rf"({NUM}) V (?:output )?under-voltage|({NUM}) V UVLO", "UVLO (V)"),
                               (rf"up to ({NUM}) MHz|({NUM}) MHz switching", "Max switching (MHz)")):
                m = re.search(pat, d, re.I)
                if m:
                    notes.append(f"{label}: {next(g for g in m.groups() if g)}")
            r["description"] = f"{sub}" + (f", {case}" if case else "")
        elif type_id == "dc_dc":
            vin = re.search(rf"({NUM})–({NUM}) V input", d)
            vout = re.search(rf"({NUM})–({NUM}) V output", d)
            iout = first(rf"(?:up to|at|to) ({NUM}) A\b", d)
            def v(m: re.Match[str] | None, i: int) -> str:
                return fmt(num(m.group(i))) if m else ""
            r.update(topology="Buck (point of load)", vin_min_v=v(vin, 1), vin_max_v=v(vin, 2),
                     vout_min_v=v(vout, 1), vout_max_v=v(vout, 2), iout_max_a=fmt(iout))
            fsw = re.findall(rf"({NUM}–{NUM}) kHz", d)
            r["fsw_khz"] = " / ".join(fsw)
            if "die" in d.lower() and case and case != "Bare die":
                notes.append("Also available as die")
            r["description"] = ", ".join(x for x in ["POL buck regulator" if "Module" not in sub else "POL DC-DC module",
                                                     f"{r['vin_min_v']} to {r['vin_max_v']} V in" if vin else "",
                                                     f"up to {fmt(iout)} A" if iout else ""] if x)
        elif type_id == "ldo":
            m = re.search(rf"({NUM}) V / ({NUM}) A", d)
            r.update(kind="GaN load switch module", vin_max_v=fmt(num(m.group(1))) if m else "",
                     iout_max_a=fmt(num(m.group(2))) if m else "")
            notes.append("Integrated GaN FET and isolated gate driver")
            r["description"] = f"GaN load switch module, {r['vin_max_v']} V, {r['iout_max_a']} A"
        elif type_id == "amplifier":
            check_range(own)
            gain = first(rf"({NUM}) dB (?:of )?gain|gain of ({NUM})", d)
            psat_w = re.search(rf"({NUM}) (W|mW) (?:of saturated )?output power", d)
            psat = watts_to_dbm(num(psat_w.group(1)) / (1000 if psat_w.group(2) == "mW" else 1)) if psat_w else None
            dbm_out = first(rf"({NUM}) dBm output power", d)
            volts, ma = bias(d)
            r.update(freq_min_ghz=fmt(own[0]) if own else "", freq_max_ghz=fmt(own[1]) if own else "",
                     gain_db=fmt(gain), nf_db=fmt(first(rf"({NUM}) dB (?:noise figure|NF)", d)),
                     op1db_dbm=fmt(first(rf"({NUM}) dBm (?:O?P1dB)", d)), psat_dbm=fmt(psat if psat is not None else dbm_out),
                     oip3_dbm=fmt(first(rf"({NUM}) dBm OIP3", d)), voltage=volts, current=ma)
            pae = first(rf"({NUM})% (?:power-added efficiency|PAE)", d)
            if pae is not None:
                notes.append(f"PAE: {fmt(pae)}%")
            if psat_w:
                notes.append(f"Output power: {psat_w.group(1)} {psat_w.group(2)}")
            r["description"] = ", ".join(x for x in [sub, f"{r['freq_min_ghz']} to {r['freq_max_ghz']} GHz" if own else ""] if x)
        elif type_id == "switch":
            check_range(own)
            r.update(freq_min_ghz=fmt(own[0]) if own else "", freq_max_ghz=fmt(own[1]) if own else "",
                     insertion_loss_db=fmt(first(rf"({NUM}) dB insertion loss", d)),
                     isolation_db=fmt(first(rf"({NUM}) dB isolation", d)))
            p1 = first(rf"({NUM}) dBm (?:typical )?P1dB", d)
            if p1 is not None:
                notes.append(f"P1dB: {fmt(p1)} dBm")
            r["description"] = ", ".join(x for x in [sub, f"{r['freq_min_ghz']} to {r['freq_max_ghz']} GHz" if own else ""] if x)
        elif type_id == "limiter":
            check_range(own)
            peak = first(rf"({NUM}) dBm (?:max power|peak power|max power handling)", d)
            thr = re.search(rf"({NUM}–{NUM}) dBm (?:limiting )?threshold", d)
            r.update(freq_min_ghz=fmt(own[0]) if own else "", freq_max_ghz=fmt(own[1]) if own else "",
                     flat_leakage=f"{thr.group(1)} (threshold)" if thr else "",
                     peak_power_w=fmt(round(10 ** (peak / 10) / 1000, 1)) if peak is not None else "")
            if peak is not None:
                notes.append(f"Peak power: {fmt(peak)} dBm")
            r["description"] = ", ".join(x for x in [sub, f"{r['freq_min_ghz']} to {r['freq_max_ghz']} GHz" if own else ""] if x)
        elif type_id == "mixer":
            rf_lo = found[0] if found else None
            if_band = found[1] if len(found) > 1 else None
            r.update(rf_lo_min_ghz=fmt(rf_lo[0]) if rf_lo else "", rf_lo_max_ghz=fmt(rf_lo[1]) if rf_lo else "",
                     if_min_ghz=fmt(if_band[0]) if if_band else "", if_max_ghz=fmt(if_band[1]) if if_band else "",
                     conv_loss_db=fmt(first(rf"({NUM}) dB conversion loss", d)), iip3_dbm=fmt(first(rf"({NUM}) dBm IIP3", d)),
                     lo_drive_dbm=fmt(first(rf"({NUM}) dBm LO drive", d)))
            check_range(rf_lo)
            r["description"] = f"Double-balanced mixer, {r['rf_lo_min_ghz']} to {r['rf_lo_max_ghz']} GHz RF/LO"
        elif type_id == "multiplier":
            inp = found[0] if found else None
            outp = found[1] if len(found) > 1 else None
            r.update(kind="Doubler (active)", input_min_ghz=fmt(inp[0]) if inp else "", input_max_ghz=fmt(inp[1]) if inp else "",
                     output_min_ghz=fmt(outp[0]) if outp else "", output_max_ghz=fmt(outp[1]) if outp else "",
                     output_dbm=fmt(first(rf"\+?({NUM}) dBm output power", d)))
            check_range(inp)
            r["description"] = f"Active frequency doubler, {r['output_min_ghz']} to {r['output_max_ghz']} GHz out"
        elif type_id == "attenuator":
            check_range(own)
            r.update(freq_min_ghz=fmt(own[0]) if own else "", freq_max_ghz=fmt(own[1]) if own else "")
            rng = re.search(rf"({NUM}) dB attenuation range in ({NUM}) dB steps", d)
            if rng:
                r["attenuation_range"] = f"0 to {rng.group(1)} ({rng.group(2)} dB steps)"
            il = first(rf"insertion loss of ({NUM}) dB", d)
            if il is not None:
                notes.append(f"Insertion loss: {fmt(il)} dB")
            r["description"] = f"Digital step attenuator, {r['freq_min_ghz']} to {r['freq_max_ghz']} GHz"
        elif type_id == "pll":
            check_range(own)
            fom = first(rf"({NUM}) dBc/Hz", d)
            pres = re.findall(r"(\d+/\d+)", d)
            r.update(kind="Fractional-N" if "frac" in (sub + d).lower() else "Integer-N",
                     freq_min_ghz=fmt(own[0]) if own else "", freq_max_ghz=fmt(own[1]) if own else "",
                     fom_dbc_hz=fmt(fom), prescaler=", ".join(dict.fromkeys(pres)),
                     ref_max_mhz=fmt(first(rf"({NUM}) MHz max reference", d)), grade=grade_of(d))
            r["description"] = ", ".join(x for x in [f"{r['kind']} PLL synthesizer",
                                                     f"{r['freq_min_ghz']} to {r['freq_max_ghz']} GHz" if own else ""] if x)
        elif type_id == "prescaler":
            check_range(own)
            div = first(r"divide-by-(\d+)", d)
            r.update(divide_by=fmt(div), freq_min_ghz=fmt(own[0]) if own else "", freq_max_ghz=fmt(own[1]) if own else "",
                     grade=grade_of(d))
            r["description"] = ", ".join(x for x in [f"Divide-by-{fmt(div)} prescaler" if div else "Prescaler",
                                                     f"{r['freq_min_ghz']} to {r['freq_max_ghz']} GHz" if own else ""] if x)
        r["notes"] = "; ".join(notes)
        rows.setdefault(type_id, []).append(r)
        for problem in problems:
            review.append([MANUFACTURER, model, problem])
    return rows, review


def write(rows: dict[str, list[dict[str, str]]], out: Path, categories: Path) -> None:
    import yaml

    cats = {c["id"]: c for c in yaml.safe_load(categories.read_text(encoding="utf-8"))["categories"]}
    out.mkdir(parents=True, exist_ok=True)
    for cid, items in rows.items():
        keys = ["manufacturer", "mpn", "description", "datasheet_url", "product_url"] + [s["key"] for s in cats[cid]["specs"]]
        with (out / f"hirel-{cid}.csv").open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=keys, extrasaction="ignore", lineterminator="\n")
            w.writeheader()
            w.writerows(items)


def main(argv: list[str] | None = None) -> int:
    repo = Path(__file__).resolve().parents[2]
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--fetch", action="store_true", help="download the catalog page")
    ap.add_argument("--page", type=Path, help="a saved copy of it instead")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--categories", type=Path, default=repo / "data" / "categories.yaml")
    a = ap.parse_args(argv)
    if a.fetch:
        with urllib.request.urlopen(urllib.request.Request(PAGE, headers={"User-Agent": UA}), timeout=60) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    else:
        html = a.page.read_text(encoding="utf-8", errors="replace")
    rows, review = convert(js_array(html))
    write(rows, a.out, a.categories)
    (a.out / "hirel-review.json").write_text(json.dumps(review, indent=1), encoding="utf-8")
    for cid, r in rows.items():
        print(f"{cid}: {len(r)} parts")
    for line in review:
        print("review:", " | ".join(line))
    return 0


if __name__ == "__main__":
    sys.exit(main())

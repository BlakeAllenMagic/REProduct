"""pSemi RF products -> rows for the RF tabs (used by psemi.py).

Same public data as the power products (psemi.com/wp-json/wp/v2/products).
Each product's section comes from its page link, e.g.
psemi.com/products/rf-switches/broadband-rf-switches/pe42525/.

Values are copied as published. Where pSemi gives more than a single number
("0.4 @ 6 GHz", "33 / 31", "6.5–7.3"), the table gets the first number and
Notes keeps the full text. Obsolete parts are left out (psemi.py does the same
for power); Last Time Buy and Pre Release are kept, with the status in Notes.
"""

from __future__ import annotations

import html
import re
from typing import Any

MANUFACTURER = "pSemi"
SITE = "https://psemi.com"
NUM = r"[-+]?(?:\d+(?:\.\d+)?|\.\d+)"

# pSemi section (second part of the link) -> (product type, family shown in the table).
SECTIONS = {
    "broadband-rf-switches": ("switch", "Broadband"),
    "high-isolation-rf-switches": ("switch", "High isolation"),
    "high-linearity-rf-switches": ("switch", "High linearity"),
    "low-il-rf-switches": ("switch", "Low insertion loss"),
    "75%cf%89-wired-broadband-switches": ("switch", "75 Ω broadband"),
    "automotive-switches": ("switch", "Automotive"),
    "high-power-switches": ("switch", "High power"),
    "extended-temperature-rf-switches": ("switch", "Extended temperature"),
    "antenna-tuning-switches": ("switch", "Antenna tuning"),
    "general-purpose-rf-digital-step-attenuators": ("attenuator", "Digital step attenuator"),
    "glitch-less-rf-digital-step-attenuators": ("attenuator", "Glitch-less digital step attenuator"),
    "75%cf%89-wired-broadband-rf-digital-step-attenuators": ("attenuator", "75 Ω digital step attenuator"),
    "mixers": ("mixer", "Passive mixer"),
    "power-limiters": ("limiter", "Power limiter"),
    "prescalers": ("prescaler", "Prescaler"),
    "phase-shifters": ("phase_shifter", "Digital phase shifter"),
    "monolithic-phase-amplitude-controllers-mpacs": ("phase_shifter", "MPAC (phase + amplitude)"),
    "digital-tunable-capacitors-dtcs": ("tunable_capacitor", ""),
    "2-4-ghz-iot-fems": ("front_end_module", "2.4 GHz IoT FEM"),
    "switch-lna": ("front_end_module", "Switch-LNA"),
    "beamforming-front-ends": ("front_end_module", "Beamforming front end"),
}

TYPES = ("switch", "attenuator", "mixer", "limiter", "prescaler", "phase_shifter", "tunable_capacitor", "front_end_module")


def clean(value: Any) -> str:
    s = html.unescape(str(value or ""))
    s = re.sub(r"<br\s*/?>", " / ", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s).replace("™", "").replace("®", "").replace("₋", "-")
    s = re.sub(r"\s+", " ", s).strip()
    return "" if s in {"-", "–", "N/A"} else s


def fmt(n: float | None) -> str:
    if n is None:
        return ""
    n = round(n, 9)
    if float(n).is_integer():
        return str(int(n))
    return f"{n:.9f}".rstrip("0")  # never "9e-06"


def first(text: str) -> float | None:
    m = re.search(NUM, text.replace("–", "-"))
    return float(m.group(0)) if m else None


def plain(text: str) -> bool:
    """A single number (no '@', range or second value)."""
    return re.fullmatch(NUM, text) is not None


def ghz(text: str) -> float | None:
    """'300 MHz' -> 0.3; '9 kHz' -> 9e-06; 'DC' -> 0; '6.025 GHz' -> 6.025."""
    t = clean(text)
    if t.upper() == "DC":
        return 0.0
    m = re.fullmatch(rf"({NUM})\s*(Hz|kHz|MHz|GHz)", t)
    if not m:
        return None
    scale = {"hz": 1e-9, "khz": 1e-6, "mhz": 1e-3, "ghz": 1.0}[m.group(2).lower()]
    return float(m.group(1)) * scale


def ns(text: str) -> float | None:
    """'100 ns' -> 100; '38 µs' -> 38000; '0.008 µs' -> 8."""
    m = re.fullmatch(rf"({NUM})\s*(ns|µs|us|ms)", clean(text))
    if not m:
        return None
    return float(m.group(1)) * {"ns": 1, "µs": 1e3, "us": 1e3, "ms": 1e6}[m.group(2)]


def case_of(acf: dict[str, Any]) -> str:
    package, size = clean(acf.get("package")), clean(acf.get("package_mm")).replace("×", "x")
    if package and size:
        return f"{package} ({size} mm)"
    return package


def kind_of_package(acf: dict[str, Any]) -> str:
    package = clean(acf.get("package")).lower()
    if package in {"die", "flip-chip"}:
        return "Bare die"
    return "Surface mount" if package else ""


def datasheet_link(acf: dict[str, Any]) -> str:
    links = [l.strip() for l in (acf.get("technical_resource_links") or "").splitlines()]
    pdf = next((l for l in links if "/datasheets/" in l and l.lower().endswith(".pdf")), "")
    if not pdf:
        pdf = (acf.get("datasheet_link") or "").strip()
    if "/datasheets/" not in pdf:
        return ""  # e.g. an end-of-life notice (/PCNs/...pdf) is not a datasheet
    if pdf.startswith("/pdf/"):
        pdf = SITE + "/wp-content/uploads" + pdf
    elif pdf.startswith("/"):
        pdf = SITE + pdf
    return pdf.replace(" ", "%20") if pdf.startswith("https://") and pdf.lower().endswith(".pdf") else ""


def section_of(link: str) -> str:
    m = re.search(r"/products/[^/]+/([^/]+)/[^/]+/?$", link)
    if m:
        return m.group(1).lower()
    m = re.search(r"/products/[^/]+/([^/]+)/?$", link)  # e.g. /products/integrated-products/switch-lna/
    return m.group(1).lower() if m else ""


def convert_rf(products: list[dict[str, Any]]) -> tuple[dict[str, list[dict[str, str]]], list[list[str]]]:
    rows: dict[str, list[dict[str, str]]] = {t: [] for t in TYPES}
    review: list[list[str]] = []
    for item in products:
        link = item.get("link", "")
        if "/power-management/" in link:
            continue  # psemi.py handles those
        acf = item.get("acf") or {}
        title = clean(item.get("title", {}).get("rendered"))
        mpn = clean(acf.get("product_name")) or title
        section = section_of(link)
        if section not in SECTIONS:
            review.append([MANUFACTURER, mpn or title, f"Not added: no specs published in a known section ({link})"])
            continue
        status = clean(acf.get("lifecycle"))
        if status.lower() == "obsolete":
            review.append([MANUFACTURER, mpn, "Left out: pSemi lists it as Obsolete"])
            continue
        type_id, family = SECTIONS[section]
        get = lambda key: clean(acf.get(key))  # noqa: E731
        notes: list[str] = []
        if status and status.lower() != "in production":
            notes.append(status)
        lo, hi = ghz(get("min_freq")), ghz(get("max_freq"))
        if (get("min_freq") and lo is None) or (get("max_freq") and hi is None):
            notes.append(f"Frequency: {get('min_freq')} to {get('max_freq')}")
        row: dict[str, str] = {
            "manufacturer": MANUFACTURER,
            "mpn": mpn,
            "datasheet_url": datasheet_link(acf),
            "product_url": link,
            "package": kind_of_package(acf),
            "case": case_of(acf),
            "eccn": get("eccn_number"),
            "freq_min_ghz": fmt(lo),
            "freq_max_ghz": fmt(hi),
            "supply_v": get("vdd_range_v").replace(" V", "").replace("-", "–") if get("vdd_range_v") else "",
        }
        # As pSemi writes it: "9 kHz to 6 GHz", "300 MHz to 10.6 GHz".
        band = f"{get('min_freq')} to {get('max_freq')}" if get("min_freq") and get("max_freq") else ""
        desc_text = get("description")

        def number(key: str, label: str) -> str:
            """The first number; the whole text into Notes when it's more than one number."""
            text = get(key)
            if not text:
                return ""
            if not plain(text):
                notes.append(f"{label}: {text}")
            return fmt(first(text))

        if type_id == "switch":
            config = re.sub(r"\s*\((?:R|A|OR)\)", "", desc_text)
            kind = {"(R)": "reflective", "(A)": "absorptive", "(OR)": "open-reflective"}
            flavour = next((v for k, v in kind.items() if k in desc_text), "")
            row.update(
                family=family, configuration=f"{config} {flavour}".strip(), impedance=get("type"),
                insertion_loss_db=fmt(first(get("typ_il_db") or get("max_typ_il_db"))),
                isolation_db=fmt(first(get("min_typ_iso_db"))),
                switching_ns=fmt(ns(get("switching_time"))),
                max_power_dbm="" if "dBmV" in get("max_power_rating_dbm") else number("max_power_rating_dbm", "Max power"),
                iip3_dbm=number("iip3_dbm", "IIP3"),
            )
            # IL and isolation are published low band / high band; the table shows
            # the low-band IL and the high-band (worst) isolation.
            if get("typ_il_db") and get("max_typ_il_db"):
                notes.append(f"IL: {get('typ_il_db')} / {get('max_typ_il_db')} dB")
            elif "@" in get("typ_il_db"):
                notes.append(f"IL: {get('typ_il_db')} dB")
            if get("min_typ_iso_db") and get("max_typ_iso_db"):
                notes.append(f"Isolation: {get('min_typ_iso_db')} to {get('max_typ_iso_db')} dB")
            if "dBmV" in get("max_power_rating_dbm"):
                notes.append(f"Max power: {get('max_power_rating_dbm')}")
            p01 = get("p101db_dbm")
            if p01:
                notes.append(f"P0.1dB: {p01}" + ("" if "dBm" in p01 else " dBm"))
            row["description"] = ", ".join(x for x in [f"{row['configuration']} RF switch", band] if x)
        elif type_id == "attenuator":
            rng = get("Attn Range (dB)").replace("–", " to ")
            row.update(
                family=family, attenuation_range=rng, bits=fmt(first(get("bits"))), step_db=", ".join(x.strip() for x in get("attn_step_db").split("/")),  # "6, 12, 18": never read as a date
                control=get("interface"), insertion_loss_db=number("typ_il_db", "IL"), iip3_dbm=number("iip3_dbm", "IIP3"),
            )
            if get("attenuation_accuracy_db_1ghz"):
                notes.append(f"Accuracy at 1 GHz: {get('attenuation_accuracy_db_1ghz')} dB")
            if get("type"):
                notes.append(get("type"))
            row["note"] = "; ".join(notes)
            notes = []
            bits = f"{row['bits']}-bit " if row["bits"] else ""
            row["description"] = ", ".join(x for x in [f"{bits}digital step attenuator", band] if x)
        elif type_id == "mixer":
            row.update(
                family=family, rf_lo_min_ghz=fmt(lo), rf_lo_max_ghz=fmt(hi),
                conv_loss_db=number("conv_loss_db", "Conversion loss"), iip3_dbm=number("iip3_dbm", "IIP3"),
            )
            for key, label in (("max_lo_drive_dbm", "Max LO drive (dBm)"), ("min_lo_drive_dbm", "Min LO drive (dBm)"),
                               ("typ_iso_db_lo_rf", "LO-RF isolation (dB)"), ("typ_iso_db_lo_if", "LO-IF isolation (dB)")):
                if get(key):
                    notes.append(f"{label}: {get(key)}")
            if get("type"):
                notes.append(get("type"))
            row["description"] = ", ".join(x for x in [f"{desc_text} mixer", f"{band} RF/LO" if band else ""] if x)
        elif type_id == "limiter":
            tmin, tmax = get("adjustable_limiting_threshold_min_dbm"), get("adjustable_limiting_threshold_max_dbm")
            row.update(family=family, flat_leakage=f"Adjustable threshold {tmin} to {tmax} dBm" if tmin and tmax else "")
            for key, label in (("max_power_rating_dbm", "Max power (dBm)"), ("iip3_dbm", "IIP3 (dBm)")):
                if get(key):
                    notes.append(f"{label}: {get(key)}")
            row["description"] = ", ".join(x for x in [f"{desc_text} power limiter", band] if x)
        elif type_id == "prescaler":
            row.update(family=family, divide_by=fmt(first(get("divide_ratio"))))
            row["description"] = ", ".join(x for x in [f"Divide-by-{row['divide_by']} prescaler", band] if x)
        elif type_id == "phase_shifter":
            dps = [first(x) for x in get("dps_rangestep_deg__bits").split("/")]
            if len(dps) == 3:
                row.update(phase_range_deg=fmt(dps[0]), phase_step_deg=fmt(dps[1]), bits=fmt(dps[2]))
            dsa = get("dsa_rangestep_db__bits")
            row.update(
                kind=family, attenuation=f"{dsa} (dB / dB / bits)" if dsa else "",
                insertion_loss_db=number("typ_il_db", "IL"), iip3_dbm=number("iip3_dbm", "IIP3"),
                rms_phase_error_deg=number("rms_phase_error_deg", "RMS phase error"),
            )
            if get("p101db_dbm"):
                notes.append(f"P0.1dB: {get('p101db_dbm')} dBm")
            row["description"] = ", ".join(x for x in [desc_text, band] if x)
        elif type_id == "tunable_capacitor":
            row.update(
                c_min_pf=number("min_typ_shunt_capacitance_pf", "C min"), c_max_pf=number("max_typ_shunt_capacitance_pf", "C max"),
                tuning_ratio=get("tuning_ratio"), bits=fmt(first(desc_text)),
                q_cmin=number("max_typ_quality_factor_cmin", "Q"), peak_rf_vpk=number("peak_rf_voltage_vpk", "Peak RF voltage"),
                control=get("interface"),
            )
            row["description"] = ", ".join(x for x in [f"{desc_text} digital tunable capacitor",
                                                      f"{row['c_min_pf']} to {row['c_max_pf']} pF" if row["c_min_pf"] else ""] if x)
        elif type_id == "front_end_module":
            row.update(
                kind=family, tx_gain_db=number("typ_tx_gain_db", "TX gain"), rx_nf_db=number("rx_nf_db", "RX NF"),
                bypass_loss_db=number("bypass_loss_db", "Bypass loss"),
            )
            if get("tx_gain_control"):
                notes.append(f"TX gain control: {get('tx_gain_control')} dB in {get('tx_gain_step_db')} dB steps")
            row["description"] = ", ".join(x for x in [desc_text, band] if x)
            if not (row["tx_gain_db"] or row["rx_nf_db"]):
                review.append([MANUFACTURER, mpn, "pSemi publishes no specs beyond the frequency: see the datasheet"])

        if type_id != "attenuator":
            row["notes"] = "; ".join(notes)
        if not row["datasheet_url"]:
            review.append([MANUFACTURER, mpn, "No datasheet link published: the app links to the product page"])
        if "/" in title and title != mpn:
            review.append([MANUFACTURER, mpn, f"pSemi's listing covers more than one part ({title}); add the others by hand if needed"])
        rows[type_id].append(row)
    return rows, review

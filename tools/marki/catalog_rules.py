"""Rules for turning Marki Microwave catalog table cells into sheet values.

Pure functions (no PDF reading), so they're unit tested in
tools/tests/test_marki_rules.py. extract_catalogs.py does the PDF part.
"""

from __future__ import annotations

import re
from typing import Any

MANUFACTURER = "Marki Microwave"

# Catalog table title prefix (upper case) -> product type id.
FAMILY_TO_TYPE: list[tuple[str, str]] = [
    ("AMPLIFIERS", "amplifier"),
    ("LEVEL SET ATTENUATORS", "attenuator"),
    ("FIXED ATTENUATORS", "attenuator"),
    ("ATTENUATORS", "attenuator"),
    ("BALUNS", "balun"),
    ("PULSE INVERTERS", "balun"),
    ("BIAS TEES", "bias_tee"),
    ("DC BLOCKS", "bias_tee"),
    ("COUPLERS", "coupler"),
    ("DIPLEXERS", "diplexer"),
    ("EQUALIZERS", "equalizer"),
    ("FIXED FILTERS", "filter"),
    ("CONFIGURABLE FILTERS", "filter"),
    ("FILTER BANKS", "filter"),
    ("LIMITERS", "limiter"),
    ("IQ MIXERS", "mixer"),
    ("MIXERS", "mixer"),
    ("PASSIVE MULTIPLIERS", "multiplier"),
    ("ACTIVE MULTIPLIERS", "multiplier"),
    ("ACTIVE DOUBLER", "multiplier"),
    ("SAPPHIRE LOADED CAVITY OSCILLATORS", "oscillator"),
    ("POWER DIVIDERS", "power_divider"),
    ("SWITCHES", "switch"),
    ("DETECTORS", "detector"),
    ("ISOLATORS", "isolator"),
    ("TERMINATIONS", "termination"),
    ("ADAPTERS", "adapter"),
    ("THUMBWHEEL", "adapter"),
    ("WAVEGUIDE TWISTS", "waveguide"),
    ("WAVEGUIDE BENDS", "waveguide"),
    ("WAVEGUIDE STRAIGHTS", "waveguide"),
]

# id -> (name shown in the app and as the sheet tab, diagram blocks)
PRODUCT_TYPES: dict[str, tuple[str, list[str]]] = {
    "amplifier": ("Amplifiers", ["lna", "if_amp", "lo_amp", "tx_lo_amp", "tx_if_amp", "tx_driver", "tx_pa"]),
    "attenuator": ("Attenuators", ["rx_atten", "tx_atten"]),
    "balun": ("Baluns and Pulse Inverters", ["rx_balun", "tx_balun"]),
    "bias_tee": ("Bias Tees and DC Blocks", ["rx_bias_tee"]),
    "coupler": ("Couplers", ["tx_coupler"]),
    "diplexer": ("Diplexers and Multiplexers", []),
    "equalizer": ("Equalizers", ["tx_equalizer"]),
    "filter": ("Filters", ["rf_filter", "if_filter", "tx_if_filter", "tx_rf_filter"]),
    "limiter": ("Limiters", ["rx_limiter"]),
    "mixer": ("Mixers", ["mixer", "tx_mixer"]),
    "multiplier": ("Multipliers", ["lo_mult", "tx_lo_mult"]),
    "oscillator": ("Oscillators", ["lo_osc", "tx_lo_osc"]),
    "power_divider": ("Power Dividers", ["lo_split", "tx_lo_split"]),
    "switch": ("Switches", ["rx_switch", "tx_switch"]),
    "detector": ("Detectors", ["tx_detector"]),
    "isolator": ("Isolators", ["tx_isolator"]),
    "termination": ("Terminations", []),
    "adapter": ("Adapters and Accessories", []),
    "waveguide": ("Waveguide Parts", []),
}


def spec(key: str, label: str, unit: str | None = None, *sources: str, kind: str = "number") -> dict[str, Any]:
    return {"key": key, "label": label, "unit": unit, "type": kind, "sources": list(sources)}


def text(key: str, label: str, *sources: str) -> dict[str, Any]:
    return spec(key, label, None, *sources, kind="text")


def freq(*sources: str, base: str = "freq", label: str = "Freq") -> list[dict[str, Any]]:
    """Min and max columns filled from one catalog range column ("2-12")."""
    return [
        {**spec(f"{base}_min_ghz", f"{label} Min", "GHz"), "range_of": list(sources), "end": 0},
        {**spec(f"{base}_max_ghz", f"{label} Max", "GHz"), "range_of": list(sources), "end": 1},
    ]


BAND = "Band (GHz)"
IL = "Insertion Loss (dB)"
RL = "Return Loss (dB)"
ISO = "Isolation (dB)"
AMP_BAL = ("Amp Bal (dB)", "Amplitude Balance (dB)")
PHASE_BAL = ("Phase Bal (°)", "Phase Balance (°)")
WG = [text("waveguide_band", "Waveguide Band", "Waveguide Band"), text("flange", "Flange", "Flange")]

# The spec columns of each product type, and which catalog headings fill them.
# Every type also gets Family and Package first, and Case, ECCN and Notes last.
TYPE_SPECS: dict[str, list[dict[str, Any]]] = {
    "amplifier": [
        *freq(BAND),
        spec("gain_db", "Gain", "dB", "Gain (dB)"),
        spec("nf_db", "NF", "dB", "NF (dB)"),
        spec("op1db_dbm", "OP1dB", "dBm", "OP1dB (dBm)"),
        spec("psat_dbm", "Psat", "dBm", "Psat (dBm)"),
        spec("oip3_dbm", "OIP3", "dBm", "OIP3 (dBm)"),
        text("voltage", "Supply (V)", "Voltage (V)"),
        text("current", "Current (mA)", "Current (mA)"),
    ],
    "attenuator": [
        *freq(BAND),
        spec("attenuation_db", "Attenuation", "dB", "Attenuation (dB)"),
        text("attenuation_range", "Atten Range (dB)", "Attenuation Range (dB)"),
        spec("accuracy_db", "Accuracy", "dB", "Accuracy (dB)"),
        spec("return_loss_db", "Return Loss", "dB", RL),
        *WG,
        text("note", "Note", "Note"),
    ],
    "balun": [
        *freq(BAND, "Band Directionality (GHz)"),
        text("ratio", "Ratio", "Turns Ratio", "Impedance Ratio"),
        spec("loss_db", "Loss", "dB", "Total Insertion Loss as Mode Converter (dB)",
             "Insertion Loss as Mode Converter (dB)", "Loss (dB)"),
        spec("gain_db", "Gain", "dB", "Mode Converter Gain (dB)"),
        spec("amp_bal_db", "Amp Bal", "dB", *AMP_BAL),
        spec("phase_bal_deg", "Phase Bal", "°", *PHASE_BAL),
        spec("isolation_db", "Isolation", "dB", ISO),
        spec("cmrr_db", "CMRR", "dB", "CMRR (dB)"),
        spec("hd2_dbc", "HD2", "dBc", "HD2 (dBc)"),
        spec("hd3_dbc", "HD3", "dBc", "HD3 (dBc)"),
        spec("rise_fall_ps", "Rise/Fall", "ps", "Rise/Fall Time (ps)"),
        text("voltage", "Supply (V)", "Voltage (V)"),
        text("current", "Current (mA)", "Current (mA)"),
    ],
    "bias_tee": [
        *freq(BAND),
        spec("insertion_loss_db", "Loss", "dB", IL, "Loss (dB)"),
        spec("dc_voltage_v", "DC Voltage", "V", "DC Voltage (V)"),
        spec("dc_current_a", "DC Current", "A", "DC Current (A)"),
        spec("dc_isolation_db", "DC Port Isolation", "dB", "DC Port Isolation (dB)"),
        spec("rise_time_ps", "Rise Time", "ps", "Rise Time (ps)"),
        spec("group_delay_ps", "Group Delay", "ps", "Group Delay (ps)"),
    ],
    "coupler": [
        *freq(BAND),
        spec("coupling_db", "Coupling", "dB", "Coupling (dB)", "Mean Coupling (dB)", "Coupling"),
        spec("directivity_db", "Directivity", "dB", "Directivity (dB)", "Corrected Directivity (dB)",
             "Directivity TYP. (dB)"),
        spec("flatness_db", "Flatness", "dB", "Flatness (dB)"),
        spec("vswr", "VSWR", None, "VSWR"),
        spec("insertion_loss_db", "Loss", "dB", "Loss (dB)", IL, "Excess Loss (dB)"),
        spec("pickoff_loss_db", "Pick-Off Loss", "dB", "Pick-Off Loss (dB)"),
        spec("amp_bal_db", "Amp Bal", "dB", *AMP_BAL),
        spec("phase_bal_deg", "Phase Bal", "°", *PHASE_BAL),
        spec("isolation_db", "Isolation", "dB", ISO),
        spec("return_loss_db", "Return Loss", "dB", RL),
        spec("power_w", "Avg Power", "W", "Average Power Handling (W)"),
        *WG,
    ],
    "diplexer": [
        text("kind", "Type", "Type"),
        spec("low_min_ghz", "Low Band Min", "GHz"),
        spec("low_max_ghz", "Low Band Max", "GHz"),
        spec("high_min_ghz", "High Band Min", "GHz"),
        spec("high_max_ghz", "High Band Max", "GHz"),
        spec("isolation_db", "Isolation", "dB", ISO),
    ],
    "equalizer": [
        *freq(BAND),
        spec("low_freq_atten_db", "Low Freq Atten", "dB", "Loss at DC (dB)", "Low Freq Attenuation (dB)"),
        spec("return_loss_db", "Return Loss", "dB", "Typ Return Loss (dB)"),
    ],
    "filter": [
        spec("pass_min_ghz", "Pass Min", "GHz"),
        spec("pass_max_ghz", "Pass Max", "GHz"),
        spec("fc_ghz", "Fc", "GHz", "Fc (GHz)"),
        spec("insertion_loss_db", "IL", "dB", "IL @ Fc (dB)", "Insertion Loss at Center Freq (dB)"),
        spec("return_loss_db", "Return Loss", "dB", "Passband Return Loss (dB)"),
        spec("f30_low_ghz", "30 dB Low", "GHz", "F30dBc Low (GHz)"),
        spec("f3_low_ghz", "3 dB Low", "GHz", "F3dBc Low (GHz)"),
        spec("f1_low_ghz", "1 dB Low", "GHz", "F1dBc Low (GHz)"),
        spec("f1_high_ghz", "1 dB High", "GHz", "F1dBc High (GHz)"),
        spec("f3_high_ghz", "3 dB High", "GHz", "F3dBc High (GHz)"),
        spec("f30_high_ghz", "30 dB High", "GHz", "F30dBc High (GHz)"),
        *freq("Center Freq (GHz)", base="tune", label="Tune"),
        spec("rejection_db", "Rejection", "dB", "Stopband Rejection (dB)"),
        spec("oip3_dbm", "OIP3", "dBm", "OIP3 (dBm)"),
        spec("bands", "Bands", None, "Number of Bands"),
        spec("channel_bw_ghz", "Channel BW", "GHz", "Channel Bandwidth (GHz)"),
        spec("isolation_db", "Isolation", "dB", ISO),
    ],
    "limiter": [
        *freq(BAND),
        spec("insertion_loss_db", "Loss", "dB", "Loss (dB)"),
        text("flat_leakage", "Flat Leakage (dBm)", "Flat Leakage (dBm)"),
        spec("cw_power_w", "CW Power", "W", "Peak Power CW (W)", "Average Power Handling (W)"),
        spec("peak_power_w", "Peak Power", "W", "Peak Power Pulsed (W)", "Peak Power Handling (W)"),
        spec("p1db_dbm", "P1dB", "dBm", "P1dB (dBm)"),
    ],
    "mixer": [
        *freq("RF/LO (GHz)", BAND, base="rf_lo", label="RF/LO"),
        *freq("IF (GHz)", base="if", label="IF"),
        spec("conv_loss_db", "Conv Loss", "dB", "Conversion Loss (dB)"),
        spec("iip3_dbm", "IIP3", "dBm", "IIP3 (dBm)"),
        spec("lo_drive_dbm", "LO Drive", "dBm", "LO Drive (dBm)"),
        spec("image_rej_dbc", "Image Rej", "dBc", "Image Rej (dBc)"),
        spec("lr_isolation_db", "L-R Isolation", "dB", "L-R Isolation (dB)"),
    ],
    "multiplier": [
        text("kind", "Type", "Type"),
        *freq("Input (GHz)", base="input", label="Input"),
        *freq("Output (GHz)", base="output", label="Output"),
        spec("conv_loss_db", "Conv Loss", "dB", "Conversion Loss (dB)"),
        spec("f1_supp_dbc", "1F Supp", "dBc", "1F Supp (dBc)"),
        spec("f3_supp_dbc", "3F Supp", "dBc", "3F Supp (dBc)"),
        spec("input_dbm", "Input Power", "dBm", "Input (dBm)"),
        spec("output_dbm", "Output Power", "dBm", "Output (dBm)"),
        text("bias", "Bias", "Bias (V & mA)"),
    ],
    "oscillator": [
        spec("freq_ghz", "Freq", "GHz", BAND),
        spec("output_power_dbm", "Output Power", "dBm", "Output Power (dBm)"),
        spec("pn_1k_dbc_hz", "PN @ 1 kHz", "dBc/Hz", "PN 1 kHz"),
        spec("pn_10k_dbc_hz", "PN @ 10 kHz", "dBc/Hz", "PN 10 kHz"),
        spec("pn_100k_dbc_hz", "PN @ 100 kHz", "dBc/Hz", "PN 100 kHz"),
        spec("pn_1m_dbc_hz", "PN @ 1 MHz", "dBc/Hz", "PN 1 MHz"),
    ],
    "power_divider": [
        text("kind", "Type", "Type"),
        *freq(BAND),
        spec("insertion_loss_db", "Loss", "dB", "Loss (dB)", "Excess Loss (dB)"),
        spec("amp_bal_db", "Amp Bal", "dB", *AMP_BAL),
        spec("phase_bal_deg", "Phase Bal", "°", *PHASE_BAL),
        spec("isolation_db", "Isolation", "dB", ISO),
    ],
    "switch": [
        *freq(BAND),
        spec("insertion_loss_db", "IL", "dB", "IL (dB)", IL),
        spec("isolation_db", "Isolation", "dB", "ISO RFC-RFX (dB)", ISO),
        spec("rise_fall_ns", "Rise/Fall", "ns", "Rise/Fall Time (ns)"),
        spec("power_w", "Power", "W", "Power Handling (W)"),
        spec("iip3_dbm", "IIP3", "dBm", "IIP3 (dBm)"),
    ],
    "detector": [
        *freq(BAND),
        spec("sensitivity_v_mw", "Sensitivity", "V/mW", "Sensitivity (V/mW)"),
        spec("flatness_db", "Flatness", "dB", "Flatness (dB)"),
        text("operating_range", "Range (dBm)", "Operating range (dBm)"),
        text("flange", "Flange", "Flange"),
    ],
    "isolator": [
        *freq(BAND),
        spec("isolation_db", "Isolation", "dB", ISO),
        spec("insertion_loss_db", "IL", "dB", IL),
        spec("return_loss_db", "Return Loss", "dB", RL),
        *WG,
    ],
    "termination": [
        *freq(BAND),
        spec("impedance_ohm", "Impedance", "Ω", "Impedance (Ω)"),
        spec("return_loss_db", "Return Loss", "dB", RL),
        spec("power_w", "Power", "W", "Power Handling (W)"),
        *WG,
    ],
    "adapter": [
        *freq(BAND),
        spec("vswr", "VSWR", None, "VSWR"),
        text("details", "Details", "Description"),
    ],
    "waveguide": [
        *freq(BAND),
        text("angle", "Angle", "Twist Angle", "Bend Angle"),
        spec("length_in", "Length", "in", "Length (inch)"),
        *WG,
    ],
}

COMMON_FIRST = [text("family", "Family"), text("package", "Package")]
COMMON_LAST = [text("case", "Case", "Package"), text("eccn", "ECCN", "ECCN"), text("notes", "Notes")]

# Catalog headings that the position reader gets slightly wrong, and their real names.
HEADING_FIXES = {
    "Average Power Handling": "Average Power Handling (W)",
    "(W) ECCN": "ECCN",
    "Coupling (dB) IL": "Coupling (dB)",
    "Phase a Bal (°)": "Phase Bal (°)",
    "Phase Bal (º)": "Phase Bal (°)",
    "Current Package ECCN (mA)": "Current (mA)",
    "3F Supp (dBc) (V &": "3F Supp (dBc)",
    "Bias Package mA)": "Package",
    "Packagee": "Package",
    "IL @ fc (dB)": "IL @ Fc (dB)",
    "1 kHz": "PN 1 kHz",
    "Phase Noise 10 kHz": "PN 10 kHz",
    "(dBc/Hz) 100 kHz": "PN 100 kHz",
    "1 MHz": "PN 1 MHz",
}

# Upper-case words kept as they are when a table title is put in sentence case.
KEEP_UPPER = {"IQ", "DC"}


def sentence_case(title: str) -> str:
    words = title.split()
    out = [w if w in KEEP_UPPER else w.lower() for w in words]
    if out:
        out[0] = out[0] if out[0] in KEEP_UPPER else out[0].capitalize()
    return " ".join(out)


SECTION_TO_PACKAGE = {
    "CONNECTORIZED": "Connectorized",
    "WAVEGUIDE": "Waveguide",
    "SURFACE MOUNT": "Surface mount",
    "BARE DIE": "Bare die",
}

# Columns that are a frequency range ("2-12", "DC-40"): split into min and max.
RANGE_HEADINGS = {
    "band (ghz)": ("freq", "Freq"),
    "rf/lo (ghz)": ("rf_lo", "RF/LO"),
    "if (ghz)": ("if", "IF"),
    "input (ghz)": ("input", "Input"),
    "output (ghz)": ("output", "Output"),
    "passband (ghz)": ("pass", "Pass"),
    "band directionality (ghz)": ("freq", "Freq"),
}

# "Better" direction for sorting the parts table (categories.yaml `sort`).
LOWER_IS_BETTER = ("nf", "loss", "vswr", "flatness", "accuracy", "rise", "fall", "delay", "bal", "hd2", "hd3",
                   "pn @")
HIGHER_IS_BETTER = ("gain", "op1db", "p1db", "psat", "oip3", "iip3", "isolation", "directivity",
                    "rej", "return loss", "supp", "cmrr", "power", "sensitivity")

# Values that mean "no value here".
BLANKS = {"", "—", "–", "-", "see datasheet", "n/a", "na", "tbd"}


def product_type_for(title: str) -> tuple[str, str] | None:
    """('filter', 'Bandpass') for 'FIXED FILTERS, Bandpass (cont.)', or None if not a product table."""
    clean = re.sub(r"\s*\(cont\.?\)\s*$", "", title, flags=re.I).strip()
    upper = clean.upper()
    for prefix, type_id in FAMILY_TO_TYPE:
        if upper.startswith(prefix):
            # The family is the part after the comma ("Bandpass"), or the title itself.
            name, _, sub = clean.partition(",")
            return type_id, sub.strip() or sentence_case(name)
    return None


def clean_part_number(text: str) -> str:
    """'✦ MFHP-00001BH-S*' -> 'MFHP-00001BH-S' (new-release marks removed)."""
    return re.sub(r"[✦◆*¹²³]", "", text).strip()


def expand_variants(part: str) -> list[str]:
    """'MM1-0212(L/H/S)S' -> ['MM1-0212LS', 'MM1-0212HS', 'MM1-0212SS'].

    Only a "(a/b/c)" group is expanded. Other brackets, like the connector
    notation in 'DCZ(M-F)29(M-F)29', are part of the part number and kept.
    """
    match = re.search(r"\(([^()]*/[^()]*)\)", part)
    if not match:
        return [part]
    head, tail = part[: match.start()], part[match.end():]
    return [v for option in match.group(1).split("/") for v in expand_variants(head + option.strip() + tail)]


def split_variant_value(value: str, count: int) -> list[str]:
    """'8/8.5/8.5' with 3 variants -> ['8', '8.5', '8.5']; anything else is shared.

    A spaced slash is a list, not one value per version: 'DC-3 / 5-26' is
    both passbands of a diplexer, for every version.
    """
    if " / " in value:
        return [value] * count
    pieces = [p.strip() for p in value.split("/")]
    if count > 1 and len(pieces) == count:
        return pieces
    return [value] * count


def clean_value(text: str) -> str:
    """Strip footnote marks and spacing; '' for "no value" markers."""
    value = re.sub(r"[¹²³⁴*]", "", text or "").strip()
    return "" if value.lower() in BLANKS else value


NUMBER = re.compile(r"^[+]?-?\d+(?:\.\d+)?$")


def as_number(text: str) -> float | int | None:
    """'+23' -> 23, '0.6' -> 0.6, '±0.2' -> 0.2; None if it isn't a plain number."""
    value = clean_value(text).removeprefix("±")
    if not NUMBER.match(value):
        return None
    number = float(value.replace("+", ""))
    return int(number) if number.is_integer() else number


def parse_range(text: str) -> tuple[float | int | None, float | int | None]:
    """'2-12' -> (2, 12); 'DC-40' -> (0, 40); '0.0003-10' -> (0.0003, 10); '24' -> (24, 24)."""
    value = clean_value(text).replace("–", "-").replace(" ", "")
    if not value:
        return None, None
    value = re.sub(r"^DC", "0", value, flags=re.I)
    match = re.match(r"^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$", value)
    if match:
        return as_number(match.group(1)), as_number(match.group(2))
    single = as_number(value)
    return (single, single) if single is not None else (None, None)


def heading_key(heading: str) -> tuple[str, str, str | None]:
    """'Conversion Loss (dB)' -> ('conversion_loss_db', 'Conversion Loss', 'dB')."""
    match = re.match(r"^(.*?)\s*\(([^)]*)\)\s*$", heading.strip())
    label, unit = (match.group(1), match.group(2)) if match else (heading.strip(), None)
    label = re.sub(r"\s+", " ", label).strip()
    unit_slug = {"°": "deg", "º": "deg", "Ω": "ohm", "dBc/Hz": "dbc_hz", "V & mA": "v_ma"}.get(unit or "", unit or "")
    slug = re.sub(r"[^a-z0-9]+", "_", f"{label} {unit_slug}".lower()).strip("_")
    if not re.match(r"^[a-z]", slug):
        slug = f"x_{slug}"
    return slug, label, unit


def sort_direction(label: str) -> str | None:
    lower = label.lower()
    if lower == "il":
        return "asc"
    if any(word in lower for word in HIGHER_IS_BETTER):
        return "desc"
    if any(word in lower for word in LOWER_IS_BETTER):
        return "asc"
    return None


def filter_pass_band(family: str, cells: dict[str, str]) -> tuple[Any, Any]:
    """Pass Min/Max = the 3 dB edges (agreed). Lowpass starts at DC; highpass has no upper edge in the catalog."""
    low = as_number(cells.get("F3dBc Low (GHz)", ""))
    high = as_number(cells.get("F3dBc High (GHz)", ""))
    if family.lower().startswith("lowpass"):
        low = 0
    return low, high


def sanity_problems(type_id: str, values: dict[str, Any]) -> list[str]:
    """Reasons to flag a row for the rep's review (values aren't changed)."""
    problems = []
    for base in ("freq", "rf_lo", "if", "input", "output", "pass", "tune", "low", "high"):
        lo, hi = values.get(f"{base}_min_ghz"), values.get(f"{base}_max_ghz")
        if isinstance(lo, (int, float)) and isinstance(hi, (int, float)) and lo > hi:
            problems.append(f"{base.replace('_', ' ')} range runs backwards ({lo} > {hi})")
    if type_id == "filter":
        order = ["f30_low_ghz", "f3_low_ghz", "f1_low_ghz", "fc_ghz", "f1_high_ghz", "f3_high_ghz", "f30_high_ghz"]
        present = [(k, values[k]) for k in order if isinstance(values.get(k), (int, float))]
        for (k1, v1), (k2, v2) in zip(present, present[1:]):
            if v1 > v2:
                problems.append(f"filter edges out of order: {k1} {v1} > {k2} {v2}")
    return problems

"""Matching between the Google Sheet's tabs/headings and categories.yaml.

Shared by export_sheet_template.py (which writes the friendly headings) and
import_sheet.py (which reads them back).

Tabs:      a tab named like a category's name ("Low Noise Amplifiers") or id
           ("lna"), ignoring capitals and extra spaces. Tabs starting with "_"
           are notes and are ignored.
Headings:  friendly ("Part number", "NF (dB)") or the short keys used in the
           CSVs ("mpn", "nf_db"), ignoring capitals and extra spaces.
"""

from __future__ import annotations

import re
from typing import Any

# Fixed columns: CSV key -> friendly heading in the sheet.
FIXED_HEADINGS = {
    "mpn": "Part number",
    "manufacturer": "Manufacturer",
    "description": "Description",
    "datasheet_url": "Datasheet link",
}

NOTES_PREFIX = "_"


def _norm(text: Any) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip().casefold()


def spec_heading(spec: dict[str, Any]) -> str:
    """'NF (dB)' for number specs with a unit, else just the label."""
    unit = spec.get("unit")
    return f"{spec['label']} ({unit})" if unit else spec["label"]


def headings_for(category: dict[str, Any]) -> list[tuple[str, str]]:
    """[(csv key, friendly heading), ...] in the sheet's column order."""
    return list(FIXED_HEADINGS.items()) + [(s["key"], spec_heading(s)) for s in category["specs"]]


def key_for_heading(heading: Any, category: dict[str, Any]) -> str | None:
    """The CSV key a sheet heading stands for, or None if it isn't known."""
    wanted = _norm(heading)
    if not wanted:
        return None
    for key, friendly in FIXED_HEADINGS.items():
        if wanted in (_norm(key), _norm(friendly)):
            return key
    for spec in category["specs"]:
        if wanted in (_norm(spec["key"]), _norm(spec_heading(spec)), _norm(spec["label"])):
            return spec["key"]
    return None


def is_notes_tab(title: str) -> bool:
    return title.strip().startswith(NOTES_PREFIX)


def category_for_tab(title: str, categories: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The category a tab belongs to, or None."""
    wanted = _norm(title)
    for category in categories:
        if wanted in (_norm(category["id"]), _norm(category["name"])):
            return category
    return None


def tab_title(category: dict[str, Any]) -> str:
    """A valid tab name for a category (Sheets/Excel: max 31 chars, no []:*?/\\)."""
    return re.sub(r"[\[\]:*?/\\]", "-", category["name"])[:31]

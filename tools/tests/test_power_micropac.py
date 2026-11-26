"""Tests for tools/power/micropac.py (Micropac's embedded catalog -> sheet rows)."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "power"))

import micropac  # noqa: E402


def product(model: str, category: str, specs: dict[str, str], **extra) -> dict:
    return {"model": model, "category": category, "package": extra.pop("package", "TO-5"),
            "datasheet": f"https://example.test/{model}.pdf",
            "specs": [{"label": k, "value": v} for k, v in specs.items()], **extra}


class Micropac(unittest.TestCase):
    def test_numbers_and_units(self) -> None:
        self.assertEqual(micropac.number("1KV", {"kv": 1, "v": 0.001}), "1")
        self.assertEqual(micropac.number("0.5KV", {"kv": 1, "v": 0.001}), "0.5")
        self.assertEqual(micropac.number("120mW", {"mw": 1, "w": 1000}), "120")
        self.assertEqual(micropac.number("850nm", {"nm": 1}), "850")
        self.assertEqual(micropac.number("abc"), "")
        self.assertEqual(micropac.v_range("70 – 130 VDC (100 VDC ±5% nominal)"), ("70", "130"))

    def test_categories_map_to_product_types(self) -> None:
        rows, review = micropac.convert([
            product("66092-804", "Standard", {"Number of Channels": "1", "Output Type": "Phototransistor",
                    "Isolation Voltage": "1KV", "Industry Cross-Reference": "JANTXV4N24A"},
                    screening_tier="JAN / Military", space_qualified="Yes", qml=True),
            product("53111-1HPC", "Solid State Relays", {"Relay Configuration": "SPST-NO", "Number of Channels": "Single"},
                    package="8-Pin DIP"),
            product("66092-804", "Standard", {}),  # listed twice
            product("X-1", "Something New", {}),
        ])
        opto = rows["optocoupler"][0]
        self.assertEqual((opto["family"], opto["isolation_kv"], opto["grade"], opto["space"], opto["qml"]),
                         ("Standard", "1", "JAN / Military", "Yes", "Yes"))
        self.assertEqual(opto["description"], "1-channel Phototransistor optocoupler, 1 kV isolation, TO-5")
        self.assertEqual(rows["solid_state_relay"][0]["description"], "Single SPST-NO solid-state relay, 8-Pin DIP")
        self.assertEqual(len(rows["optocoupler"]), 1)
        self.assertTrue(any("twice" in r[2] for r in review))
        self.assertTrue(any("not mapped" in r[2] for r in review))

    def test_reads_the_embedded_catalog(self) -> None:
        page = '<script>const PRODUCTS = [{"model": "A-1", "category": "LEDs"}];\nfunction x(){}</script>'
        self.assertEqual(micropac.products_from_page(page), [{"model": "A-1", "category": "LEDs"}])


if __name__ == "__main__":
    unittest.main()

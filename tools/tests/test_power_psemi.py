"""Tests for tools/power/psemi.py (pSemi's published values -> sheet rows)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "power"))

import psemi  # noqa: E402


def product(link: str, **acf: str) -> dict:
    return {"link": link, "title": {"rendered": acf.pop("title", "FlexiBK&#8482; PE24111")}, "acf": acf}


class Parsing(unittest.TestCase):
    def test_spans(self) -> None:
        self.assertEqual(psemi.span("4.5-18.5"), (4.5, 18.5, True))
        self.assertEqual(psemi.span("12A"), (12, 12, True))
        self.assertEqual(psemi.span("Div 2: 5.7-15<br />Div 3: 8.4-15"), (5.7, 15, False))
        self.assertEqual(psemi.span("7.67 (0.7-1.0Vo)<br />10 (0.4-0.7Vo)")[1], 10)
        self.assertEqual(psemi.span("N/A"), (None, None, True))

    def test_efficiency(self) -> None:
        self.assertEqual(psemi.leading("96"), (96, True))
        self.assertEqual(psemi.leading("90 (3.3Vin/0.5Vo)"), (90, False))
        self.assertEqual(psemi.leading("Div 2: 99%<br />Div 3: 98%"), (99, False))


class Converting(unittest.TestCase):
    def test_buck_row(self) -> None:
        rows, review = psemi.convert([product(
            "https://psemi.com/products/power-management/flexibk-pe24111/",
            product_name="PE24111", product_family_pp="FlexiBK&#8482;", vin_vpp="3.0-3.6", vo_vpp="0.35-0.7",
            io_a_pp="20", efficiency_pp="90 (3.3Vin/0.5Vo)", sw_frequency_khz_pp="1750-2600", package_pp="QFN",
            lifecycle_pp="In Production ", eccn_number_pp="EAR99",
            technical_resource_links="/pdf/datasheets/pe24111ds.pdf\r\n/pdf/app_notes/an1.pdf",
        )])
        row = rows["dc_dc"][0]
        self.assertEqual(row["topology"], "Buck")
        self.assertEqual((row["vin_min_v"], row["vin_max_v"], row["iout_max_a"], row["efficiency_pct"]), ("3", "3.6", "20", "90"))
        self.assertEqual(row["datasheet_url"], "https://psemi.com/pdf/datasheets/pe24111ds.pdf")
        self.assertEqual(row["status"], "In Production")
        self.assertEqual(row["description"], "Buck, 3 to 3.6 V in, up to 20 A")
        self.assertIn("Efficiency: 90 (3.3Vin/0.5Vo)", row["notes"])

    def test_ratio_output_goes_to_notes_and_obsolete_is_left_out(self) -> None:
        rows, review = psemi.convert([
            product("https://psemi.com/products/power-management/flexicp-pe25204/", product_name="PE25204",
                    product_family_pp="FlexiCP&#8482;", vin_vpp="18-60", vo_vpp="Vin/4", io_a_pp="6"),
            product("https://psemi.com/products/power-management/gan-fet-drivers/pe29100/", product_name="PE29100",
                    lifecycle_pp="Obsolete"),
        ])
        row = rows["dc_dc"][0]
        self.assertEqual((row["vout_min_v"], row["vout_max_v"]), ("", ""))
        self.assertIn("Vout: Vin/4", row["notes"])
        self.assertEqual(rows["gate_driver"], [])
        self.assertTrue(any("Obsolete" in r[2] for r in review))


if __name__ == "__main__":
    unittest.main()

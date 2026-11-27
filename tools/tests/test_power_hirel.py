"""Tests for tools/power/hirel.py (Teledyne HiRel's catalog page -> sheet rows)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "power"))

import hirel  # noqa: E402


PAGE = """<script>
const PRODUCTS = [
  { model: 'TDLNA0430SEP', category: 'Low Noise Amplifiers (LNAs)', subcategory: 'Space LNA',
    description: '0.4 to 3.0 GHz LNA with 0.9 dB noise figure, 20 dB gain, 5 V / 80 mA. Space-qualified.',
    freq_range: '0.4-3.0 GHz', eccn: '9A515.e', },
  { model: 'TDA\\'S', category: 'Unknown', description: 'x' },
];
</script>"""


def product(model: str, category: str, description: str, freq_range: str = "", **extra) -> dict:
    return {"model": model, "category": category, "description": description, "freq_range": freq_range, **extra}


class Reading(unittest.TestCase):
    def test_js_array_reads_unquoted_keys_single_quotes_and_trailing_commas(self) -> None:
        items = hirel.js_array(PAGE)
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["model"], "TDLNA0430SEP")
        self.assertEqual(items[0]["eccn"], "9A515.e")
        self.assertEqual(items[1]["model"], "TDA'S")

    def test_ranges_in_ghz(self) -> None:
        self.assertEqual(hirel.ranges("40 MHz to 3.0 GHz"), [(0.04, 3.0)])
        self.assertEqual(hirel.ranges("DC to 20 GHz"), [(0.0, 20.0)])
        self.assertEqual(hirel.ranges("RF/LO 6-26 GHz, IF DC-to-8 GHz"), [(6.0, 26.0), (0.0, 8.0)])

    def test_case_grade_bias(self) -> None:
        self.assertEqual(hirel.grade_of("Radiation-hardened by design"), "Radiation hardened")
        self.assertEqual(hirel.grade_of("full space screening available"), "Space")
        self.assertEqual(hirel.grade_of("commercial part"), "")
        self.assertEqual(hirel.bias("biased at 5 V / 80 mA"), ("+5", "80"))
        self.assertEqual(hirel.bias("runs at +3.3 V only"), ("+3.3", ""))
        self.assertEqual(hirel.fmt(0.1 + 0.2), "0.3")
        self.assertEqual(hirel.fmt(None), "")


class Converting(unittest.TestCase):
    def test_amplifier_row(self) -> None:
        rows, review = hirel.convert(hirel.js_array(PAGE))
        amp = rows["amplifier"][0]
        self.assertEqual((amp["freq_min_ghz"], amp["freq_max_ghz"]), ("0.4", "3"))
        self.assertEqual((amp["nf_db"], amp["gain_db"]), ("0.9", "20"))
        self.assertEqual((amp["voltage"], amp["current"]), ("+5", "80"))
        self.assertEqual(amp["manufacturer"], "Teledyne HiRel")
        self.assertEqual(amp["product_url"], hirel.PAGE)
        self.assertTrue(any("not mapped" in r[2] for r in review))

    def test_duplicate_kept_once_and_reported(self) -> None:
        p = product("TDPA5115QFN", "Driver Amplifiers", "5 to 15 GHz driver", "5-15 GHz")
        rows, review = hirel.convert([p, {**p, "category": "RF Power Amplifiers"}])
        self.assertEqual(len(rows["amplifier"]), 1)
        self.assertIn("kept once", review[0][2])

    def test_description_outside_catalog_range_is_flagged_not_changed(self) -> None:
        rows, review = hirel.convert([product("TDLNA0840SEP", "Low Noise Amplifiers (LNAs)",
                                              "3 to 40 GHz LNA", "8-40 GHz")])
        self.assertEqual(rows["amplifier"][0]["freq_min_ghz"], "3")
        self.assertIn("check the datasheet", review[0][2])

    def test_power_parts(self) -> None:
        rows, review = hirel.convert([
            product("TDG650E15", "GaN HEMTs", "650 V / 15 A GaN HEMT, 100 mΩ (5.0×6.0×0.5 mm)"),
            product("TDPOL1", "Point-of-Load Regulators (POLs)", "3–14 V input, 0.6–5 V output at up to 6 A", "LTB"),
        ])
        fet = rows["power_transistor"][0]
        self.assertEqual((fet["vds_max_v"], fet["id_max_a"], fet["rds_on_mohm"]), ("650", "15", "100"))
        self.assertEqual(fet["case"], "GaNPX (5.0×6.0×0.5 mm)")
        pol = rows["dc_dc"][0]
        self.assertEqual((pol["vin_min_v"], pol["vin_max_v"], pol["iout_max_a"]), ("3", "14", "6"))
        self.assertIn("LTB", pol["notes"])
        self.assertTrue(any("LTB" in r[2] for r in review))

    def test_pll_and_prescaler(self) -> None:
        rows, _ = hirel.convert([
            product("TDPLL1", "PLL Frequency Synthesizers", "Fractional-N PLL, 0.5 to 13 GHz, -230 dBc/Hz FOM, "
                    "prescaler 4/5, 200 MHz max reference", "0.5-13 GHz"),
            product("TDDIV4", "RF Prescalers", "divide-by-4 prescaler, DC to 18 GHz", "DC-18 GHz"),
        ])
        pll = rows["pll"][0]
        self.assertEqual((pll["kind"], pll["fom_dbc_hz"], pll["prescaler"], pll["ref_max_mhz"]),
                         ("Fractional-N", "-230", "4/5", "200"))
        self.assertEqual(rows["prescaler"][0]["divide_by"], "4")
        self.assertEqual(rows["prescaler"][0]["freq_max_ghz"], "18")


if __name__ == "__main__":
    unittest.main()

"""Unit tests for tools/marki/catalog_rules.py (turning catalog cells into sheet values)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "marki"))

import catalog_rules as r  # noqa: E402


class Rules(unittest.TestCase):
    def test_product_type_from_title(self) -> None:
        self.assertEqual(r.product_type_for("FIXED FILTERS, Bandpass (cont.)"), ("filter", "Bandpass"))
        self.assertEqual(r.product_type_for("IQ MIXERS, Integrated Drive"), ("mixer", "Integrated Drive"))
        self.assertEqual(r.product_type_for("MIXERS, Double Balanced"), ("mixer", "Double Balanced"))
        self.assertEqual(r.product_type_for("WAVEGUIDE TWISTS"), ("waveguide", "Waveguide twists"))
        self.assertEqual(r.product_type_for("LEVEL SET ATTENUATORS")[0], "attenuator")
        self.assertIsNone(r.product_type_for("PART NUMBER DECODER"))

    def test_part_numbers(self) -> None:
        self.assertEqual(r.clean_part_number("✦ MFHP-00001BH-S*"), "MFHP-00001BH-S")
        self.assertEqual(r.expand_variants("MM1-0212(L/H/S)S"), ["MM1-0212LS", "MM1-0212HS", "MM1-0212SS"])
        self.assertEqual(r.expand_variants("BTL-0026SMG(-1/-2)"), ["BTL-0026SMG-1", "BTL-0026SMG-2"])
        self.assertEqual(r.expand_variants("DCZ(M-F)29(M-F)29"), ["DCZ(M-F)29(M-F)29"])  # connector notation, kept
        self.assertEqual(r.expand_variants("FB-2400"), ["FB-2400"])

    def test_variant_values(self) -> None:
        self.assertEqual(r.split_variant_value("8/8.5/8.5", 3), ["8", "8.5", "8.5"])
        self.assertEqual(r.split_variant_value("+15", 3), ["+15"] * 3)
        self.assertEqual(r.split_variant_value("1/2", 1), ["1/2"])
        self.assertEqual(r.split_variant_value("DC-0.35 / 0.7-8", 2), ["DC-0.35 / 0.7-8"] * 2)

    def test_values_and_ranges(self) -> None:
        self.assertEqual(r.as_number("+23"), 23)
        self.assertEqual(r.as_number("0.6"), 0.6)
        self.assertEqual(r.as_number("-6.3"), -6.3)
        self.assertEqual(r.as_number("±0.7"), 0.7)  # flatness/accuracy: the ± is implied
        self.assertIsNone(r.as_number("> 30"))
        self.assertIsNone(r.as_number("24/22"))
        self.assertEqual(r.clean_value("-65 ¹"), "-65")
        self.assertEqual(r.clean_value("see datasheet"), "")
        self.assertEqual(r.clean_value("—"), "")
        self.assertEqual(r.parse_range("2-12"), (2, 12))
        self.assertEqual(r.parse_range("DC-40"), (0, 40))
        self.assertEqual(r.parse_range("0.0003-10"), (0.0003, 10))
        self.assertEqual(r.parse_range("0.45-26.5"), (0.45, 26.5))
        self.assertEqual(r.parse_range("24"), (24, 24))
        self.assertEqual(r.parse_range("see datasheet"), (None, None))

    def test_heading_keys_and_sort(self) -> None:
        self.assertEqual(r.heading_key("Conversion Loss (dB)"), ("conversion_loss_db", "Conversion Loss", "dB"))
        self.assertEqual(r.heading_key("Phase Bal (°)"), ("phase_bal_deg", "Phase Bal", "°"))
        self.assertEqual(r.sort_direction("NF"), "asc")
        self.assertEqual(r.sort_direction("Gain"), "desc")
        self.assertEqual(r.sort_direction("Return Loss"), "desc")  # higher return loss is better
        self.assertEqual(r.sort_direction("Phase Bal"), "asc")
        self.assertEqual(r.sort_direction("PN @ 10 kHz"), "asc")
        self.assertEqual(r.sort_direction("Image Rej"), "desc")
        self.assertEqual(r.sort_direction("IL"), "asc")
        self.assertIsNone(r.sort_direction("Flange"))

    def test_filter_pass_band_uses_3db_edges(self) -> None:
        cells = {"F3dBc Low (GHz)": "21.9", "F3dBc High (GHz)": "26.0"}
        self.assertEqual(r.filter_pass_band("Bandpass", cells), (21.9, 26))
        self.assertEqual(r.filter_pass_band("Lowpass", {"F3dBc High (GHz)": "5.0"}), (0, 5))
        self.assertEqual(r.filter_pass_band("Highpass", {"F3dBc Low (GHz)": "9.8"}), (9.8, None))

    def test_sanity_checks(self) -> None:
        self.assertEqual(r.sanity_problems("amplifier", {"freq_min_ghz": 2, "freq_max_ghz": 18}), [])
        self.assertTrue(r.sanity_problems("amplifier", {"freq_min_ghz": 18, "freq_max_ghz": 2}))
        bad = {"f30_low_ghz": 24.0, "f3_low_ghz": 21.9, "fc_ghz": 24.0, "f3_high_ghz": 26.0}
        self.assertTrue(any("out of order" in p for p in r.sanity_problems("filter", bad)))


class Slopes(unittest.TestCase):
    def test_equalizer_rows_split_per_slope(self) -> None:
        cells = {"Low Freq Attenuation (dB)": "3*, 6 , 10", "Typ Return Loss (dB)": "26, 26, 27", "Band (GHz)": "DC-7"}
        out = r.expand_slopes("MEQX-7ASM", cells)
        self.assertEqual([m for m, _ in out], ["MEQ3-7ASM", "MEQ6-7ASM", "MEQ10-7ASM"])
        self.assertEqual(out[2][1]["Low Freq Attenuation (dB)"], "10")
        self.assertEqual(out[2][1]["Typ Return Loss (dB)"], "27")
        self.assertEqual(out[0][1]["Band (GHz)"], "DC-7")

    def test_connectorized_heading_and_unpaired_values(self) -> None:
        out = r.expand_slopes("EQX-40", {"Loss at DC (dB)": "3, 6", "Typ Return Loss (dB)": "18"})
        self.assertEqual([m for m, _ in out], ["EQ3-40", "EQ6-40"])
        self.assertEqual(out[1][1]["Typ Return Loss (dB)"], "18")  # one value: shared

    def test_other_parts_unchanged(self) -> None:
        self.assertEqual(r.expand_slopes("MEQ10-50AU", {"Loss at DC (dB)": "10"}), [("MEQ10-50AU", {"Loss at DC (dB)": "10"})])
        self.assertEqual(r.expand_slopes("MXQ-1", {"Low Freq Attenuation (dB)": "3, 6"})[0][0], "MXQ-1")


if __name__ == "__main__":
    unittest.main()

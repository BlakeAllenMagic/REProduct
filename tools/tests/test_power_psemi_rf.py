"""Tests for tools/power/psemi_rf.py (pSemi's published RF values -> sheet rows)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "power"))

import psemi_rf  # noqa: E402


def product(section: str, name: str, **acf) -> dict:
    return {
        "link": f"https://psemi.com/products/{section}/{name.lower()}/",
        "title": {"rendered": name},
        "acf": {"product_name": name, "lifecycle": "In Production",
                "technical_resource_links": f"https://psemi.com/wp-content/uploads/pdf/datasheets/{name.lower()}ds.pdf",
                **acf},
    }


class Values(unittest.TestCase):
    def test_frequencies_in_ghz_without_exponents(self) -> None:
        self.assertEqual(psemi_rf.ghz("300 MHz"), 0.3)
        self.assertEqual(psemi_rf.ghz("DC"), 0.0)
        self.assertEqual(psemi_rf.fmt(psemi_rf.ghz("9 kHz")), "0.000009")
        self.assertEqual(psemi_rf.ghz("6.025 GHz"), 6.025)
        self.assertIsNone(psemi_rf.ghz("see datasheet"))

    def test_switching_time_in_ns(self) -> None:
        self.assertEqual(psemi_rf.ns("100 ns"), 100)
        self.assertEqual(psemi_rf.ns("38 µs"), 38000)
        self.assertEqual(psemi_rf.fmt(psemi_rf.ns("0.008 µs")), "8")


class Converting(unittest.TestCase):
    def test_switch(self) -> None:
        rows, _ = psemi_rf.convert_rf([product(
            "rf-switches/low-il-rf-switches", "PE423213", description="SPDT (R)", type="50Ω",
            min_freq="300 MHz", max_freq="10.6 GHz", typ_il_db="0.4 @ 6 GHz", max_typ_il_db="0.7 @ 10.6 GHz",
            min_typ_iso_db="18 @ 10.6 GHz", max_typ_iso_db="25 @ 8.5 GHz", switching_time="100 ns",
            max_power_rating_dbm="21", package="6L DFN", package_mm="1.6x1.6", eccn_number="EAR99")])
        r = rows["switch"][0]
        self.assertEqual((r["configuration"], r["impedance"], r["family"]), ("SPDT reflective", "50Ω", "Low insertion loss"))
        self.assertEqual((r["freq_min_ghz"], r["freq_max_ghz"], r["insertion_loss_db"], r["isolation_db"]), ("0.3", "10.6", "0.4", "18"))
        self.assertEqual((r["switching_ns"], r["max_power_dbm"], r["case"]), ("100", "21", "6L DFN (1.6x1.6 mm)"))
        self.assertIn("IL: 0.4 @ 6 GHz / 0.7 @ 10.6 GHz dB", r["notes"])
        self.assertEqual(r["description"], "SPDT reflective RF switch, 300 MHz to 10.6 GHz")
        self.assertTrue(r["datasheet_url"].endswith("/datasheets/pe423213ds.pdf"))

    def test_attenuator_steps_never_look_like_dates(self) -> None:
        rows, _ = psemi_rf.convert_rf([product(
            "rf-attenuators/general-purpose-rf-digital-step-attenuators", "PE43205", bits="2",
            attn_step_db="6/12/18", **{"Attn Range (dB)": "0–18.0"})])
        r = rows["attenuator"][0]
        self.assertEqual((r["step_db"], r["attenuation_range"], r["bits"]), ("6, 12, 18", "0 to 18.0", "2"))

    def test_obsolete_left_out_last_time_buy_kept_without_eol_notice_as_datasheet(self) -> None:
        old = product("rf-switches/broadband-rf-switches", "PE1", lifecycle="Obsolete")
        ltb = product("rf-mixers-limiters/prescalers", "PE35400", lifecycle="Last Time Buy", divide_ratio="4",
                      technical_resource_links="https://psemi.com/wp-content/uploads/pdf/PCNs/pe35400eol.pdf")
        rows, review = psemi_rf.convert_rf([old, ltb])
        self.assertEqual(rows["switch"], [])
        r = rows["prescaler"][0]
        self.assertEqual((r["notes"], r["datasheet_url"], r["divide_by"]), ("Last Time Buy", "", "4"))
        self.assertTrue(any("Obsolete" in line[2] for line in review))

    def test_new_types(self) -> None:
        rows, _ = psemi_rf.convert_rf([
            product("rf-phase-amplitude-control/phase-shifters", "PE44820", description="8-bit DPS",
                    dps_rangestep_deg__bits="358.6/1.4/8", typ_il_db="6"),
            product("rf-phase-amplitude-control/digital-tunable-capacitors-dtcs", "PE64909",
                    description="4-bit; 16 states", min_typ_shunt_capacitance_pf="0.6", max_typ_shunt_capacitance_pf="2.35"),
            product("front-end-modules/2-4-ghz-iot-fems", "PE566212", typ_tx_gain_db="21", rx_nf_db="1.8"),
        ])
        ps = rows["phase_shifter"][0]
        self.assertEqual((ps["phase_range_deg"], ps["phase_step_deg"], ps["bits"]), ("358.6", "1.4", "8"))
        dtc = rows["tunable_capacitor"][0]
        self.assertEqual((dtc["c_min_pf"], dtc["c_max_pf"], dtc["bits"]), ("0.6", "2.35", "4"))
        fem = rows["front_end_module"][0]
        self.assertEqual((fem["tx_gain_db"], fem["rx_nf_db"], fem["kind"]), ("21", "1.8", "2.4 GHz IoT FEM"))

    def test_power_products_are_left_to_psemi_py(self) -> None:
        rows, review = psemi_rf.convert_rf([product("power-management/flexibk", "PE25200")])
        self.assertEqual(sum(len(r) for r in rows.values()), 0)
        self.assertEqual(review, [])


if __name__ == "__main__":
    unittest.main()

"""Tests for tools/build_linecard.py.

Run from the repo root:
    python3 -m unittest discover tools/tests

Each broken-data test copies the real data/ folder into a temp directory,
breaks one thing, runs the tool, and checks that it fails with a clear
message and leaves the existing output file alone.
"""

from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
# Sample data for tests, independent of the real parts list (tests/fixtures/README.md).
FIXTURES = REPO / "tests" / "fixtures"
sys.path.insert(0, str(REPO / "tools"))

import build_linecard  # noqa: E402

VERSION = "2026-11-18T14:00:00Z"
SHA = "a" * 64


class BuildTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.data = self.tmp / "data"
        shutil.copytree(FIXTURES / "data", self.data)
        self.out = self.tmp / "linecard.json"

    def run_tool(self, *extra: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = build_linecard.main(
                ["--data", str(self.data), "--out", str(self.out), "--data-version", VERSION, *extra]
            )
        return code, out.getvalue(), err.getvalue()

    def edit(self, relpath: str, old: str, new: str) -> None:
        path = self.data / relpath
        text = path.read_text(encoding="utf-8")
        self.assertIn(old, text, f"test setup: {old!r} not found in {relpath}")
        path.write_text(text.replace(old, new, 1), encoding="utf-8")

    def assert_fails(self, *messages: str) -> str:
        """Build must fail, mention every message, and not touch the output file."""
        self.out.write_text("previous good output", encoding="utf-8")
        code, _, err = self.run_tool()
        self.assertEqual(code, 1, err)
        for message in messages:
            self.assertIn(message, err)
        self.assertEqual(self.out.read_text(encoding="utf-8"), "previous good output")
        return err


class GoodDataTests(BuildTestCase):
    def test_real_data_builds(self) -> None:
        code, out, err = self.run_tool()
        self.assertEqual(code, 0, err)
        self.assertIn("Wrote", out)
        card = json.loads(self.out.read_text(encoding="utf-8"))

        self.assertEqual(card["dataVersion"], VERSION)
        self.assertEqual([c["id"] for c in card["categories"]], ["lna", "mixer", "filter"])
        for category in card["categories"]:
            count = sum(p["category"] == category["id"] for p in card["parts"])
            self.assertTrue(3 <= count <= 5, f"{category['id']} has {count} parts")

    def test_part_shape_matches_claude_md(self) -> None:
        self.run_tool()
        card = json.loads(self.out.read_text(encoding="utf-8"))
        part = next(p for p in card["parts"] if p["id"] == "acme-alm1234")
        self.assertEqual(part["category"], "lna")
        self.assertEqual(part["manufacturer"], "Acme RF")
        self.assertEqual(part["mpn"], "ALM-1234")
        self.assertEqual(part["specs"]["freq_min_ghz"], 0.5)
        self.assertEqual(part["specs"]["nf_db"], 0.6)
        self.assertEqual(
            set(part["datasheet"]), {"sourceUrl", "file", "sha256", "bytes", "updated", "changed"}
        )
        # This part has a sample datasheet from tools/make_sample_datasheets.py.
        self.assertRegex(part["datasheet"]["sha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(part["datasheet"]["file"], f"datasheets/{part['datasheet']['sha256']}.pdf")

    def test_part_without_datasheet_has_nulls(self) -> None:
        self.run_tool()
        card = json.loads(self.out.read_text(encoding="utf-8"))
        part = next(p for p in card["parts"] if p["id"] == "kestrel-kln4020")
        self.assertIsNone(part["datasheet"]["sha256"])
        self.assertIsNone(part["datasheet"]["file"])

    def test_unit_suffix_matching_column_is_accepted(self) -> None:
        self.edit("parts/lna.csv", ",0.6,18,", ",0.6 dB,18,")
        code, _, err = self.run_tool()
        self.assertEqual(code, 0, err)

    def test_empty_optional_spec_is_left_out(self) -> None:
        self.run_tool()
        card = json.loads(self.out.read_text(encoding="utf-8"))
        part = next(p for p in card["parts"] if p["id"] == "kestrel-kln4020")
        self.assertNotIn("op1db_dbm", part["specs"])

    def test_excel_bom_is_ignored(self) -> None:
        path = self.data / "parts" / "lna.csv"
        path.write_bytes(b"\xef\xbb\xbf" + path.read_bytes())
        code, _, err = self.run_tool()
        self.assertEqual(code, 0, err)

    def test_datasheet_record_is_merged(self) -> None:
        record = {"acme-alm1234": {"sha256": SHA, "bytes": 2483112, "updated": "2026-10-02"}}
        (self.data / "datasheets.json").write_text(json.dumps(record), encoding="utf-8")
        self.run_tool()
        card = json.loads(self.out.read_text(encoding="utf-8"))
        part = next(p for p in card["parts"] if p["id"] == "acme-alm1234")
        self.assertEqual(part["datasheet"]["file"], f"datasheets/{SHA}.pdf")
        self.assertEqual(part["datasheet"]["bytes"], 2483112)

    def test_check_mode_writes_nothing(self) -> None:
        code, out, _ = self.run_tool("--check")
        self.assertEqual(code, 0)
        self.assertIn("Nothing written", out)
        self.assertFalse(self.out.exists())


class BrokenCsvTests(BuildTestCase):
    def test_unknown_column(self) -> None:
        self.edit("parts/lna.csv", "supply_v,", "supply_volts,")
        self.assert_fails("unknown column 'supply_volts'", "missing column 'supply_v'")

    def test_missing_required_fixed_field(self) -> None:
        self.edit("parts/lna.csv", "Acme RF,ALM-2280,", "Acme RF,,")
        self.assert_fails("lna.csv:3: mpn is required")

    def test_missing_required_spec(self) -> None:
        self.edit("parts/lna.csv", ",0.6,18,", ",,18,")
        self.assert_fails("lna.csv:2: nf_db is required")

    def test_duplicate_part_in_same_file(self) -> None:
        self.edit("parts/lna.csv", "Acme RF,ALM-2280,", "Acme RF,ALM-1234,")
        self.assert_fails("lna.csv:3: duplicate part Acme RF ALM-1234")

    def test_duplicate_part_across_files_ignores_case(self) -> None:
        self.edit("parts/mixer.csv", "Acme RF,AMX-0750,", "acme rf,alm-1234,")
        self.assert_fails("duplicate part acme rf alm-1234")

    def test_duplicate_reported_even_if_first_copy_is_broken(self) -> None:
        self.edit("parts/lna.csv", ",0.6,18,", ",0.6 GHz,18,")
        self.edit("parts/lna.csv", "Acme RF,ALM-2280,", "Acme RF,ALM-1234,")
        self.assert_fails("expected dB", "duplicate part Acme RF ALM-1234")

    def test_wrong_unit(self) -> None:
        self.edit("parts/lna.csv", ",0.6,18,", ",0.6 GHz,18,")
        self.assert_fails("lna.csv:2: nf_db: '0.6 GHz' has unit GHz, expected dB")

    def test_unit_case_matters(self) -> None:
        # MHz vs mHz is a factor of a billion, so units are case-sensitive.
        self.edit("parts/lna.csv", ",0.5,6,", ",0.5 ghz,6,")
        self.assert_fails("has unit ghz, expected GHz")

    def test_not_a_number(self) -> None:
        self.edit("parts/lna.csv", ",0.6,18,", ",low,18,")
        self.assert_fails("nf_db: 'low' is not a number")

    def test_http_url_rejected(self) -> None:
        self.edit("parts/lna.csv", "https://reproduct.pages.dev/sample-upstream/ALM-1234", "http://reproduct.pages.dev/sample-upstream/ALM-1234")
        self.assert_fails("datasheet_url must start with https://")

    def test_csv_without_category(self) -> None:
        shutil.copy(self.data / "parts" / "lna.csv", self.data / "parts" / "switch.csv")
        self.assert_fails("switch.csv: no category with this id")

    def test_groups_are_carried_to_the_app(self) -> None:
        self.edit("categories.yaml", "categories:\n", "groups: [RF, Misc]\n\ncategories:\n")
        for cid in ("lna", "mixer", "filter"):
            self.edit("categories.yaml", f"  - id: {cid}\n", f"  - id: {cid}\n    group: RF\n")
        code, _, err = self.run_tool()
        self.assertEqual(code, 0, err)
        card = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(card["groups"], ["RF", "Misc"])
        self.assertEqual({c["group"] for c in card["categories"]}, {"RF"})

    def test_unknown_or_missing_group(self) -> None:
        self.edit("categories.yaml", "categories:\n", "groups: [RF]\n\ncategories:\n")
        self.edit("categories.yaml", "  - id: lna\n", "  - id: lna\n    group: Optical\n")
        self.edit("categories.yaml", "  - id: mixer\n", "  - id: mixer\n    group: RF\n")
        self.assert_fails("category 'lna': group must be one of RF", "category 'filter': group must be one of RF")

    def test_group_without_groups_list(self) -> None:
        self.edit("categories.yaml", "  - id: lna\n", "  - id: lna\n    group: RF\n")
        self.assert_fails('has no "groups" list')

    def test_category_without_csv(self) -> None:
        (self.data / "parts" / "mixer.csv").unlink()
        self.assert_fails("missing CSV for category 'mixer'")

    def test_extra_cells(self) -> None:
        self.edit("parts/lna.csv", "2x2 mm DFN", "2x2 mm DFN,oops")
        self.assert_fails("lna.csv:2: more cells than header columns")

    def test_not_utf8(self) -> None:
        path = self.data / "parts" / "lna.csv"
        path.write_bytes(path.read_bytes() + "Acme RF,X-1,\xb5 test,https://a.example/x.pdf,1,2\n".encode("latin-1"))
        self.assert_fails("not UTF-8")

    def test_all_errors_reported_at_once(self) -> None:
        self.edit("parts/lna.csv", ",0.6,18,", ",low,18,")
        self.edit("parts/mixer.csv", ",7.2,22,", ",7.2 GHz,22,")
        err = self.assert_fails("lna.csv", "mixer.csv")
        self.assertIn("2 errors", err)


class TabNameTests(BuildTestCase):
    def test_category_names_must_fit_a_sheet_tab(self) -> None:
        self.edit("categories.yaml", "name: Filters", "name: Filters and Very Long Product Type Names")
        self.assert_fails("longer than 31 characters")


class LinkTests(BuildTestCase):
    """The datasheet link is optional; a product page can be given instead."""

    def part(self, card: dict, part_id: str) -> dict:
        return next(p for p in card["parts"] if p["id"] == part_id)

    def test_datasheet_link_may_be_empty(self) -> None:
        self.edit("parts/lna.csv", "https://kestrel.example/pdf/KLN-4020.pdf", "")
        code, _, err = self.run_tool()
        self.assertEqual(code, 0, err)
        card = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertIsNone(self.part(card, "kestrel-kln4020")["datasheet"]["sourceUrl"])

    def test_product_page_is_published(self) -> None:
        self.run_tool()
        card = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(self.part(card, "acme-alm2280")["productUrl"], "https://manufacturer.example/products/alm-2280")
        self.assertIsNone(self.part(card, "acme-alm1234")["productUrl"])

    def test_product_page_must_be_https(self) -> None:
        self.edit("parts/lna.csv", "https://manufacturer.example/products/alm-2280", "http://manufacturer.example/products/alm-2280")
        self.assert_fails("product_url must start with https://")

    def test_found_link_fills_a_blank_but_never_replaces_the_sheet_link(self) -> None:
        # Blank ALM-2280's link in the sheet; ALM-1234 keeps its own.
        self.edit("parts/lna.csv", "https://manufacturer.example/ALM-2280.pdf", "")
        (self.data / "datasheet-links.json").write_text(json.dumps({
            "acme-alm2280": {"url": "https://distributor.example/ALM-2280.pdf", "checked": "2026-11-26"},
            "acme-alm1234": {"url": "https://distributor.example/ALM-1234.pdf", "checked": "2026-11-26"},
            "acme-afh1000": {"url": None, "checked": "2026-11-26"},
        }), encoding="utf-8")
        code, _, err = self.run_tool()
        self.assertEqual(code, 0, err)
        card = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(self.part(card, "acme-alm2280")["datasheet"]["sourceUrl"], "https://distributor.example/ALM-2280.pdf")
        self.assertNotIn("distributor", self.part(card, "acme-alm1234")["datasheet"]["sourceUrl"])

    def test_older_csvs_without_the_product_page_column_still_work(self) -> None:
        path = self.data / "parts" / "mixer.csv"
        rows = [line.split(",") for line in path.read_text(encoding="utf-8").splitlines()]
        i = rows[0].index("product_url")
        path.write_text("\n".join(",".join(r[:i] + r[i + 1:]) for r in rows) + "\n", encoding="utf-8")
        code, _, err = self.run_tool()
        self.assertEqual(code, 0, err)


class BrokenYamlTests(BuildTestCase):
    def test_bad_spec_type(self) -> None:
        self.edit("categories.yaml", "label: NF,       unit: dB,  type: number", "label: NF,       unit: dB,  type: float")
        self.assert_fails("spec 'nf_db': type must be number or text")

    def test_misspelled_field(self) -> None:
        self.edit("categories.yaml", "type: number, required: true }", "type: number, requird: true }")
        self.assert_fails("unknown field 'requird'")

    def test_bad_sort(self) -> None:
        self.edit("categories.yaml", "sort: asc, required: true", "sort: up, required: true")
        self.assert_fails("sort must be asc or desc")

    def test_unit_on_text_spec(self) -> None:
        self.edit("categories.yaml", "{ key: technology,        label: Tech,      type: text }",
                  "{ key: technology,        label: Tech, unit: GHz, type: text }")
        self.assert_fails("text specs can't have a unit")

    def test_duplicate_category(self) -> None:
        self.edit("categories.yaml", "- id: mixer", "- id: lna")
        self.assert_fails("duplicate category id")

    def test_invalid_yaml(self) -> None:
        (self.data / "categories.yaml").write_text("categories: [unclosed", encoding="utf-8")
        self.assert_fails("not valid YAML")


class BrokenDatasheetRecordTests(BuildTestCase):
    def write_records(self, records: object) -> None:
        (self.data / "datasheets.json").write_text(json.dumps(records), encoding="utf-8")

    def test_bad_hash(self) -> None:
        self.write_records({"acme-alm1234": {"sha256": "xyz", "bytes": 10, "updated": "2026-10-02"}})
        self.assert_fails("sha256 must be 64 lowercase hex characters")

    def test_stale_record_is_only_a_warning(self) -> None:
        self.write_records({"gone-part": {"sha256": SHA, "bytes": 10, "updated": "2026-10-02"}})
        code, _, err = self.run_tool()
        self.assertEqual(code, 0, err)
        self.assertIn("warning:", err)
        self.assertIn("gone-part", err)


class ExcelDamageWarningTests(BuildTestCase):
    def assert_warns(self, *messages: str) -> None:
        """Build still succeeds, but prints a warning containing each message."""
        code, _, err = self.run_tool()
        self.assertEqual(code, 0, err)
        self.assertIn("warning:", err)
        for message in messages:
            self.assertIn(message, err)

    def test_real_data_has_no_warnings(self) -> None:
        code, _, err = self.run_tool()
        self.assertEqual(code, 0, err)
        self.assertNotIn("warning:", err)

    def test_package_lost_leading_zero(self) -> None:
        self.edit("parts/filter.csv", ",LTCC,0603", ",LTCC,603")
        self.assert_warns("filter.csv:3: package:", "was it '0603'?")

    def test_mpn_turned_into_date(self) -> None:
        self.edit("parts/lna.csv", "Acme RF,ALM-2280,", "Acme RF,Mar-10,")
        self.assert_warns("lna.csv:3: mpn:", "looks like a date")

    def test_mpn_turned_into_day_month_date(self) -> None:
        self.edit("parts/lna.csv", "Acme RF,ALM-2280,", "Acme RF,1-Mar,")
        self.assert_warns("looks like a date")

    def test_mpn_turned_into_scientific_notation(self) -> None:
        self.edit("parts/lna.csv", "Acme RF,ALM-2280,", "Acme RF,2.00E+10,")
        self.assert_warns("scientific notation")

    def test_real_all_caps_part_number_not_flagged(self) -> None:
        self.edit("parts/lna.csv", "Acme RF,ALM-2280,", "Acme RF,MAR-10,")
        code, _, err = self.run_tool()
        self.assertEqual(code, 0, err)
        self.assertNotIn("warning:", err)

    def test_four_digit_package_not_flagged(self) -> None:
        # "1008" is a real chip size and has no leading zero to lose.
        code, _, err = self.run_tool()
        self.assertNotIn("'1008'", err)


class HelperTests(unittest.TestCase):
    def test_part_id(self) -> None:
        self.assertEqual(build_linecard.make_part_id("Acme RF", "ALM-1234"), "acme-alm1234")

    def test_parse_number(self) -> None:
        parse = build_linecard.parse_number
        self.assertEqual(parse("6", "GHz"), (6, None))
        self.assertEqual(parse("-3.5dBm", "dBm"), (-3.5, None))
        self.assertEqual(parse("1e3", None), (1000, None))
        self.assertIsNotNone(parse("6 GHz", None)[1])
        self.assertIsNotNone(parse("1,5", "dB")[1])


if __name__ == "__main__":
    unittest.main()


class DiagramBlocksTest(unittest.TestCase):
    """Every drawn block opens a product type, and every block named in
    categories.yaml exists in a drawing (catches a typo or a deleted block).
    DAC and ADC are drawn but have no product type yet."""

    UNMAPPED_OK = {"adc", "dac"}

    def test_blocks_match_drawings(self) -> None:
        import re
        root = Path(__file__).resolve().parents[2]
        drawn: list[str] = []
        for svg in sorted((root / "src" / "diagram").glob("*.svg")):
            drawn += re.findall(r'<[a-z]+[^>]* data-block="([^".]+)"', svg.read_text(encoding="utf-8"))
        self.assertEqual(len(drawn), len(set(drawn)), "block ids must be unique across drawings")
        cats = build_linecard.load_categories(root / "data" / "categories.yaml", build_linecard.Report())
        mapped = {b for c in cats for b in c.get("blocks", [])}
        self.assertEqual(sorted(mapped - set(drawn)), [], "blocks in categories.yaml with no drawing")
        self.assertEqual(sorted(set(drawn) - mapped - self.UNMAPPED_OK), [], "drawn blocks with no product type")

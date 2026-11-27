"""Tests for tools/e2v/e2v_catalog.py (a saved e2v product page -> sheet rows)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "e2v"))

import e2v_catalog  # noqa: E402

PAGE = """<html><body><table>
<tr><th>Device Name</th><th>Channels</th><th>Rate</th><th>Resolution</th><th>Datasheet</th></tr>
<tr><td><a href="https://semiconductors.teledyne-e2v.com/products/dac/?model=EV12DS400A">EV12DS400A</a></td>
    <td>1</td><td>4.5GSps</td><td>12-bit</td><td><button>Download</button></td></tr>
<tr><td colspan="5">Performance Resolution: 12-bit Rate: 4.5GSps Physical Package: fpBGA 196
    Compliance Temperature Range: -65 to +150C</td></tr>
<tr><td><a href="https://semiconductors.teledyne-e2v.com/products/dac/?model=EV99NEW">EV99NEW</a></td>
    <td>2</td><td>10 GSps</td><td>14-bit</td><td></td></tr>
<tr><td colspan="5">Physical Package: CBGA480 Compliance Temperature Range: -55 to +125C</td></tr>
</table></body></html>"""


class E2vCatalog(unittest.TestCase):
    def setUp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "page.html"
            path.write_text(PAGE, encoding="utf-8")
            self.rows, self.review = e2v_catalog.convert(e2v_catalog.read_table(e2v_catalog.page_html(path)))

    def test_table_values(self) -> None:
        new = self.rows[1]
        self.assertEqual((new["mpn"], new["channels"], new["rate_gsps"], new["resolution_bits"]),
                         ("EV99NEW", "2", "10", "14"))
        self.assertEqual((new["package"], new["temp_range"]), ("CBGA480", "-55 to +125°C"))
        self.assertTrue(new["product_url"].endswith("model=EV99NEW"))
        self.assertEqual(new["manufacturer"], "Teledyne e2v")

    def test_datasheet_facts_fill_in_and_correct(self) -> None:
        known = self.rows[0]
        self.assertEqual((known["bandwidth_ghz"], known["power_w"]), ("7", "2.6"))
        # The page's -65 to +150 is the storage range; the datasheet's operating range is used.
        self.assertEqual(known["temp_range"], "-55 to +125°C")

    def test_unknown_part_is_listed_for_review(self) -> None:
        self.assertEqual([r[0] for r in self.review], ["EV99NEW"])


if __name__ == "__main__":
    unittest.main()

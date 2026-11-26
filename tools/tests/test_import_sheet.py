"""Tests for tools/import_sheet.py (the Google Sheet import).

Each test builds a real Excel file the way Google exports a sheet, optionally
serves it from a local fake "Google", and checks what the import does.
Nothing here touches the real internet.
"""

from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from openpyxl import Workbook

REPO = Path(__file__).resolve().parents[2]
# Sample data for tests, independent of the real parts list (tests/fixtures/README.md).
FIXTURES = REPO / "tests" / "fixtures"
sys.path.insert(0, str(REPO / "tools"))

import export_sheet_template  # noqa: E402
import import_sheet  # noqa: E402


class ImportTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.data = self.tmp / "data"
        shutil.copytree(FIXTURES / "data", self.data)
        self.status = self.tmp / "import-status.json"
        self.xlsx = self.tmp / "sheet.xlsx"
        # Start from the starter sheet made from the current data.
        with redirect_stdout(io.StringIO()):
            export_sheet_template.main(["--data", str(self.data), "--out", str(self.xlsx)])

    def run_import(self, *args: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = import_sheet.main(
                ["--data", str(self.data), "--status", str(self.status), *(args or ("--xlsx", str(self.xlsx)))]
            )
        return code, out.getvalue(), err.getvalue()

    def edit(self, change) -> None:
        """Open the sheet file, let `change(book)` edit it, save it."""
        from openpyxl import load_workbook

        book = load_workbook(self.xlsx)
        change(book)
        book.save(self.xlsx)

    def csv(self, category: str) -> str:
        return (self.data / "parts" / f"{category}.csv").read_text(encoding="utf-8")

    def status_json(self) -> dict:
        return json.loads(self.status.read_text(encoding="utf-8"))


class GoodSheets(ImportTestCase):
    def test_starter_sheet_imports_as_unchanged(self) -> None:
        before = {p.name: p.read_text() for p in (self.data / "parts").glob("*.csv")}
        code, out, err = self.run_import()
        self.assertEqual(code, 0, err)
        self.assertIn("Sheet unchanged", out)
        self.assertEqual({p.name: p.read_text() for p in (self.data / "parts").glob("*.csv")}, before)
        self.assertTrue(self.status_json()["ok"])

    def test_an_edit_is_imported(self) -> None:
        self.edit(lambda b: b["Filters"].cell(row=2, column=3, value="Edited description"))
        code, out, err = self.run_import()
        self.assertEqual(code, 0, err)
        self.assertIn("Sheet changed", out)
        self.assertIn("Edited description", self.csv("filter"))
        self.assertIsNotNone(self.status_json()["importedAt"])

    def test_tabs_by_id_any_capitals_and_notes_tabs_ignored(self) -> None:
        def change(book):
            book["Low Noise Amplifiers"].title = "LNA"
            book["Mixers"].title = "mixer"  # the category's short id
            book.create_sheet("_My notes").append(["anything", "at all"])
        self.edit(change)
        code, out, err = self.run_import()
        self.assertEqual(code, 0, err)
        self.assertIn("Sheet unchanged", out)

    def test_short_key_headings_and_any_column_order(self) -> None:
        def change(book):
            sheet = book["Mixers"]
            sheet.cell(row=1, column=1, value="mpn")  # short key instead of "Part number"
            sheet.move_range("A1:A10", cols=20)  # part number column moved to the far right
        self.edit(change)
        code, out, err = self.run_import()
        self.assertEqual(code, 0, err)
        self.assertIn("Sheet unchanged", out)

    def test_numbers_come_out_without_trailing_zeros(self) -> None:
        self.edit(lambda b: b["Filters"].cell(row=2, column=7, value=6.0))  # Pass Max
        self.run_import()
        self.assertIn(",2.4,6,", self.csv("filter"))
        self.assertNotIn("6.0", self.csv("filter"))

    def test_blank_rows_are_skipped_and_row_numbers_still_match(self) -> None:
        def change(book):
            sheet = book["Filters"]
            sheet.insert_rows(3)  # a blank row 3
            sheet.cell(row=5, column=8, value="1.2 GHz")  # IL in sheet row 5
        self.edit(change)
        code, out, err = self.run_import()
        self.assertIn("Filters tab, row 5: IL (dB): '1.2 GHz' has unit GHz, expected dB", out)

    def test_the_status_file_only_changes_when_its_content_does(self) -> None:
        self.run_import()
        first = self.status.stat().st_mtime_ns
        self.run_import()
        self.assertEqual(self.status.stat().st_mtime_ns, first)


class ProblemSheets(ImportTestCase):
    def assert_problem(self, text: str) -> None:
        before = {p.name: p.read_text() for p in (self.data / "parts").glob("*.csv")}
        code, out, err = self.run_import()
        self.assertEqual(code, 0, err)  # problems are reported in the app, not by failing the job
        self.assertIn("nothing was imported", out)
        status = self.status_json()
        self.assertFalse(status["ok"])
        self.assertTrue(any(text in p for p in status["problems"]), status["problems"])
        after = {p.name: p.read_text() for p in (self.data / "parts").glob("*.csv")}
        self.assertEqual(after, before, "a sheet with problems must not change the parts")

    def test_wrong_unit_uses_sheet_words(self) -> None:
        self.edit(lambda b: b["Low Noise Amplifiers"].cell(row=2, column=7, value="0.6 GHz"))  # NF
        self.assert_problem("Low Noise Amplifiers tab, row 2: NF (dB): '0.6 GHz' has unit GHz, expected dB")

    def test_missing_part_number(self) -> None:
        def clear(book):
            book["Mixers"]["A3"].value = None  # cell(..., value=None) would do nothing
        self.edit(clear)
        self.assert_problem("Mixers tab, row 3: Part number is required")

    def test_unknown_tab(self) -> None:
        self.edit(lambda b: b.create_sheet("Amplifiers"))
        self.assert_problem('Tab "Amplifiers" doesn\'t match a product type')

    def test_missing_tab(self) -> None:
        self.edit(lambda b: b.remove(b["Mixers"]))
        self.assert_problem("No tab for Mixers")

    def test_unknown_column(self) -> None:
        self.edit(lambda b: b["Filters"].cell(row=1, column=20, value="Color"))
        self.assert_problem('Filters tab: column "Color" isn\'t a known column')

    def test_missing_required_column(self) -> None:
        self.edit(lambda b: b["Filters"].delete_cols(4))  # Datasheet link
        self.assert_problem('Filters tab: the "Datasheet link" column is missing')

    def test_value_turned_into_a_date(self) -> None:
        self.edit(lambda b: b["Mixers"].cell(row=2, column=1, value=datetime(2026, 3, 10)))
        self.assert_problem("Mixers tab, row 2: Part number: Google Sheets turned this into a date")

    def test_duplicate_part(self) -> None:
        self.edit(lambda b: b["Mixers"].cell(row=3, column=1, value="AMX-0750").parent.cell(
            row=3, column=2, value="Acme RF"))
        self.assert_problem("duplicate part Acme RF AMX-0750")

    def test_fixing_the_problem_clears_it(self) -> None:
        self.edit(lambda b: b["Low Noise Amplifiers"].cell(row=2, column=7, value="0.6 GHz"))
        self.run_import()
        self.assertFalse(self.status_json()["ok"])
        self.edit(lambda b: b["Low Noise Amplifiers"].cell(row=2, column=7, value=0.6))
        self.run_import()
        self.assertTrue(self.status_json()["ok"])
        self.assertEqual(self.status_json()["problems"], [])


class Downloading(ImportTestCase):
    def serve(self, status: int, body: bytes) -> str:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                self.send_response(status)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: object) -> None:
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/export"

    def test_downloads_the_sheet(self) -> None:
        url = self.serve(200, self.xlsx.read_bytes())
        code, out, err = self.run_import("--sheet", "x" * 30, "--export-url", url)
        self.assertEqual(code, 0, err)
        self.assertIn("Sheet unchanged", out)

    def test_a_sign_in_page_means_not_shared(self) -> None:
        url = self.serve(200, b"<html>Sign in to continue</html>")
        code, _, err = self.run_import("--sheet", "x" * 30, "--export-url", url)
        self.assertEqual(code, 1)
        self.assertIn("Anyone with the link can view", err)

    def test_sheet_link_or_id(self) -> None:
        sid = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
        self.assertEqual(import_sheet.sheet_id(f"https://docs.google.com/spreadsheets/d/{sid}/edit#gid=0"), sid)
        self.assertEqual(import_sheet.sheet_id(sid), sid)
        with self.assertRaises(import_sheet.SheetError):
            import_sheet.sheet_id("not a link")


if __name__ == "__main__":
    unittest.main()

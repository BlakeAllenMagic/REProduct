"""Tests for tools/find_datasheet_links.py, with saved Mouser-style answers (no network)."""

from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import find_datasheet_links as f  # noqa: E402

TODAY = date(2026, 11, 26)


def part(mpn: str, link: str = "") -> dict[str, str]:
    return {"id": f"marki-{mpn.lower().replace('-', '')}", "manufacturer": "Marki Microwave", "mpn": mpn, "sheet_link": link}


def answer(mpn: str, url: str = "https://www.mouser.com/datasheet/2/1/x.pdf", maker: str = "Marki Microwave") -> dict:
    return {"ManufacturerPartNumber": mpn, "Manufacturer": maker, "DataSheetUrl": url}


class FakeMouser:
    def __init__(self, catalogue: dict[str, dict]) -> None:
        self.catalogue = catalogue
        self.calls: list[list[str]] = []

    def __call__(self, mpns: list[str]) -> list[dict]:
        self.calls.append(mpns)
        return [self.catalogue[m] for m in mpns if m in self.catalogue]


def run(parts, known, search, **kw):
    options = dict(today=TODAY, batch_size=2, max_requests=100, limit=None, recheck_days=30, interval=0,
                   sleep=lambda s: None, log=lambda m: None)
    options.update(kw)
    return f.run(parts, known, search, **options)


class Matching(unittest.TestCase):
    def test_only_same_maker_and_exact_part_number(self) -> None:
        batch = [part("FB-2400"), part("MM1-0212LS"), part("ADM-1")]
        results = [
            answer("fb-2400"),                                  # capitals don't matter
            answer("MM1-0212LSM"),                              # a different part
            answer("ADM-1", maker="Other Corp"),                # a different maker
        ]
        found = f.match_results(batch, results)
        self.assertEqual(found["marki-fb2400"], "https://www.mouser.com/datasheet/2/1/x.pdf")
        self.assertIsNone(found["marki-mm10212ls"])
        self.assertIsNone(found["marki-adm1"])

    def test_links_must_end_up_https(self) -> None:
        self.assertEqual(f.clean_link("//www.mouser.com/a.pdf"), "https://www.mouser.com/a.pdf")
        self.assertEqual(f.clean_link("http://x.example/a.pdf"), "https://x.example/a.pdf")
        self.assertIsNone(f.clean_link(""))
        self.assertIsNone(f.clean_link("ftp://x.example/a.pdf"))


class Runs(unittest.TestCase):
    def test_looks_up_blank_links_in_batches_and_records_misses(self) -> None:
        parts = [part("A-1"), part("A-2"), part("A-3"), part("A-4", link="https://maker.example/a4.pdf")]
        mouser = FakeMouser({"A-1": answer("A-1"), "A-3": answer("A-3")})
        updated, changed = run(parts, {}, mouser)
        self.assertEqual(mouser.calls, [["A-1", "A-2"], ["A-3"]])  # A-4 has a sheet link
        self.assertTrue(changed)
        self.assertEqual(updated["marki-a1"]["checked"], "2026-11-26")
        self.assertIsNone(updated["marki-a2"]["url"])
        self.assertNotIn("marki-a4", updated)

    def test_recent_checks_are_skipped_and_old_ones_redone(self) -> None:
        parts = [part("A-1"), part("A-2")]
        known = {"marki-a1": {"url": None, "checked": "2026-11-20"},
                 "marki-a2": {"url": None, "checked": "2026-10-01"}}
        mouser = FakeMouser({"A-2": answer("A-2")})
        updated, changed = run(parts, known, mouser)
        self.assertEqual(mouser.calls, [["A-2"]])
        self.assertTrue(changed)
        self.assertEqual(updated["marki-a1"], known["marki-a1"])

    def test_request_cap_and_limit(self) -> None:
        parts = [part(f"A-{i}") for i in range(10)]
        mouser = FakeMouser({})
        run(parts, {}, mouser, max_requests=2)
        self.assertEqual(len(mouser.calls), 2)
        mouser = FakeMouser({})
        run(parts, {}, mouser, limit=3)
        self.assertEqual(sum(len(c) for c in mouser.calls), 3)

    def test_a_refusal_stops_the_run_but_keeps_progress(self) -> None:
        parts = [part("A-1"), part("A-2"), part("A-3")]
        calls = []

        def search(mpns):
            calls.append(mpns)
            if len(calls) == 2:
                raise f.StopRun("limit reached")
            return [answer(m) for m in mpns]

        updated, changed = run(parts, {}, search, batch_size=1)
        self.assertEqual(len(calls), 2)
        self.assertIn("marki-a1", updated)
        self.assertNotIn("marki-a2", updated)  # not recorded: tried again next run

    def test_unchanged_links_are_not_a_change(self) -> None:
        parts = [part("A-1")]
        known = {"marki-a1": {"url": "https://www.mouser.com/datasheet/2/1/x.pdf", "checked": "2026-10-01"}}
        updated, changed = run(parts, known, FakeMouser({"A-1": answer("A-1")}))
        self.assertFalse(changed)
        self.assertEqual(updated["marki-a1"]["checked"], "2026-11-26")

    def test_parts_that_got_a_sheet_link_are_forgotten(self) -> None:
        known = {"marki-a1": {"url": "https://www.mouser.com/a.pdf", "checked": "2026-11-25"}}
        updated, changed = run([part("A-1", link="https://maker.example/a1.pdf")], known, FakeMouser({}))
        self.assertEqual(updated, {})
        self.assertTrue(changed)


if __name__ == "__main__":
    unittest.main()

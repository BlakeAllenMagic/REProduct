"""Tests for tools/sync_datasheets.py.

Run from the repo root:
    python3 -m unittest discover tools/tests

Two local web servers stand in for the outside world:
  "manufacturer"  serves the sample PDFs and can misbehave on purpose
                  (HTML error page, 403, slow, changed file, 304)
  "site"          the live datasheet site the job copies previous versions from
Nothing here touches the real internet.
"""

from __future__ import annotations

import hashlib
import io
import json
import shutil
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import sync_datasheets  # noqa: E402

SAMPLES = ["ALM-1234", "NLA-0310", "AMX-0750", "AFB-2450", "KSF-1575"]
SAMPLE_IDS = {
    "ALM-1234": "acme-alm1234",
    "NLA-0310": "northwind-nla0310",
    "AMX-0750": "acme-amx0750",
    "AFB-2450": "acme-afb2450",
    "KSF-1575": "kestrel-ksf1575",
}


class FakeServer:
    """A tiny web server. routes[path] = (status, headers, body, delay_seconds)."""

    def __init__(self) -> None:
        self.routes: dict[str, tuple[int, dict[str, str], bytes, float]] = {}
        self.requests: list[tuple[str, dict[str, str], float]] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                outer.requests.append((self.path, dict(self.headers), time.monotonic()))
                status, headers, body, delay = outer.routes.get(self.path, (404, {}, b"not found", 0))
                if delay:
                    time.sleep(delay)
                etag = headers.get("ETag")
                if etag and self.headers.get("If-None-Match") == etag:
                    status, body = 304, b""
                try:
                    self.send_response(status)
                    for key, value in headers.items():
                        self.send_header(key, value)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # the client gave up (timeout test)

            def log_message(self, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class SyncTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.data = self.tmp / "data"
        shutil.copytree(REPO / "data", self.data)
        self.linecard = self.tmp / "linecard.json"
        shutil.copy(REPO / "public" / "linecard.json", self.linecard)
        self.out = self.tmp / "site"

        self.maker = FakeServer()
        self.site = FakeServer()
        self.addCleanup(self.maker.close)
        self.addCleanup(self.site.close)

        # Point every datasheet link at the fake manufacturer.
        for csv in (self.data / "parts").glob("*.csv"):
            text = csv.read_text(encoding="utf-8")
            text = text.replace("https://reproduct.pages.dev/sample-upstream/", f"{self.maker.url}/up/")
            for host in ("https://manufacturer.example/", "https://northwind.example/datasheets/",
                         "https://kestrel.example/pdf/"):
                text = text.replace(host, f"{self.maker.url}/gone/")
            csv.write_text(text, encoding="utf-8")

        self.pdfs = {m: (REPO / "public" / "sample-upstream" / f"{m}.pdf").read_bytes() for m in SAMPLES}
        for mpn, body in self.pdfs.items():
            self.serve(mpn, body)

        # Starting point: the records match what the fake manufacturer serves,
        # whatever sample revision the repo is at (--revise changes the repo's
        # sample PDFs on purpose, before the sync job has run).
        records = {
            SAMPLE_IDS[mpn]: {"sha256": hashlib.sha256(body).hexdigest(), "bytes": len(body), "updated": "2026-01-01"}
            for mpn, body in self.pdfs.items()
        }
        (self.data / "datasheets.json").write_text(json.dumps(records, indent=2), encoding="utf-8")

        # The links and records changed, so rebuild the starting line card to
        # match (as if the CSVs had always pointed here).
        import build_linecard  # noqa: E402
        with redirect_stdout(io.StringIO()):
            build_linecard.main(["--data", str(self.data), "--out", str(self.linecard),
                                 "--data-version", "2000-01-01T00:00:00Z"])

    def serve(self, mpn: str, body: bytes, status: int = 200, delay: float = 0, content_type: str = "application/pdf"):
        etag = f'"{hashlib.sha256(body).hexdigest()[:16]}"'
        self.maker.routes[f"/up/{mpn}.pdf"] = (status, {"Content-Type": content_type, "ETag": etag}, body, delay)

    def publish_site_from(self, folder: Path) -> None:
        """Make the fake live site serve what a previous run uploaded."""
        self.site.routes.clear()
        for pdf in (folder / "datasheets").glob("*.pdf"):
            self.site.routes[f"/datasheets/{pdf.name}"] = (200, {}, pdf.read_bytes(), 0)

    def run_sync(self, *extra: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = sync_datasheets.main([
                "--data", str(self.data), "--linecard", str(self.linecard),
                "--site-url", self.site.url, "--out", str(self.out),
                "--interval", "0", "--timeout", "2", "--retries", "0", *extra,
            ])
        return code, out.getvalue(), err.getvalue()

    def records(self) -> dict:
        return json.loads((self.data / "datasheets.json").read_text(encoding="utf-8"))

    def card(self) -> dict:
        return json.loads(self.linecard.read_text(encoding="utf-8"))

    def site_files(self) -> set[str]:
        return {p.name for p in (self.out / "datasheets").glob("*.pdf")}

    def first_run(self) -> None:
        code, out, err = self.run_sync()
        self.assertEqual(code, 0, err)
        self.publish_site_from(self.out)
        # Start the next run from an older data version, so a change is visible
        # even when both runs happen within the same second.
        card = self.card()
        card["dataVersion"] = "2000-01-01T00:00:00Z"
        self.linecard.write_text(json.dumps(card), encoding="utf-8")


class SyncTests(SyncTestCase):
    def test_first_run_builds_the_complete_site(self) -> None:
        before = self.card()
        code, out, err = self.run_sync()
        self.assertEqual(code, 0, err)
        expected = {f"{hashlib.sha256(b).hexdigest()}.pdf" for b in self.pdfs.values()}
        self.assertEqual(self.site_files(), expected)
        headers = (self.out / "_headers").read_text()
        self.assertIn("Access-Control-Allow-Origin: *", headers)
        self.assertIn("immutable", headers)
        self.assertTrue((self.out / "index.html").exists())
        # Same PDFs as already recorded: nothing the app sees changed.
        self.assertEqual(self.card()["dataVersion"], before["dataVersion"])
        self.assertIn("| Unchanged | 5 |", out)
        self.assertIn("| No datasheet (download failed, nothing to keep) | 6 |", out)
        # ETags are stored for next time.
        self.assertTrue(all("etag" in r for r in self.records().values()))

    def test_second_run_uses_not_modified_and_copies_from_the_site(self) -> None:
        self.first_run()
        self.maker.requests.clear()
        code, out, err = self.run_sync()
        self.assertEqual(code, 0, err)
        sample_requests = [r for r in self.maker.requests if r[0].startswith("/up/")]
        self.assertTrue(all("If-None-Match" in headers for _, headers, _ in sample_requests))
        self.assertEqual(len(self.site_files()), 5)
        self.assertIn("| Unchanged | 5 |", out)
        self.assertIn("Line card data changed: no", out)

    def test_a_changed_pdf_gets_a_new_hash_date_and_data_version(self) -> None:
        self.first_run()
        old = self.records()["acme-afb2450"]
        new_pdf = b"%PDF-1.4\n% revised sample\n" + self.pdfs["AFB-2450"][10:]
        self.serve("AFB-2450", new_pdf)
        before = self.card()

        code, out, err = self.run_sync()
        self.assertEqual(code, 0, err)
        new_sha = hashlib.sha256(new_pdf).hexdigest()
        record = self.records()["acme-afb2450"]
        self.assertEqual(record["sha256"], new_sha)
        self.assertNotEqual(record["updated"], old["updated"])
        self.assertIn(f"{new_sha}.pdf", self.site_files())
        self.assertNotIn(f"{old['sha256']}.pdf", self.site_files())  # the site holds current versions only
        card = self.card()
        self.assertNotEqual(card["dataVersion"], before["dataVersion"])
        part = next(p for p in card["parts"] if p["id"] == "acme-afb2450")
        self.assertEqual(part["datasheet"]["sha256"], new_sha)
        self.assertIn("| Changed | 1 |", out)

    def test_html_error_page_keeps_the_previous_version(self) -> None:
        self.first_run()
        self.serve("ALM-1234", b"<html>Please log in</html>", content_type="text/html")
        code, out, err = self.run_sync()
        self.assertEqual(code, 0, err)
        self.assertIn(f"{self.records()['acme-alm1234']['sha256']}.pdf", self.site_files())
        self.assertIn("not a PDF", out)
        self.assertIn("| Download failed, previous version kept | 1 |", out)

    def test_403_keeps_the_previous_version(self) -> None:
        self.first_run()
        self.serve("NLA-0310", b"forbidden", status=403)
        code, out, err = self.run_sync()
        self.assertEqual(code, 0, err)
        self.assertEqual(len(self.site_files()), 5)
        self.assertIn("HTTP 403", out)

    def test_slow_reply_times_out_and_keeps_the_previous_version(self) -> None:
        self.first_run()
        self.serve("AMX-0750", self.pdfs["AMX-0750"], delay=3)
        code, out, err = self.run_sync("--timeout", "0.5")
        self.assertEqual(code, 0, err)
        self.assertEqual(len(self.site_files()), 5)
        self.assertIn("| Download failed, previous version kept | 1 |", out)

    def test_stops_before_removing_a_hosted_datasheet(self) -> None:
        self.first_run()
        records_before = (self.data / "datasheets.json").read_text()
        card_before = self.linecard.read_text()
        out_before = self.site_files()
        self.serve("KSF-1575", b"gone", status=500)
        self.site.routes.clear()  # and the live site can't provide it either
        code, out, err = self.run_sync()
        self.assertEqual(code, 2)
        self.assertIn("STOPPED", err)
        self.assertEqual((self.data / "datasheets.json").read_text(), records_before)
        self.assertEqual(self.linecard.read_text(), card_before)
        self.assertEqual(self.site_files(), out_before)  # previous output left alone

    def test_too_big_is_left_out_and_reported(self) -> None:
        code, out, err = self.run_sync("--max-bytes", "5000")  # ALM-1234 is 6947 bytes
        self.assertEqual(code, 0, err)
        self.assertNotIn("acme-alm1234", self.records())
        self.assertEqual(len(self.site_files()), 4)
        self.assertIn("Too big", out)
        part = next(p for p in self.card()["parts"] if p["id"] == "acme-alm1234")
        self.assertIsNone(part["datasheet"]["sha256"])

    def test_requests_to_one_website_are_spaced_out(self) -> None:
        code, _, err = self.run_sync("--interval", "0.2")
        self.assertEqual(code, 0, err)
        times = sorted(t for path, _, t in self.maker.requests)
        gaps = [b - a for a, b in zip(times, times[1:])]
        self.assertTrue(all(gap >= 0.18 for gap in gaps), gaps)

    def test_sends_a_browser_user_agent(self) -> None:
        self.run_sync()
        _, headers, _ = self.maker.requests[0]
        self.assertIn("Mozilla/5.0", headers.get("User-Agent", ""))

    def test_refuses_to_empty_a_folder_it_did_not_create(self) -> None:
        self.out.mkdir()
        (self.out / "important.txt").write_text("keep me")
        self.maker.requests.clear()
        code, _, err = self.run_sync()
        self.assertEqual(code, 1)
        self.assertIn("refusing to empty it", err)
        self.assertTrue((self.out / "important.txt").exists())
        self.assertEqual(self.maker.requests, [])  # checked before downloading anything


if __name__ == "__main__":
    unittest.main()

"""Read every product table in a Marki Microwave catalog PDF, by word position.

How the catalog pages are laid out (September 2026 editions):
- page header, size 10 bold, e.g. "CONNECTORIZED | FALL 2026" (gives the package)
- table title, size 11+ bold, e.g. "FIXED FILTERS, Bandpass"
- column headings, size 9 bold, possibly over several lines
- data rows, size 9, starting with the part number

Each data value is matched to the heading whose column it sits under.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pdfplumber

# A part number: capital letters and digits with dashes or brackets, e.g.
# "FB-2400", "MM1-0212(L/H/S)S", "DCZ(M-F)29(M-F)29", "ADM1-0026PA".
PART = re.compile(r"^[A-Z][A-Z0-9]*(?:[-(][A-Z0-9()/.+\-]*|[0-9][A-Z0-9()/.+\-]*)$")
MARKS = "✦◆*"
LINE_PITCH = 3.5  # words whose tops are this close share a line (rows are ~14 pt apart)


@dataclass
class Table:
    title: str
    section: str | None
    page: int
    header: list[dict[str, Any]] = field(default_factory=list)
    rows: list[dict[str, Any]] = field(default_factory=list)


def _is_bold(word: dict[str, Any]) -> bool:
    return "Bold" in word["fontname"]


def _lines(page: Any) -> list[list[dict[str, Any]]]:
    """Words grouped into lines: a word joins the current line if its top is within LINE_PITCH of the line's first word."""
    words = sorted(page.extract_words(extra_attrs=["size", "fontname"], keep_blank_chars=False), key=lambda w: w["top"])
    lines: list[list[dict[str, Any]]] = []
    for word in words:
        if lines and word["top"] - lines[-1][0]["top"] <= LINE_PITCH:
            lines[-1].append(word)
        else:
            lines.append([word])
    return [sorted(line, key=lambda w: w["x0"]) for line in lines]


def _cells(words: list[dict[str, Any]], gap: float = 4.5) -> list[dict[str, Any]]:
    """Merge neighbouring words into cells ("see", "datasheet" -> "see datasheet")."""
    cells: list[dict[str, Any]] = []
    for word in words:
        if cells and word["x0"] - cells[-1]["x1"] < gap:
            cells[-1]["text"] += " " + word["text"]
            cells[-1]["x1"] = word["x1"]
        else:
            cells.append({"text": word["text"], "x0": word["x0"], "x1": word["x1"]})
    return cells


NOT_PARTS = {"EAR99"}
FOOTNOTES = re.compile(r"^[¹²³⁴⁵*✦◆]+$")


def _part_words(words: list[dict[str, Any]]) -> tuple[int, int] | None:
    """(start, end) of the words making up the part number, or None if the line isn't a part row.

    A part number can be split over several words where it has a bracket:
    "MM1-0212(" "L/" "H" "/" "S)S" -> "MM1-0212(L/H/S)S".
    """
    for i, word in enumerate(words[:2]):
        text = word["text"].strip(MARKS)
        if not text:
            continue
        if not PART.match(text) or text in NOT_PARTS:
            return None
        end = i + 1
        joined = text
        while joined.count("(") > joined.count(")") and end < len(words) and words[end]["x0"] - words[end - 1]["x1"] < 1.5:
            joined += words[end]["text"]
            end += 1
        # A suffix printed with a gap: "MFBP-00010P" "SM" -> "MFBP-00010PSM"; "NLTL-6275U" "/" "USW".
        while end < len(words) and re.match(r"^(?:[A-Z]{1,4}|/|/[A-Z]{1,4})$", words[end]["text"]) \
                and words[end]["x0"] - words[end - 1]["x1"] < 8 and words[end]["size"] >= 7:
            joined += words[end]["text"]
            end += 1
        return (i, end) if any(c.isdigit() for c in joined) else None
    return None


def _section(text: str) -> str:
    left, _, right = text.partition("|")
    side = right if re.match(r"^(FALL|SPRING|SUMMER|WINTER)\b", left.strip()) else left
    return side.strip()


def _link_at(links: list[tuple[float, str]], top: float) -> str | None:
    """The page link closest to this line (within a few points), if any."""
    near = [(abs(t - top), uri) for t, uri in links if abs(t - top) <= 4]
    return min(near)[1] if near else None


def read_tables(pdf_path: Path) -> list[Table]:
    tables: list[Table] = []
    section: str | None = None
    current: Table | None = None
    with pdfplumber.open(pdf_path) as pdf:
        for page_no, page in enumerate(pdf.pages, start=1):
            links = [(link["top"], link["uri"]) for link in page.hyperlinks or [] if link.get("uri")]
            for words in _lines(page):
                core = [w for w in words if w["text"] not in ("✦", "◆")]
                if not core:
                    continue
                first = core[0]  # the new-release mark is a bigger font; ignore it here
                text = " ".join(w["text"] for w in words)
                size = round(first["size"])
                if size == 10 and _is_bold(first) and "|" in text and first["top"] < 40:
                    section = _section(text)
                    continue
                if size >= 11 and _is_bold(first) and re.match(r"^[A-Z][A-Z ,&/\-]+", first["text"]):
                    current = Table(title=text, section=section, page=page_no)
                    tables.append(current)
                    continue
                if current is None or size > 10:
                    continue
                span = _part_words(words)
                if span is not None:
                    start, end = span
                    part_words = words[start:end]
                    link = _link_at(links, part_words[0]["top"])
                    rest = [w for w in words[end:] if not FOOTNOTES.match(w["text"]) and w["size"] >= 7]
                    current.rows.append({
                        "part": "".join(w["text"] for w in part_words).strip(MARKS),
                        "part_x1": part_words[-1]["x1"],
                        "new": any(m in w["text"] for w in words[:end] for m in "✦◆"),
                        "cells": _cells(rest),
                        "link": link,
                    })
                elif _is_bold(first) and size == 9 and not current.rows:
                    current.header.extend(words)
    return tables


def columns(table: Table, header: list[dict[str, Any]]) -> list[tuple[float, str]]:
    """(x centre, heading) for each value column of the table (the part number column excluded)."""
    centres = sorted((c["x0"] + c["x1"]) / 2 for row in table.rows for c in row["cells"])
    clusters: list[list[float]] = []
    for x in centres:
        if clusters and x - clusters[-1][-1] < 14:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    cols = [sum(c) / len(c) for c in clusters]
    labels: dict[int, list[str]] = defaultdict(list)
    for word in sorted(header, key=lambda w: (round(w["top"] / LINE_PITCH), w["x0"])):
        centre = (word["x0"] + word["x1"]) / 2
        # "Part Number" sits over the part number column; "a" is a stray footnote mark.
        if not cols or (word["text"] in {"Part", "Number"} and centre < cols[0] - 10):
            continue
        if word["text"] in {"a"}:
            continue
        i = min(range(len(cols)), key=lambda i: abs(cols[i] - centre))
        labels[i].append(word["text"])
    return [(x, " ".join(labels[i])) for i, x in enumerate(cols)]


def rows_as_dicts(table: Table, header: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cols = columns(table, header)
    out = []
    for row in table.rows:
        values: dict[str, str] = {}
        for cell in row["cells"]:
            centre = (cell["x0"] + cell["x1"]) / 2
            x, heading = min(cols, key=lambda col: abs(col[0] - centre))
            values[heading] = (values[heading] + " " + cell["text"]) if heading in values else cell["text"]
        out.append({**row, "values": values})
    return out

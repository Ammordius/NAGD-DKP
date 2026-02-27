#!/usr/bin/env python3
"""
Parse raid_*_attendees.html (by-Event pages) into data/raid_event_attendance.csv.

Each file has sections: <b>Event Name  - N Attendees</b> followed by a table of
character_dkp links. We match sections to raid_events by (raid_id, event_order)
and output (raid_id, event_id, char_id, character_name).
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import List, Tuple, Union

import pandas as pd
from bs4 import BeautifulSoup, Tag


def _attendees_from_table(table_or_html: Union[Tag, str]) -> List[Tuple[str, str]]:
    """
    Extract (char_id, character_name) from a section table.
    Accepts either a BeautifulSoup Tag (outer table element) or HTML string.
    Uses the outer table so nested tables (one per attendee) are all included.
    """
    attendees: List[Tuple[str, str]] = []
    if isinstance(table_or_html, Tag):
        root = table_or_html
    else:
        table_soup = BeautifulSoup(table_or_html, "lxml")
        root = table_soup.find("table") or table_soup.find("tbody") or table_soup
    if not root:
        return attendees
    link_re = re.compile(r"character_dkp\.php.*?char=(\d*)", re.IGNORECASE)
    for td in root.find_all("td"):
        # Prefer character_dkp link if present
        char_a = td.find("a", href=link_re)
        if char_a:
            href = char_a.get("href", "")
            m = re.search(r"char=(\d*)", href.replace("&amp;", "&"))
            cid = (m.group(1) if m else "").strip()
            name = (char_a.get_text() or "").strip()
            if name:
                attendees.append((cid, name))
            continue
        # No link: treat cell text as name (inactive raiders often shown as plain text)
        raw = (td.get_text() or "").strip()
        # Drop optional leading drop-cap letter (e.g. "<b>A</b> Barlu" -> "Barlu")
        name = re.sub(r"^[A-Za-z]\s+", "", raw).strip() or raw
        if name and len(name) > 1:
            attendees.append(("", name))
    return attendees


def parse_attendees_html(html: str, raid_id: str) -> List[Tuple[str, List[Tuple[str, str]]]]:
    """
    Parse one raid_details_attendees.php HTML.
    Returns list of (event_name, [(char_id, character_name), ...]) in document order.
    Collects from ALL tables inside each section div (GamerLaunch often nests one table per attendee).
    """
    soup = BeautifulSoup(html, "lxml")
    content = soup.find("div", id="contentItem")
    if not content:
        return []
    sections: List[Tuple[str, List[Tuple[str, str]]]] = []
    event_heading_re = re.compile(r"^\s*(.+?)\s*-\s*\d+\s*Attendees\s*$", re.IGNORECASE)
    for b in content.find_all("b"):
        text = (b.get_text() or "").strip()
        m = event_heading_re.match(text)
        if not m:
            continue
        event_name = m.group(1).strip()
        next_div = b.find_next("div", class_=re.compile(r"\bdata1\b"))
        if not next_div:
            continue
        # Collect from every table in this div (nested tables = one attendee per inner table).
        all_attendees: List[Tuple[str, str]] = []
        seen: set[Tuple[str, str]] = set()
        for table in next_div.find_all("table"):
            for cid, cname in _attendees_from_table(table):
                key = (cid or "", (cname or "").strip())
                if key in seen:
                    continue
                seen.add(key)
                all_attendees.append((cid, cname))
        if all_attendees:
            sections.append((event_name, all_attendees))
    return sections


def main() -> None:
    ap = argparse.ArgumentParser(description="Parse raid_*_attendees.html into raid_event_attendance.csv")
    ap.add_argument("--raids-dir", type=str, default="raids", help="Directory with raid_*_attendees.html")
    ap.add_argument("--data-dir", type=str, default="data", help="Output directory for raid_event_attendance.csv")
    ap.add_argument("--events-csv", type=str, default="data/raid_events.csv", help="raid_events.csv for event_id by order")
    args = ap.parse_args()

    raids_dir = Path(args.raids_dir)
    data_dir = Path(args.data_dir)
    events_path = Path(args.events_csv)
    if not raids_dir.is_dir():
        print(f"Missing directory: {raids_dir}", file=sys.stderr)
        sys.exit(2)
    if not events_path.exists():
        print(f"Missing {events_path}. Run extract_structured_data.py first.", file=sys.stderr)
        sys.exit(2)

    events_df = pd.read_csv(events_path)
    # Per raid: list of (event_id, event_order) sorted by event_order
    raid_events: dict[str, List[Tuple[str, int]]] = {}
    for _, r in events_df.iterrows():
        rid = str(r["raid_id"]).strip()
        eid = str(r["event_id"]).strip()
        order = int(r.get("event_order", 0)) if pd.notna(r.get("event_order")) else 0
        if rid not in raid_events:
            raid_events[rid] = []
        raid_events[rid].append((eid, order))
    for rid in raid_events:
        raid_events[rid].sort(key=lambda x: x[1])

    data_dir.mkdir(parents=True, exist_ok=True)

    # Build (raid_id, character_name) -> char_id from raid_attendance (by-Event HTML has char= empty)
    att_path = data_dir / "raid_attendance.csv"
    name_to_cid: dict[tuple[str, str], str] = {}
    if att_path.exists():
        att_df = pd.read_csv(att_path)
        for _, r in att_df.iterrows():
            rid = str(r.get("raid_id", "")).strip()
            cid = str(r.get("char_id", "")).strip()
            name = (r.get("character_name") or "").strip()
            if not rid or not cid or not name:
                continue
            name_norm = re.sub(r"^\(\*\)\s*", "", name).strip()
            name_to_cid[(rid, name)] = cid
            if name_norm != name:
                name_to_cid[(rid, name_norm)] = cid
            # Inactive raiders can be listed as "((*) Name" (no link on site)
            name_norm2 = re.sub(r"^\(\(\*\)\s*", "", name).strip()
            if name_norm2 != name:
                name_to_cid[(rid, name_norm2)] = cid

    out_rows = []
    def _raid_key(p: Path) -> int:
        mo = re.search(r"raid_(\d+)_attendees", p.name)
        return int(mo.group(1)) if mo else 0
    attendee_files = sorted(raids_dir.glob("raid_*_attendees.html"), key=_raid_key)
    for path in attendee_files:
        m = re.search(r"raid_(\d+)_attendees", path.name)
        if not m:
            continue
        raid_id = m.group(1)
        try:
            html = path.read_text(encoding="utf-8")
        except Exception as e:
            print(f"Skip {path.name}: {e}", file=sys.stderr)
            continue
        sections = parse_attendees_html(html, raid_id)
        raid_event_list = raid_events.get(raid_id, [])
        # Match by index: section i -> event_order i+1 (raid_events sorted by event_order)
        for i, (event_name, attendees) in enumerate(sections):
            if i >= len(raid_event_list):
                break
            event_id, _ = raid_event_list[i]
            for char_id, character_name in attendees:
                if not char_id and character_name and name_to_cid:
                    norm = re.sub(r"^\(\(\*\)\s*", "", character_name).strip()
                    char_id = (
                        name_to_cid.get((raid_id, character_name))
                        or name_to_cid.get((raid_id, character_name.strip()))
                        or name_to_cid.get((raid_id, norm))
                    )
                out_rows.append({
                    "raid_id": raid_id,
                    "event_id": event_id,
                    "char_id": (char_id or "").strip(),
                    "character_name": character_name,
                })

    out_path = data_dir / "raid_event_attendance.csv"
    pd.DataFrame(out_rows).to_csv(out_path, index=False)
    print(f"Wrote {out_path} ({len(out_rows)} rows from {len(attendee_files)} attendee files)")


if __name__ == "__main__":
    main()

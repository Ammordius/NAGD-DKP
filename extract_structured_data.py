#!/usr/bin/env python3
"""
Extract all scraped data into structured CSVs (and optional SQLite) for a DKP website.

Reads:
- roster_full.csv, roster_linked.csv, account_groups.csv
- raids_index.csv, raids/*.html

Writes to data/:
- characters.csv    (char_id, name, race, class, level, guild_rank, claim)
- accounts.csv      (account_id, toon_count, toon_names, char_ids)
- character_account.csv  (char_id, account_id)  -- which character belongs to which account
- raids.csv         (raid_id, raid_pool, raid_name, date, date_iso, attendees, url)
- raid_events.csv   (raid_id, event_id, event_order, event_name, dkp_value, attendee_count, event_time)
- raid_loot.csv     (raid_id, event_id, item_name, char_id, character_name, cost)
- raid_attendance.csv (raid_id, char_id, character_name)

Run after pull_roster_full, pull_linked_toons, and pull_raids.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from datetime import datetime
from typing import List, Optional

import pandas as pd
from bs4 import BeautifulSoup


def extract_char_id(url: str) -> Optional[str]:
    if not url or "char=" not in url:
        return None
    m = re.search(r"char=(\d+)", url.replace("&amp;", "&"))
    return m.group(1) if m else None


def parse_date_to_iso(date_str: str) -> str:
    """Parse 'Wed Sep 30, 2020 12:50 am' -> '2020-09-30' or empty."""
    if not date_str or not date_str.strip():
        return ""
    try:
        # Try common format
        for fmt in (
            "%a %b %d, %Y %I:%M %p",
            "%a %b %d, %Y",
            "%Y-%m-%d",
        ):
            try:
                dt = datetime.strptime(date_str.strip()[:24], fmt)
                return dt.strftime("%Y-%m-%d")
            except ValueError:
                continue
    except Exception:
        pass
    return ""


def build_characters(roster_path: Path, out_path: Path) -> pd.DataFrame:
    df = pd.read_csv(roster_path)
    df["char_id"] = df["character_url"].astype(str).map(extract_char_id)
    out = df[["char_id", "name", "race", "class", "level", "guild_rank", "claim"]].copy()
    out = out.rename(columns={"class": "class_name"})  # 'class' is reserved in Python/SQL
    out.to_csv(out_path, index=False)
    return out


def build_accounts(account_groups_path: Path, out_path: Path) -> pd.DataFrame:
    df = pd.read_csv(account_groups_path)
    df.to_csv(out_path, index=False)
    return df


def build_character_account(roster_linked_path: Path, account_groups_path: Path, out_path: Path) -> pd.DataFrame:
    """Map char_id -> account_id from roster_linked (linked_char_ids share same account)."""
    linked = pd.read_csv(roster_linked_path)
    accounts = pd.read_csv(account_groups_path)
    # From account_groups: account_id, char_ids (comma-sep). Explode to one row per (account_id, char_id).
    rows = []
    for _, row in accounts.iterrows():
        aid = row["account_id"]
        for cid in (row.get("char_ids") or "").split(","):
            cid = cid.strip()
            if cid:
                rows.append({"char_id": cid, "account_id": aid})
    out = pd.DataFrame(rows)
    out.to_csv(out_path, index=False)
    return out


def build_raids(raids_index_path: Path, out_path: Path) -> pd.DataFrame:
    df = pd.read_csv(raids_index_path)
    df["date_iso"] = df["date"].astype(str).map(parse_date_to_iso)
    cols = ["raid_id", "raid_pool", "raid_name", "date", "date_iso", "attendees", "url"]
    out = df[[c for c in cols if c in df.columns]]
    out.to_csv(out_path, index=False)
    return out


def parse_raid_html(html: str, raid_id: str) -> dict:
    """Extract events, loot, and attendees from one raid detail HTML."""
    soup = BeautifulSoup(html, "lxml")
    events: List[dict] = []
    loot: List[dict] = []
    attendees: List[dict] = []

    # Events: div id='event_container_2499232'
    for div in soup.find_all("div", id=re.compile(r"^event_container_\d+$")):
        eid = div.get("id", "").replace("event_container_", "")
        if not eid.isdigit():
            continue
        header_table = div.find("table")
        event_name = ""
        dkp_value = ""
        attendee_count = ""
        event_time = ""
        if header_table:
            b = header_table.find("b")
            if b:
                event_name = b.get_text(strip=True)
            tds = header_table.find_all("td")
            for i, td in enumerate(tds):
                text = td.get_text(strip=True)
                if "Event DKP" in str(td) or (i == 2 and text.replace(".", "").isdigit()):
                    # DKP value often in next td or in same cell
                    nums = re.findall(r"[\d.]+", text)
                    if nums:
                        dkp_value = nums[0]
                if "Event Attendees" in str(td) or (i == 3 and text.isdigit()):
                    attendee_count = text
                span = td.find("span", title=re.compile(r"Site Time"))
                if span:
                    event_time = span.get_text(strip=True)
        event_order = len(events) + 1
        events.append({
            "raid_id": raid_id,
            "event_id": eid,
            "event_order": event_order,
            "event_name": event_name,
            "dkp_value": dkp_value,
            "attendee_count": attendee_count,
            "event_time": event_time,
        })

        # Loot: table.raid_event_items_table inside this event div
        items_table = div.find("table", class_=re.compile(r"raid_event_items_table"))
        if items_table:
            for tr in items_table.find_all("tr"):
                tds = tr.find_all("td")
                if len(tds) < 2:
                    continue
                # Skip "Total:" row
                first_text = tds[0].get_text(strip=True)
                if first_text == "Total:" or first_text.startswith("Total"):
                    continue
                item_name = ""
                char_id = ""
                character_name = ""
                cost = ""
                # Column 0: item name. Cell often has <a><img></a> <a>Item Name</a>; first link is empty, so use full cell text.
                item_name = tds[0].get_text(strip=True)
                if not item_name:
                    item_a = tds[0].find("a", href=re.compile(r"item_report|generate_item_report"))
                    if item_a:
                        item_name = item_a.get_text(strip=True)
                    # Else try any item-report link with text (second link in cell)
                    for a in tds[0].find_all("a", href=re.compile(r"item_report|generate_item_report")):
                        t = a.get_text(strip=True)
                        if t:
                            item_name = t
                            break
                char_a = tds[1].find("a", href=re.compile(r"character_dkp\.php.*char="))
                if char_a:
                    character_name = char_a.get_text(strip=True)
                    href = char_a.get("href", "")
                    m = re.search(r"char=(\d+)", href.replace("&amp;", "&"))
                    if m:
                        char_id = m.group(1)
                if len(tds) >= 3:
                    cost = tds[2].get_text(strip=True)
                if item_name or character_name:
                    loot.append({
                        "raid_id": raid_id,
                        "event_id": eid,
                        "item_name": item_name,
                        "char_id": char_id or "",
                        "character_name": character_name,
                        "cost": cost,
                    })

    # Raid-level attendees: <a name='attendees'> then table with links to character_dkp.php?char=
    attendees_anchor = soup.find("a", attrs={"name": "attendees"})
    if attendees_anchor:
        container = attendees_anchor.find_parent("div", class_="contentItem")
        if container:
            table = container.find("table")
            if table:
                for a in table.find_all("a", href=re.compile(r"character_dkp\.php.*char=")):
                    name = a.get_text(strip=True)
                    if not name:
                        continue
                    href = a.get("href", "")
                    m = re.search(r"char=(\d+)", href.replace("&amp;", "&"))
                    cid = m.group(1) if m else ""
                    attendees.append({"raid_id": raid_id, "char_id": cid, "character_name": name})

    return {"events": events, "loot": loot, "attendees": attendees}


def build_raid_parsed(raids_dir: Path, out_events: Path, out_loot: Path, out_attendance: Path, limit: int = 0) -> None:
    all_events: List[dict] = []
    all_loot: List[dict] = []
    all_attendees: List[dict] = []
    html_files = sorted(raids_dir.glob("raid_*.html"), key=lambda p: int(p.stem.replace("raid_", "") or "0"))
    if limit:
        html_files = html_files[:limit]
    for i, path in enumerate(html_files):
        raid_id = path.stem.replace("raid_", "")
        try:
            html = path.read_text(encoding="utf-8")
        except Exception as e:
            print(f"  Skip {path.name}: {e}", file=sys.stderr)
            continue
        parsed = parse_raid_html(html, raid_id)
        all_events.extend(parsed["events"])
        all_loot.extend(parsed["loot"])
        all_attendees.extend(parsed["attendees"])
        if (i + 1) % 200 == 0:
            print(f"  Parsed {i + 1}/{len(html_files)} raid HTML files")
    pd.DataFrame(all_events).to_csv(out_events, index=False)
    pd.DataFrame(all_loot).to_csv(out_loot, index=False)
    pd.DataFrame(all_attendees).to_csv(out_attendance, index=False)
    print(f"  raid_events: {len(all_events)} rows")
    print(f"  raid_loot: {len(all_loot)} rows")
    print(f"  raid_attendance: {len(all_attendees)} rows")


def build_sqlite(data_dir: Path, db_path: Path) -> None:
    """Create SQLite DB from CSVs for the web app."""
    import sqlite3
    conn = sqlite3.connect(db_path)
    for name in ("characters", "accounts", "character_account", "raids", "raid_events", "raid_loot", "raid_attendance"):
        csv_path = data_dir / f"{name}.csv"
        if not csv_path.exists():
            continue
        df = pd.read_csv(csv_path)
        df.to_sql(name, conn, index=False, if_exists="replace")
    conn.commit()
    conn.close()
    print(f"  SQLite: {db_path}")


def main():
    ap = argparse.ArgumentParser(description="Extract scraped data into structured CSVs and optional SQLite")
    ap.add_argument("--data-dir", type=str, default="data", help="Output directory for CSVs")
    ap.add_argument("--roster", type=str, default="roster_full.csv")
    ap.add_argument("--roster-linked", type=str, default="roster_linked.csv")
    ap.add_argument("--account-groups", type=str, default="account_groups.csv")
    ap.add_argument("--raids-index", type=str, default="raids_index.csv")
    ap.add_argument("--raids-dir", type=str, default="raids")
    ap.add_argument("--limit-raids", type=int, default=0, help="Parse only first N raid HTML files (0 = all)")
    ap.add_argument("--sqlite", type=str, default="data/dkp.db", help="Create SQLite DB (empty = skip)")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)

    base = Path(".")
    roster_path = base / args.roster
    roster_linked_path = base / args.roster_linked
    account_groups_path = base / args.account_groups
    raids_index_path = base / args.raids_index
    raids_dir = base / args.raids_dir

    if not roster_path.exists():
        print(f"Missing {roster_path}. Run pull_roster_full.py first.", file=sys.stderr)
        sys.exit(2)
    if not account_groups_path.exists():
        print(f"Missing {account_groups_path}. Run pull_linked_toons.py first.", file=sys.stderr)
        sys.exit(2)
    if not raids_index_path.exists():
        print(f"Missing {raids_index_path}. Run pull_raids.py first.", file=sys.stderr)
        sys.exit(2)

    print("Building characters.csv ...")
    build_characters(roster_path, data_dir / "characters.csv")

    print("Building accounts.csv ...")
    build_accounts(account_groups_path, data_dir / "accounts.csv")

    if roster_linked_path.exists():
        print("Building character_account.csv ...")
        build_character_account(roster_linked_path, account_groups_path, data_dir / "character_account.csv")

    print("Building raids.csv ...")
    build_raids(raids_index_path, data_dir / "raids.csv")

    if raids_dir.exists():
        print("Parsing raid HTML (events, loot, attendance) ...")
        build_raid_parsed(
            raids_dir,
            data_dir / "raid_events.csv",
            data_dir / "raid_loot.csv",
            data_dir / "raid_attendance.csv",
            limit=args.limit_raids,
        )
    else:
        print("No raids/ directory, skipping raid_events/raid_loot/raid_attendance.")

    if args.sqlite:
        print("Building SQLite DB ...")
        build_sqlite(data_dir, Path(args.sqlite))

    print("Done. Structured data in", data_dir)


if __name__ == "__main__":
    main()

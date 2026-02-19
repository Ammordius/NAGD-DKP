#!/usr/bin/env python3
"""
Scrape event_time (tic time) from raid detail pages and generate a backfill for Supabase.

Reads data/raids.csv for raid_id and url. For each raid, fetches the detail page (using
cookies.txt like pull_raids.py), parses event_time from each event (Site Time in HTML),
and writes:

- data/raid_events_event_time_backfill.csv  (raid_id, event_id, event_time)
- docs/supabase-backfill-event-times.sql   (UPDATE statements for raid_events.event_time)

Requires: cookies.txt with a valid Cookie header for azureguardtakp.gamerlaunch.com.
Run with --dry-run to only parse sample_raid_details.html and print counts.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
import time
import random
from pathlib import Path

import requests

# Reuse the parser that extracts event_time from Site Time (title or onmouseover)
from extract_structured_data import parse_raid_html


BASE = "https://azureguardtakp.gamerlaunch.com"


def parse_cookie_header(cookie_header: str) -> dict[str, str]:
    s = cookie_header.strip()
    if s.lower().startswith("cookie:"):
        s = s[7:].strip()
    cookies: dict[str, str] = {}
    for part in s.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        cookies[k.strip()] = v.strip()
    return cookies


def polite_sleep(base: float, jitter: float) -> None:
    if base <= 0:
        return
    time.sleep(base + (random.uniform(0, jitter) if jitter > 0 else 0))


def main() -> None:
    ap = argparse.ArgumentParser(description="Scrape event_time from raid pages and generate backfill")
    ap.add_argument("--raids-csv", type=str, default="data/raids.csv", help="raids.csv with raid_id, url")
    ap.add_argument("--cookies-file", type=str, default="cookies.txt", help="Cookie header file")
    ap.add_argument("--sleep", type=float, default=2.0, help="Base sleep between requests (seconds)")
    ap.add_argument("--jitter", type=float, default=1.0, help="Jitter (seconds)")
    ap.add_argument("--limit", type=int, default=0, help="Max raids to fetch (0 = all)")
    ap.add_argument("--timeout", type=int, default=30, help="Request timeout")
    ap.add_argument("--dry-run", action="store_true", help="Only parse sample_raid_details.html and exit")
    ap.add_argument("--dry-run-local", action="store_true", help="Parse raids/*.html (or sample if no dir); count tics with times, no fetch/write")
    ap.add_argument("--dry-run-limit", type=int, default=0, help="With --dry-run-local, max raid HTML files to parse (0 = all)")
    ap.add_argument("--from-local", action="store_true", help="Parse raids/*.html only; write backfill CSV and SQL (no network fetch)")
    ap.add_argument("--out-csv", type=str, default="data/raid_events_event_time_backfill.csv")
    ap.add_argument("--out-sql", type=str, default="docs/supabase-backfill-event-times.sql")
    args = ap.parse_args()

    if args.dry_run:
        sample = Path("sample_raid_details.html")
        if not sample.exists():
            print(f"Dry run: {sample} not found.", file=sys.stderr)
            sys.exit(2)
        html = sample.read_text(encoding="utf-8")
        parsed = parse_raid_html(html, "1598641")
        with_times = [e for e in parsed["events"] if e.get("event_time")]
        print(f"Dry run: parsed {len(parsed['events'])} events, {len(with_times)} with event_time")
        for e in with_times:
            print(f"  event_id={e['event_id']} event_time={e['event_time']}")
        return

    if args.dry_run_local:
        raids_dir = Path("raids")
        if raids_dir.exists():
            # Only raid_<digits>.html (exclude e.g. raid_123_attendees.html)
            html_files = [p for p in raids_dir.glob("raid_*.html") if re.match(r"^raid_(\d+)\.html$", p.name)]
            html_files.sort(key=lambda p: int(re.match(r"raid_(\d+)", p.name).group(1)))
        else:
            html_files = []
        if not html_files:
            sample = Path("sample_raid_details.html")
            if sample.exists():
                html_files = [sample]
                print("No raids/ dir; using sample_raid_details.html only.")
            else:
                print("No raids/*.html and no sample_raid_details.html. Run pull_raids first or use --dry-run.", file=sys.stderr)
                sys.exit(2)
        if getattr(args, "dry_run_limit", 0):
            html_files = html_files[: args.dry_run_limit]
            print(f"Limiting to first {len(html_files)} raid HTML files.")
        total_tics = 0
        tics_with_time = 0
        for path in html_files:
            raid_id = path.stem.replace("raid_", "") if "raid_" in path.name else "sample"
            try:
                html = path.read_text(encoding="utf-8")
            except Exception as e:
                print(f"  Skip {path}: {e}", file=sys.stderr)
                continue
            parsed = parse_raid_html(html, raid_id)
            for e in parsed["events"]:
                total_tics += 1
                if (e.get("event_time") or "").strip():
                    tics_with_time += 1
        print(f"Dry run (local): {len(html_files)} raid page(s), {total_tics} tics total, {tics_with_time} with event_time ({100*tics_with_time/total_tics:.1f}%)" if total_tics else "No events found.")
        return

    if args.from_local:
        raids_dir = Path("raids")
        if raids_dir.exists():
            html_files = [p for p in raids_dir.glob("raid_*.html") if re.match(r"^raid_(\d+)\.html$", p.name)]
            html_files.sort(key=lambda p: int(re.match(r"raid_(\d+)", p.name).group(1)))
        else:
            html_files = []
        if not html_files:
            sample = Path("sample_raid_details.html")
            if sample.exists():
                html_files = [sample]
                print("No raids/ dir; using sample_raid_details.html only.")
            else:
                print("No raids/*.html and no sample_raid_details.html.", file=sys.stderr)
                sys.exit(2)
        backfill_rows = []
        for path in html_files:
            raid_id = path.stem.replace("raid_", "") if "raid_" in path.name else "sample"
            try:
                html = path.read_text(encoding="utf-8")
            except Exception as e:
                print(f"  Skip {path}: {e}", file=sys.stderr)
                continue
            parsed = parse_raid_html(html, raid_id)
            for e in parsed["events"]:
                et = (e.get("event_time") or "").strip()
                if et:
                    backfill_rows.append({"raid_id": raid_id, "event_id": e["event_id"], "event_time": et})
        print(f"From local HTML: {len(html_files)} raid page(s), {len(backfill_rows)} event_time rows")
        out_csv = Path(args.out_csv)
        out_csv.parent.mkdir(parents=True, exist_ok=True)
        with open(out_csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["raid_id", "event_id", "event_time"])
            w.writeheader()
            w.writerows(backfill_rows)
        print(f"Wrote {out_csv}")
        out_sql = Path(args.out_sql)
        out_sql.parent.mkdir(parents=True, exist_ok=True)
        with open(out_sql, "w", encoding="utf-8") as f:
            f.write("-- Backfill raid_events.event_time from local raids/*.html. Run in Supabase SQL Editor.\n")
            f.write("-- Generated by backfill_event_times.py --from-local\n\n")
            for row in backfill_rows:
                et = row["event_time"].replace("'", "''")
                f.write(f"UPDATE raid_events SET event_time = '{et}' WHERE raid_id = '{row['raid_id']}' AND event_id = '{row['event_id']}';\n")
        print(f"Wrote {out_sql} ({len(backfill_rows)} UPDATE statements)")
        return

    raids_path = Path(args.raids_csv)
    if not raids_path.exists():
        print(f"Missing {raids_path}. Run extract_structured_data after pull_raids, or ensure data/raids.csv exists.", file=sys.stderr)
        sys.exit(2)

    cookie_path = Path(args.cookies_file)
    if not cookie_path.exists():
        print(f"Missing {cookie_path}. Copy Cookie header from Chrome (see pull_raids.py).", file=sys.stderr)
        sys.exit(2)

    cookies = parse_cookie_header(cookie_path.read_text(encoding="utf-8").strip())
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": BASE + "/",
        "Accept-Language": "en-US,en;q=0.9",
    }
    session = requests.Session()
    session.headers.update(headers)
    for k, v in cookies.items():
        session.cookies.set(k, v, domain="azureguardtakp.gamerlaunch.com", path="/")

    # Load raid list (raid_id, url)
    raids: list[dict] = []
    with open(raids_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            raid_id = (row.get("raid_id") or "").strip()
            url = (row.get("url") or "").strip()
            if raid_id and url:
                raids.append({"raid_id": raid_id, "url": url})
    if args.limit:
        raids = raids[: args.limit]
        print(f"Limited to first {args.limit} raids")
    print(f"Fetching event_time for {len(raids)} raids ...")

    backfill_rows: list[dict] = []
    failed = 0
    for i, raid in enumerate(raids):
        raid_id = raid["raid_id"]
        url = raid["url"]
        try:
            r = session.get(url, timeout=args.timeout)
            r.raise_for_status()
        except Exception as e:
            print(f"  [{i+1}/{len(raids)}] raid_id={raid_id}: fetch failed: {e}", file=sys.stderr)
            failed += 1
            continue
        parsed = parse_raid_html(r.text, raid_id)
        for e in parsed["events"]:
            et = (e.get("event_time") or "").strip()
            if et:
                backfill_rows.append({"raid_id": raid_id, "event_id": e["event_id"], "event_time": et})
        if (i + 1) % 100 == 0:
            print(f"  {i+1}/{len(raids)} raids, {len(backfill_rows)} event_time rows so far")
        polite_sleep(args.sleep, args.jitter)

    print(f"Done. {len(backfill_rows)} event_time values from {len(raids) - failed} raids ({failed} fetch failures)")

    out_csv = Path(args.out_csv)
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["raid_id", "event_id", "event_time"])
        w.writeheader()
        w.writerows(backfill_rows)
    print(f"Wrote {out_csv}")

    # SQL: escape single quotes in event_time and generate UPDATEs
    out_sql = Path(args.out_sql)
    out_sql.parent.mkdir(parents=True, exist_ok=True)
    with open(out_sql, "w", encoding="utf-8") as f:
        f.write("-- Backfill raid_events.event_time from scraped Site Time. Run in Supabase SQL Editor.\n")
        f.write("-- Generated by backfill_event_times.py\n\n")
        for row in backfill_rows:
            et = row["event_time"].replace("'", "''")
            f.write(
                f"UPDATE raid_events SET event_time = '{et}' WHERE raid_id = '{row['raid_id']}' AND event_id = '{row['event_id']}';\n"
            )
    print(f"Wrote {out_sql} ({len(backfill_rows)} UPDATE statements)")


if __name__ == "__main__":
    main()

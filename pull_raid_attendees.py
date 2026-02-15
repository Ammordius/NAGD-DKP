#!/usr/bin/env python3
"""
Fetch the "by Event" attendee page for each raid and save as raid_{raidId}_attendees.html.

URL: https://azureguardtakp.gamerlaunch.com/rapid_raid/raid_details_attendees.php?raidId=...&gid=547766&raid_pool=...

Reads raids_index.csv for (raid_id, raid_pool). Uses cookies.txt (same as pull_raids.py).
Saves to raids/raid_{raidId}_attendees.html. Skips if file already exists.
Run after pull_raids.py so you have the index and raids/ directory.
"""

from __future__ import annotations

import argparse
import sys
import time
import random
from pathlib import Path
from typing import Dict

import pandas as pd
import requests


BASE = "https://azureguardtakp.gamerlaunch.com"
ATTENDEES_URL = BASE + "/rapid_raid/raid_details_attendees.php"


def parse_cookie_header(cookie_header: str) -> Dict[str, str]:
    """Parse a Chrome 'Cookie:' header into a dict. Strips leading 'Cookie:' if present."""
    s = cookie_header.strip()
    if s.lower().startswith("cookie:"):
        s = s[7:].strip()
    cookies: Dict[str, str] = {}
    for part in s.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        cookies[k.strip()] = v.strip()
    return cookies


def polite_sleep(base_sleep: float, jitter: float) -> None:
    if base_sleep <= 0:
        return
    extra = random.uniform(0, jitter) if jitter > 0 else 0.0
    time.sleep(base_sleep + extra)


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Fetch raid_details_attendees.php (by Event) for each raid in raids_index.csv"
    )
    ap.add_argument("--gid", type=int, default=547766, help="Guild ID")
    ap.add_argument("--cookies-file", type=str, default="cookies.txt", help="Cookie header file")
    ap.add_argument("--index", type=str, default="raids_index.csv", help="CSV with raid_id, raid_pool")
    ap.add_argument("--out-dir", type=str, default="raids", help="Directory to save HTML (raid_{id}_attendees.html)")
    ap.add_argument("--sleep", type=float, default=2.5, help="Base sleep between requests (seconds)")
    ap.add_argument("--jitter", type=float, default=1.0, help="Jitter (seconds)")
    ap.add_argument("--limit", type=int, default=0, help="Max number of attendee pages to fetch (0 = all)")
    ap.add_argument("--timeout", type=int, default=30, help="Request timeout")
    args = ap.parse_args()

    index_path = Path(args.index)
    if not index_path.exists():
        print(f"Missing {index_path}. Run pull_raids.py first.", file=sys.stderr)
        sys.exit(2)

    cookie_path = Path(args.cookies_file)
    if not cookie_path.exists():
        print(f"Missing {cookie_path}. Put your Cookie header on one line.", file=sys.stderr)
        sys.exit(2)
    cookies = parse_cookie_header(cookie_path.read_text(encoding="utf-8").strip())

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": BASE + "/",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
    }
    session = requests.Session()
    session.headers.update(headers)
    cookie_domain = "azureguardtakp.gamerlaunch.com"
    for k, v in cookies.items():
        session.cookies.set(k, v, domain=cookie_domain, path="/")

    gid = str(args.gid)
    df = pd.read_csv(index_path)
    # Ensure we have raid_id and raid_pool
    if "raid_pool" not in df.columns:
        print("raids_index.csv must have raid_pool column.", file=sys.stderr)
        sys.exit(2)
    raids = list(zip(df["raid_id"].astype(str), df["raid_pool"].astype(str)))
    if args.limit:
        raids = raids[: args.limit]

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    fetched = 0
    skipped = 0
    failed = 0
    for i, (raid_id, raid_pool) in enumerate(raids):
        out_file = out_dir / f"raid_{raid_id}_attendees.html"
        if out_file.exists():
            skipped += 1
            if (i + 1) % 100 == 0 or i == 0:
                print(f"  [{i+1}/{len(raids)}] raid {raid_id}: skip (already saved)")
            continue
        url = f"{ATTENDEES_URL}?raidId={raid_id}&gid={gid}&raid_pool={raid_pool}"
        try:
            r = session.get(url, timeout=args.timeout)
            r.raise_for_status()
        except requests.HTTPError as e:
            print(f"  [{i+1}/{len(raids)}] raid {raid_id}: {e}", file=sys.stderr)
            if e.response is not None and e.response.status_code == 403:
                print("403 Forbidden: Update cookies.txt from Chrome DevTools (same as pull_raids).", file=sys.stderr)
            failed += 1
            continue
        except Exception as e:
            print(f"  [{i+1}/{len(raids)}] raid {raid_id}: {e}", file=sys.stderr)
            failed += 1
            continue
        out_file.write_text(r.text, encoding="utf-8")
        fetched += 1
        print(f"  [{i+1}/{len(raids)}] raid {raid_id} -> {out_file.name}")
        polite_sleep(args.sleep, args.jitter)

    print(f"Done: {fetched} fetched, {skipped} skipped (existing), {failed} failed.")
    print(f"Attendee HTML files in {out_dir}/")


if __name__ == "__main__":
    main()

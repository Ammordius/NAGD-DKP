#!/usr/bin/env python3
"""
Pull past raids list from GamerLaunch Rapid Raid, then fetch each raid's details page.

1) Fetches https://azureguardtakp.gamerlaunch.com/rapid_raid/raids.php?mode=past&gid=547766&ts=3:1
2) Discovers raid_pool and pagination (1611 raids, 20 per page)
3) Iterates list pages to collect (raid_pool, raidId, raid_name, date) — or use --raid-ids to skip full scrape
4) Optionally filter by --since-date (YYYY-MM-DD); only raids on or after this date are fetched (data accurate as of 2026-02-24)
5) Fetches each raid_details.php page and saves HTML to raids/raid_{raidId}.html
6) Writes raids_index.csv with one row per raid (raid_id, raid_name, date, attendees, url)

Uses cookies.txt (same as roster/linked-toons scripts). Polite rate limit.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
import random
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlencode, urlparse

import requests
import pandas as pd
from bs4 import BeautifulSoup


BASE = "https://azureguardtakp.gamerlaunch.com"
PAST_RAIDS_URL = BASE + "/rapid_raid/raids.php"
RAID_DETAILS_URL = BASE + "/rapid_raid/raid_details.php"


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


def parse_date_to_iso(date_str: str) -> str:
    """Parse 'Fri Feb 13, 2026 2:00 am' or similar -> '2026-02-13'. Returns '' if unparseable."""
    if not date_str or not str(date_str).strip():
        return ""
    s = str(date_str).strip()
    for fmt, max_len in (
        ("%a %b %d, %Y %I:%M %p", 30),
        ("%a %b %d, %Y", 17),
        ("%Y-%m-%d", 10),
    ):
        try:
            part = s[:max_len] if len(s) > max_len else s
            dt = datetime.strptime(part, fmt)
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            continue
    return ""


def extract_raid_pool_from_html(html: str) -> Optional[str]:
    """Get raid_pool from any raid_details link on the page."""
    m = re.search(r"raid_pool=(\d+)", html)
    return m.group(1) if m else None


def discover_last_paging_page(html: str) -> int:
    """Max paging_page number from pagination links."""
    soup = BeautifulSoup(html, "lxml")
    max_page = 0
    for a in soup.find_all("a", href=True):
        href = a.get("href", "")
        if "paging_page=" in href:
            try:
                part = href.split("paging_page=")[1].split("&")[0].split("'")[0]
                max_page = max(max_page, int(part))
            except (ValueError, IndexError):
                pass
    return max_page


def parse_raids_from_list_page(html: str, raid_pool: str, gid: str) -> List[dict]:
    """Parse the data-table of past raids: Raid Name, Date, DKP, Signups."""
    soup = BeautifulSoup(html, "lxml")
    table = soup.find("table", class_=re.compile(r"data-table|forumline"))
    if not table:
        return []

    rows: List[dict] = []
    header_text = [th.get_text(strip=True) for th in table.find_all("th")]
    trs = table.find_all("tr")[1:]  # skip header
    for tr in trs:
        tds = tr.find_all("td")
        if len(tds) < 2:
            continue
        # Raid Name column: <a href="/rapid_raid/raid_details.php?raid_pool=562569&raidId=1598641&gid=547766"><b>Name</b></a>
        name_cell = tds[0]
        a = name_cell.find("a", href=re.compile(r"raid_details\.php.*raidId="))
        if not a:
            continue
        href = a.get("href", "")
        raid_name = a.get_text(strip=True)
        raid_id = None
        for part in href.replace("&amp;", "&").split("&"):
            if part.startswith("raidId="):
                raid_id = part.split("=", 1)[1].strip()
                break
        if not raid_id:
            continue

        # Date column: <span title="...">Fri Feb 13, 2026 2:00 am</span>
        date_str = ""
        if len(tds) >= 2:
            span = tds[1].find("span")
            if span:
                date_str = span.get_text(strip=True)

        rows.append({
            "raid_id": raid_id,
            "raid_pool": raid_pool,
            "raid_name": raid_name,
            "date": date_str,
            "gid": gid,
        })
    return rows


def build_list_page_url(raid_pool: str, gid: str, paging_page: Optional[int]) -> str:
    if paging_page is None or paging_page <= 0:
        return f"{PAST_RAIDS_URL}?mode=past&gid={gid}&ts=3:1"
    return f"{PAST_RAIDS_URL}?raid_pool={raid_pool}&mode=past&paging_page={paging_page}&sorter=&gid={gid}"


def parse_raid_detail_meta(html: str) -> dict:
    """Extract raid name, date, attendees from raid details page."""
    soup = BeautifulSoup(html, "lxml")
    out = {"raid_name": "", "date": "", "attendees": ""}
    # <h1>Raid Name</h1>
    h1 = soup.find("div", class_="subtitle")
    if h1:
        a = h1.find("h1")
        if a:
            out["raid_name"] = a.get_text(strip=True)
    # Date: <b>Date:</b>&nbsp;<span title="...">...</span>
    # Attendees: <b>Attendees:</b>&nbsp;29
    for div in soup.find_all("div", class_="subtitle"):
        text = div.get_text(" ", strip=True)
        if "Date:" in text:
            span = div.find("span")
            if span:
                out["date"] = span.get_text(strip=True)
        if "Attendees:" in text:
            parts = text.split("Attendees:")
            if len(parts) > 1:
                out["attendees"] = parts[1].strip().split()[0] if parts[1].strip() else ""
    return out


def main():
    ap = argparse.ArgumentParser(description="Pull past raids list and each raid details page")
    ap.add_argument("--gid", type=int, default=547766, help="Guild ID")
    ap.add_argument("--cookies-file", type=str, default="cookies.txt", help="Cookie header file")
    ap.add_argument("--sleep", type=float, default=2.5, help="Base sleep between requests (seconds)")
    ap.add_argument("--jitter", type=float, default=1.0, help="Jitter (seconds)")
    ap.add_argument("--out-dir", type=str, default="raids", help="Directory to save raid detail HTML files")
    ap.add_argument("--index", type=str, default="raids_index.csv", help="Output CSV index of raids")
    ap.add_argument("--limit-pages", type=int, default=0, help="Max list pages to fetch (0 = all)")
    ap.add_argument("--limit-raids", type=int, default=0, help="Max raid details to fetch (0 = all)")
    ap.add_argument("--since-date", type=str, default="", help="Only fetch raids on or after this date (YYYY-MM-DD). Use 2026-02-24 for data-accurate cutoff.")
    ap.add_argument("--raid-ids", type=str, default="", help="Comma-separated raid IDs only (e.g. 1598692,1598705). Skips full list scrape; fetches only these details (needs first page for raid_pool).")
    ap.add_argument("--timeout", type=int, default=30, help="Request timeout")
    args = ap.parse_args()

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
    # Set domain and path so cookies are sent on first request
    cookie_domain = "azureguardtakp.gamerlaunch.com"
    for k, v in cookies.items():
        session.cookies.set(k, v, domain=cookie_domain, path="/")

    gid = str(args.gid)

    # Step 1: First past-raids page (user URL) to get raid_pool and page count
    first_url = build_list_page_url("", gid, None)
    print(f"Fetching past raids list: {first_url}")
    try:
        r = session.get(first_url, timeout=args.timeout)
        r.raise_for_status()
    except requests.HTTPError as e:
        print(f"Failed to fetch past raids list: {e}", file=sys.stderr)
        if e.response is not None and e.response.status_code == 403:
            print("403 Forbidden: Copy cookies from Chrome DevTools while on the raids page:", file=sys.stderr)
            print("  F12 -> Network -> refresh page -> click a request -> Headers -> copy the full Cookie value.", file=sys.stderr)
            print("  Paste into cookies.txt (one line; 'Cookie:' prefix is OK).", file=sys.stderr)
        sys.exit(3)
    except Exception as e:
        print(f"Failed to fetch past raids list: {e}", file=sys.stderr)
        sys.exit(3)
    html0 = r.text
    raid_pool = extract_raid_pool_from_html(html0)
    if not raid_pool:
        print("Could not determine raid_pool from first page.", file=sys.stderr)
        sys.exit(3)
    print(f"raid_pool = {raid_pool}")
    last_page = discover_last_paging_page(html0)
    print(f"Pagination: last paging_page = {last_page}")

    all_raids: List[dict] = []
    if args.raid_ids:
        # Only fetch these raid IDs; do not scrape the full past raids list.
        raid_ids_raw = [x.strip() for x in args.raid_ids.split(",") if x.strip()]
        all_raids = [
            {"raid_id": rid, "raid_pool": raid_pool, "raid_name": "", "date": "", "gid": gid}
            for rid in raid_ids_raw
        ]
        print(f"Raid-IDs mode: fetching only {len(all_raids)} raid(s): {raid_ids_raw}")
    else:
        all_raids.extend(parse_raids_from_list_page(html0, raid_pool, gid))
        print(f"Page 0: {len(all_raids)} raids")

    polite_sleep(args.sleep, args.jitter)

    # Step 2: Remaining list pages (skip when --raid-ids)
    if not args.raid_ids:
        pages_to_fetch = list(range(1, last_page + 1))
        if args.limit_pages:
            pages_to_fetch = pages_to_fetch[: args.limit_pages]
        for p in pages_to_fetch:
            url = build_list_page_url(raid_pool, gid, p)
            try:
                r = session.get(url, timeout=args.timeout)
                r.raise_for_status()
            except Exception as e:
                print(f"List page {p} failed: {e}", file=sys.stderr)
                continue
            rows = parse_raids_from_list_page(r.text, raid_pool, gid)
            all_raids.extend(rows)
            print(f"Page {p}: {len(rows)} raids (total {len(all_raids)})")
            polite_sleep(args.sleep, args.jitter)

    # Dedupe by raid_id (same raid can appear on multiple pages in theory)
    by_id: Dict[str, dict] = {r["raid_id"]: r for r in all_raids}
    all_raids = list(by_id.values())
    all_raids.sort(key=lambda x: (x.get("date") or "", x["raid_id"]), reverse=True)
    print(f"Total unique raids: {len(all_raids)}")

    # Filter by --since-date (only when we have list dates; skip for --raid-ids)
    if args.since_date and not args.raid_ids:
        since = args.since_date.strip()
        if since:
            for r in all_raids:
                r["date_iso"] = parse_date_to_iso(r.get("date") or "")
            all_raids = [r for r in all_raids if (r.get("date_iso") or "") >= since]
            print(f"After --since-date {since}: {len(all_raids)} raids")

    # Step 3: Fetch each raid details page
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    to_fetch = all_raids
    if args.limit_raids:
        to_fetch = to_fetch[: args.limit_raids]
        print(f"Limiting to first {args.limit_raids} raids")

    for i, raid in enumerate(to_fetch):
        rid = raid["raid_id"]
        rpool = raid["raid_pool"]
        url = f"{RAID_DETAILS_URL}?raid_pool={rpool}&raidId={rid}&gid={gid}"
        out_file = out_dir / f"raid_{rid}.html"
        if out_file.exists():
            print(f"  [{i+1}/{len(to_fetch)}] {raid['raid_name']} (raidId={rid}): skip (already saved)")
            continue
        try:
            r = session.get(url, timeout=args.timeout)
            r.raise_for_status()
        except Exception as e:
            print(f"  [{i+1}/{len(to_fetch)}] {raid['raid_name']}: fetch failed: {e}", file=sys.stderr)
            continue
        out_file.write_text(r.text, encoding="utf-8")
        meta = parse_raid_detail_meta(r.text)
        raid["attendees"] = meta.get("attendees", "")
        if meta.get("date") and not raid.get("date"):
            raid["date"] = meta["date"]
        if meta.get("raid_name"):
            raid["raid_name"] = meta["raid_name"]
        raid["url"] = url
        print(f"  [{i+1}/{len(to_fetch)}] {raid['raid_name']} (raidId={rid}) -> {out_file.name}")
        polite_sleep(args.sleep, args.jitter)

    # Build index from all_raids (we have list data; details fetch may have updated date/attendees for fetched ones)
    index_raids = []
    for r in all_raids:
        index_raids.append({
            "raid_id": r["raid_id"],
            "raid_pool": r["raid_pool"],
            "raid_name": r["raid_name"],
            "date": r["date"],
            "attendees": r.get("attendees", ""),
            "url": r.get("url", f"{RAID_DETAILS_URL}?raid_pool={r['raid_pool']}&raidId={r['raid_id']}&gid={gid}"),
        })
    pd.DataFrame(index_raids).to_csv(args.index, index=False)
    print(f"Wrote {args.index} with {len(index_raids)} raids")
    print(f"Raid HTML files in {out_dir}/")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Polite roster crawler for GamerLaunch (server-rendered HTML).

What it does
- Uses your authenticated cookies (copied from Chrome DevTools) to fetch all roster pages.
- Parses the roster table into a CSV: roster_full.csv
- Saves a fetch manifest for traceability: manifest.jsonl

How to use (recommended)
1) Put your Cookie header value into a file named cookies.txt (single line), e.g.:
   _ga=...; gl_data=...; gl[session_id]=...; gl_auto[token]=...; gl_sid=...; cf_clearance=...

2) Run:
   pip install -r requirements.txt
   python pull_roster_full.py --gid 547766 --sleep 2.5 --jitter 1.0

Notes
- Keep request rate conservative. Default sleep is 2.5s + jitter.
- Cookies expire (especially cf_clearance). If you start getting login/challenge HTML, refresh cookies in Chrome.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlencode, urlparse, urljoin

import requests
import pandas as pd
from bs4 import BeautifulSoup


BASE_ROSTER_URL = "https://azureguardtakp.gamerlaunch.com/roster.php"


def parse_cookie_header(cookie_header: str) -> Dict[str, str]:
    """
    Parse a Chrome 'Cookie:' header string into a dict for requests.

    Handles cookies with bracketed names like gl[session_id].
    """
    cookies: Dict[str, str] = {}
    for part in cookie_header.split(";"):
        part = part.strip()
        if not part:
            continue
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        cookies[k.strip()] = v.strip()
    return cookies


def polite_sleep(base_sleep: float, jitter: float) -> None:
    if base_sleep <= 0:
        return
    extra = random.uniform(0, jitter) if jitter > 0 else 0.0
    time.sleep(base_sleep + extra)


@dataclass
class FetchResult:
    url: str
    status_code: int
    final_url: str
    bytes: int
    ok: bool
    note: str


def is_probably_logged_out(html: str) -> bool:
    """
    Heuristics. If these trip, your cookies likely expired or Cloudflare challenged.
    """
    lowered = html.lower()
    bad_markers = [
        "attention required",       # common Cloudflare text
        "cf-error",                 # cloudflare errors
        "cloudflare",               # cloudflare interstitial
        "login",                    # redirected to login page
        "sign in",                  # login phrasing
        "password",
    ]
    # We don't want false positives, so also require we *don't* see roster signals.
    roster_signals = ["characters found", "data-table", "roster.php?"]
    if any(m in lowered for m in bad_markers) and not any(s in lowered for s in roster_signals):
        return True
    return False


def fetch_with_retries(
    session: requests.Session,
    url: str,
    timeout: int,
    retries: int,
    backoff: float,
    manifest_fp,
) -> Tuple[str, str, FetchResult]:
    """
    Returns (final_url, html, meta)
    """
    last_exc: Optional[Exception] = None
    for attempt in range(retries + 1):
        try:
            r = session.get(url, timeout=timeout, allow_redirects=True)
            html = r.text
            meta = FetchResult(
                url=url,
                status_code=r.status_code,
                final_url=r.url,
                bytes=len(r.content) if r.content else 0,
                ok=(r.status_code == 200),
                note="",
            )

            if r.status_code != 200:
                meta.note = f"non-200 status {r.status_code}"
            elif is_probably_logged_out(html):
                meta.ok = False
                meta.note = "looks_logged_out_or_challenged"

            manifest_fp.write(json.dumps(meta.__dict__, ensure_ascii=False) + "\n")
            manifest_fp.flush()

            if meta.ok:
                return r.url, html, meta

        except Exception as e:
            last_exc = e
            meta = FetchResult(
                url=url,
                status_code=0,
                final_url="",
                bytes=0,
                ok=False,
                note=f"exception:{type(e).__name__}:{e}",
            )
            manifest_fp.write(json.dumps(meta.__dict__, ensure_ascii=False) + "\n")
            manifest_fp.flush()

        # backoff before retry
        if attempt < retries:
            sleep_s = backoff * (2 ** attempt) + random.uniform(0, backoff)
            time.sleep(sleep_s)

    raise RuntimeError(f"Failed to fetch after retries: {url} (last_exc={last_exc})")


def build_roster_url(gid: int, paging_page: Optional[int]) -> str:
    params = {
        "no_min_roster": "",
        "roster_mode": "",      # matches your working URL
        "sorter": "",
        "guild_game_id": "",
        "gid": str(gid),
    }
    if paging_page is not None:
        params["paging_page"] = str(paging_page)
    return f"{BASE_ROSTER_URL}?{urlencode(params)}"


def discover_last_page(html: str) -> int:
    soup = BeautifulSoup(html, "lxml")
    max_page = 0
    for a in soup.select("a[href*='paging_page=']"):
        href = a.get("href", "")
        try:
            part = href.split("paging_page=")[1].split("&")[0]
            max_page = max(max_page, int(part))
        except Exception:
            pass
    return max_page


def parse_roster_rows(html: str) -> List[dict]:
    soup = BeautifulSoup(html, "lxml")

    roster_table = None
    for table in soup.find_all("table"):
        ths = [th.get_text(" ", strip=True) for th in table.find_all("th")]
        if ths and "Name" in ths and "Race" in ths and "Level" in ths:
            roster_table = table
            break

    if roster_table is None:
        return []

    rows: List[dict] = []
    tbody = roster_table.find("tbody")
    trs = tbody.find_all("tr") if tbody else roster_table.find_all("tr")

    for tr in trs:
        tds = tr.find_all("td")
        if len(tds) < 6:
            continue

        name_a = tds[0].find("a")
        name = name_a.get_text(strip=True) if name_a else tds[0].get_text(strip=True)
        char_url = name_a["href"] if name_a and name_a.has_attr("href") else ""

        race = tds[1].get_text(" ", strip=True)

        class_img = tds[2].find("img")
        cls = class_img.get("title") if class_img and class_img.has_attr("title") else tds[2].get_text(" ", strip=True)

        level_txt = tds[3].get_text(strip=True)
        level = int(level_txt) if level_txt.isdigit() else level_txt

        rank = tds[4].get_text(" ", strip=True)
        claim = tds[5].get_text(" ", strip=True)

        rows.append({
            "name": name,
            "race": race,
            "class": cls,
            "level": level,
            "guild_rank": rank,
            "claim": claim,
            "character_url": char_url,
        })

    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gid", type=int, required=True, help="Guild ID, e.g. 547766")
    ap.add_argument("--cookies-file", type=str, default="cookies.txt", help="File containing Cookie header string")
    ap.add_argument("--sleep", type=float, default=2.5, help="Base sleep between requests (seconds)")
    ap.add_argument("--jitter", type=float, default=1.0, help="Random extra sleep up to this many seconds")
    ap.add_argument("--timeout", type=int, default=30, help="Request timeout seconds")
    ap.add_argument("--retries", type=int, default=3, help="Retries per page")
    ap.add_argument("--backoff", type=float, default=1.0, help="Backoff base (seconds)")
    ap.add_argument("--out", type=str, default="roster_full.csv", help="Output CSV path")
    args = ap.parse_args()

    cookie_path = Path(args.cookies_file)
    if not cookie_path.exists():
        print(f"Missing {cookie_path}. Create it with your Cookie header string on one line.", file=sys.stderr)
        sys.exit(2)

    cookie_header = cookie_path.read_text(encoding="utf-8").strip()
    if not cookie_header:
        print(f"{cookie_path} is empty.", file=sys.stderr)
        sys.exit(2)

    cookies = parse_cookie_header(cookie_header)

    # IMPORTANT: Do NOT hardcode your cookies in this script.
    # Keep them in cookies.txt (or use environment variables if you prefer).

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": "https://azureguardtakp.gamerlaunch.com/",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
    }

    s = requests.Session()
    s.headers.update(headers)
    for k, v in cookies.items():
        s.cookies.set(k, v)

    manifest_path = Path("manifest.jsonl")
    all_rows: List[dict] = []

    with manifest_path.open("a", encoding="utf-8") as mf:
        # First page (no paging_page param)
        url0 = build_roster_url(args.gid, None)
        final0, html0, meta0 = fetch_with_retries(
            s, url0, timeout=args.timeout, retries=args.retries, backoff=args.backoff, manifest_fp=mf
        )
        if not meta0.ok:
            print("First page fetch did not look authenticated.", file=sys.stderr)
            print("Try re-copying fresh cookies (especially cf_clearance), then rerun.", file=sys.stderr)
            print("Final URL:", meta0.final_url, file=sys.stderr)
            sys.exit(3)

        if "Characters found" not in html0:
            print("Warning: did not see 'Characters found' on first page. Parsing may fail.", file=sys.stderr)

        last_page = discover_last_page(html0)
        print(f"Detected last paging_page = {last_page}")

        rows0 = parse_roster_rows(html0)
        print(f"page 0: {len(rows0)} rows")
        all_rows.extend(rows0)

        polite_sleep(args.sleep, args.jitter)

        for p in range(1, last_page + 1):
            url = build_roster_url(args.gid, p)
            _, html, meta = fetch_with_retries(
                s, url, timeout=args.timeout, retries=args.retries, backoff=args.backoff, manifest_fp=mf
            )
            if not meta.ok:
                print(f"Stopping early at page {p}: fetch not ok ({meta.note}).", file=sys.stderr)
                print("This usually means cookies expired or Cloudflare challenge returned.", file=sys.stderr)
                break

            rows = parse_roster_rows(html)
            print(f"page {p}: {len(rows)} rows")
            all_rows.extend(rows)

            polite_sleep(args.sleep, args.jitter)

    df = pd.DataFrame(all_rows)
    if not df.empty:
        df = df.drop_duplicates(subset=["name", "character_url"], keep="first")
    df.to_csv(args.out, index=False)
    print(f"Wrote {args.out} with {len(df)} rows")
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()

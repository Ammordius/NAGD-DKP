#!/usr/bin/env python3
"""
Download the Gamer Launch "Current Member DKP" page (rapid_raid/members.php) for auditing.

Uses cookies.txt (same as pull_raids / roster scripts). Saves HTML so parse_members_dkp_html.py
can parse it and audit against Supabase.

Usage:
  python pull_members_dkp.py
  python pull_members_dkp.py --out data/members_dkp.html
  python pull_members_dkp.py --timestamp  # save as data/members_dkp_YYYYMMDD_HHMMSS.html

Prereqs: cookies.txt with your GamerLaunch Cookie header (one line).
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict

import requests


BASE = "https://azureguardtakp.gamerlaunch.com"
MEMBERS_DKP_URL = BASE + "/rapid_raid/members.php"
# Same first URL pull_raids uses; hitting it first establishes session so members.php accepts the cookie
RAIDS_LIST_URL = BASE + "/rapid_raid/raids.php"


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


def is_probably_logged_out(html: str) -> bool:
    """True if page looks like login/challenge instead of the DKP table."""
    lowered = html.lower()
    dkp_markers = ["dkp_earned", "dkp_spent", "data-table", "character_dkp.php"]
    has_dkp_table = any(s in html for s in dkp_markers)

    # If we have the DKP table, we're on the right page (even if login popup exists in the HTML).
    if has_dkp_table:
        return False

    bad = [
        "attention required",
        "cf-error",
        "cloudflare",
        "sign in",
        "password",
        "login",
    ]
    if any(m in lowered for m in bad):
        return True
    # Explicit login form destination to members.php (only when DKP table is absent)
    if "destination" in lowered and "members.php" in lowered and "login" in lowered:
        return True
    return False


def build_url(gid: int, ts: str | None = None) -> str:
    if ts:
        return f"{MEMBERS_DKP_URL}?gid={gid}&ts={ts}"
    return f"{MEMBERS_DKP_URL}?gid={gid}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--gid", type=int, default=547766, help="Guild ID")
    ap.add_argument("--ts", type=str, default=None, help="Optional ts query param (default: none, URL is ...?gid=547766)")
    ap.add_argument("--cookies-file", type=str, default="cookies.txt", help="File with Cookie header")
    ap.add_argument("--out", type=Path, default=None, help="Output HTML path (default: data/members_dkp.html)")
    ap.add_argument("--timestamp", action="store_true", help="Append YYYYMMDD_HHMMSS to filename")
    ap.add_argument("--timeout", type=int, default=30, help="Request timeout seconds")
    ap.add_argument("--no-warmup", action="store_true", help="Skip warmup request to raids.php (try if warmup causes issues)")
    args = ap.parse_args()

    cookie_path = Path(args.cookies_file)
    if not cookie_path.exists():
        print(f"Missing {cookie_path}. Put your GamerLaunch Cookie header on one line.", file=sys.stderr)
        return 2
    raw = cookie_path.read_text(encoding="utf-8").strip()
    if not raw:
        print(f"{cookie_path} is empty.", file=sys.stderr)
        return 2
    cookies = parse_cookie_header(raw)

    out_path = args.out
    if out_path is None:
        out_path = Path("data") / "members_dkp.html"
    if args.timestamp:
        stem = out_path.stem
        suffix = out_path.suffix
        parent = out_path.parent
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        out_path = parent / f"{stem}_{ts}{suffix}"

    out_path.parent.mkdir(parents=True, exist_ok=True)

    url = build_url(args.gid, args.ts)
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": BASE + "/",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
    }
    session = requests.Session()
    session.headers.update(headers)
    for k, v in cookies.items():
        session.cookies.set(k, v, domain="azureguardtakp.gamerlaunch.com", path="/")

    if not args.no_warmup:
        # Warmup: hit the raids list first (same as pull_raids). The site often returns login for members.php
        # unless you've already loaded a rapid_raid page in the same session.
        warmup_url = f"{RAIDS_LIST_URL}?mode=past&gid={args.gid}&ts=3:1"
        print(f"Warmup: {warmup_url}")
        try:
            warmup = session.get(warmup_url, timeout=args.timeout)
            warmup.raise_for_status()
        except Exception as e:
            print(f"Warmup request failed: {e}", file=sys.stderr)
            return 3
        # Confirm we got raids content, not login (same cookies must work for raids first)
        if "raid_pool=" not in warmup.text and "raid_details.php" not in warmup.text:
            print("Warmup returned login or wrong page (no raid_pool/raid_details). Refresh cookies from browser.", file=sys.stderr)
            return 4
        session.headers["Referer"] = warmup_url

    url = build_url(args.gid, args.ts)
    # Match browser navigation headers so the server treats this like a click from raids -> DKP
    session.headers["Origin"] = BASE
    session.headers["Sec-Fetch-Dest"] = "document"
    session.headers["Sec-Fetch-Mode"] = "navigate"
    session.headers["Sec-Fetch-Site"] = "same-origin" if session.headers.get("Referer", "").startswith(BASE) else "none"
    print(f"Fetching {url}")
    try:
        r = session.get(url, timeout=args.timeout)
        r.raise_for_status()
    except requests.HTTPError as e:
        print(f"HTTP error: {e}", file=sys.stderr)
        if e.response is not None and e.response.status_code == 403:
            print("403: Refresh cookies from Chrome (F12 -> Network -> copy Cookie header into cookies.txt).", file=sys.stderr)
        return 3
    except Exception as e:
        print(f"Request failed: {e}", file=sys.stderr)
        return 3

    html = r.text
    if is_probably_logged_out(html):
        print("Page looks like login or Cloudflare challenge, not the DKP table.", file=sys.stderr)
        print("Copy fresh cookies from Chrome while logged into Gamer Launch, then rerun.", file=sys.stderr)
        return 4

    # Quick sanity: expect DKP table
    if "dkp_earned" not in html and "Earned" not in html:
        print("Warning: response does not contain expected DKP table markers.", file=sys.stderr)

    out_path.write_text(html, encoding="utf-8")
    print(f"Saved {len(html)} bytes to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Scrape linked toons from GamerLaunch character detail pages.

Reads roster_full.csv, fetches each character's detail page, parses the
"Quick Select" dropdown (linked toons on same account), and writes:
- roster_linked.csv: name, char_id, linked_names, linked_char_ids
- account_groups.csv: one row per account with all toon names (deduplicated)
"""

from __future__ import annotations

import argparse
import re
import sys
import time
import random
from pathlib import Path
from typing import Dict, List, Set, Tuple
from urllib.parse import urlencode, parse_qs, urlparse

import requests
import pandas as pd
from bs4 import BeautifulSoup


BASE = "https://azureguardtakp.gamerlaunch.com"


def parse_cookie_header(cookie_header: str) -> Dict[str, str]:
    cookies: Dict[str, str] = {}
    for part in cookie_header.split(";"):
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


def char_id_from_url(path_query: str) -> str | None:
    """Extract char= id from character_detail URL path or path?query."""
    if "char=" in path_query:
        m = re.search(r"char=(\d+)", path_query)
        if m:
            return m.group(1)
    return None


def parse_linked_toons_from_html(html: str) -> List[Tuple[str, str]]:
    """
    Parse the Quick Select dropdown (id=character_selector) for linked toons.
    Returns list of (char_id, name).
    """
    soup = BeautifulSoup(html, "lxml")
    select = soup.find("select", id="character_selector")
    if not select:
        return []

    result: List[Tuple[str, str]] = []
    for opt in select.find_all("option"):
        val = opt.get("value") or ""
        name = opt.get_text(strip=True)
        cid = char_id_from_url(val)
        if cid and name:
            result.append((cid, name))
    return result


def main():
    ap = argparse.ArgumentParser(description="Scrape linked toons from character detail pages")
    ap.add_argument("--roster", type=str, default="roster_full.csv", help="Roster CSV from pull_roster_full.py")
    ap.add_argument("--cookies-file", type=str, default="cookies.txt", help="Cookie header file")
    ap.add_argument("--sleep", type=float, default=2.5, help="Base sleep between requests (seconds)")
    ap.add_argument("--jitter", type=float, default=1.0, help="Random jitter (seconds)")
    ap.add_argument("--out", type=str, default="roster_linked.csv", help="Output CSV for per-char linked toons")
    ap.add_argument("--accounts-out", type=str, default="account_groups.csv", help="Output CSV for unique account groups")
    ap.add_argument("--limit", type=int, default=0, help="Max character pages to fetch (0 = all)")
    ap.add_argument("--timeout", type=int, default=30, help="Request timeout")
    args = ap.parse_args()

    cookie_path = Path(args.cookies_file)
    if not cookie_path.exists():
        print(f"Missing {cookie_path}. Put your Cookie header on one line.", file=sys.stderr)
        sys.exit(2)
    cookies = parse_cookie_header(cookie_path.read_text(encoding="utf-8").strip())

    roster_path = Path(args.roster)
    if not roster_path.exists():
        print(f"Missing {roster_path}. Run pull_roster_full.py first.", file=sys.stderr)
        sys.exit(2)

    df_roster = pd.read_csv(roster_path)
    if "character_url" not in df_roster.columns or "name" not in df_roster.columns:
        print("Roster CSV must have 'name' and 'character_url'.", file=sys.stderr)
        sys.exit(2)

    # Build list of (name, char_id, full_url); dedupe by char_id
    seen_ids: Set[str] = set()
    to_fetch: List[Tuple[str, str, str]] = []
    for _, row in df_roster.iterrows():
        url_path = (row["character_url"] or "").strip()
        if not url_path:
            continue
        cid = char_id_from_url(url_path)
        if not cid or cid in seen_ids:
            continue
        seen_ids.add(cid)
        full_url = BASE + url_path if url_path.startswith("/") else BASE + "/" + url_path
        to_fetch.append((str(row["name"]), cid, full_url))

    print(f"Fetching linked toons for {len(to_fetch)} unique characters (sleep={args.sleep}s + jitter={args.jitter}s)")
    if args.limit:
        to_fetch = to_fetch[: args.limit]
        print(f"Limited to first {args.limit} characters")

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": BASE + "/",
        "Accept-Language": "en-US,en;q=0.9",
    }
    session = requests.Session()
    session.headers.update(headers)
    for k, v in cookies.items():
        session.cookies.set(k, v)

    # Skip fetching a toon if we already have their account from another linked toon
    covered: Set[str] = set()
    account_data: Dict[str, dict] = {}
    char_to_account: Dict[str, str] = {}

    rows: List[dict] = []
    fetched_count = 0
    for i, (name, char_id, url) in enumerate(to_fetch):
        if char_id in covered:
            rep = char_to_account[char_id]
            data = account_data[rep]
            rows.append({
                "name": name,
                "char_id": char_id,
                "linked_names": data["linked_names"],
                "linked_char_ids": data["linked_char_ids"],
            })
            continue

        try:
            r = session.get(url, timeout=args.timeout)
            r.raise_for_status()
        except Exception as e:
            print(f"  [{i+1}/{len(to_fetch)}] {name} ({char_id}): fetch failed: {e}", file=sys.stderr)
            continue

        linked = parse_linked_toons_from_html(r.text)
        if not linked:
            print(f"  [{i+1}/{len(to_fetch)}] {name}: no linked toons dropdown found", file=sys.stderr)

        linked_ids = [t[0] for t in linked]
        linked_names = [t[1] for t in linked]
        rep = min(linked_ids)
        account_data[rep] = {"linked_names": ",".join(linked_names), "linked_char_ids": ",".join(linked_ids)}
        for cid in linked_ids:
            char_to_account[cid] = rep
            covered.add(cid)

        rows.append({
            "name": name,
            "char_id": char_id,
            "linked_names": ",".join(linked_names),
            "linked_char_ids": ",".join(linked_ids),
        })
        fetched_count += 1
        print(f"  [{i+1}/{len(to_fetch)}] {name}: {len(linked)} linked toons (fetch #{fetched_count})")

        polite_sleep(args.sleep, args.jitter)

    if not rows:
        print("No data collected.", file=sys.stderr)
        sys.exit(1)

    out_path = Path(args.out)
    pd.DataFrame(rows).to_csv(out_path, index=False)
    print(f"Wrote {out_path}")

    # Build account groups: union-find by char_id (same linked set = same account)
    id_to_names: Dict[str, str] = {}
    id_to_linked: Dict[str, Set[str]] = {}
    for r in rows:
        cid = r["char_id"]
        id_to_names[cid] = r["name"]
        ids = [x.strip() for x in (r["linked_char_ids"] or "").split(",") if x.strip()]
        names = [x.strip() for x in (r["linked_names"] or "").split(",") if x.strip()]
        id_to_linked[cid] = set(ids)
        for i in ids:
            id_to_names.setdefault(i, i)
        for idx, i in enumerate(ids):
            if idx < len(names):
                id_to_names[i] = names[idx]

    # Union-find
    parent: Dict[str, str] = {}

    def find(x: str) -> str:
        if x not in parent:
            parent[x] = x
        if parent[x] != x:
            parent[x] = find(parent[x])
        return parent[x]

    def union(a: str, b: str) -> None:
        pa, pb = find(a), find(b)
        if pa != pb:
            parent[pa] = pb

    for cid, linked in id_to_linked.items():
        for other in linked:
            union(cid, other)

    roots: Dict[str, List[str]] = {}
    for cid in parent:
        r = find(cid)
        roots.setdefault(r, []).append(cid)

    account_rows = []
    for root, ids in roots.items():
        names = [id_to_names.get(i, i) for i in ids]
        account_rows.append({
            "account_id": root,
            "char_ids": ",".join(ids),
            "toon_names": ",".join(sorted(names)),
            "toon_count": len(ids),
        })

    acc_path = Path(args.accounts_out)
    pd.DataFrame(account_rows).to_csv(acc_path, index=False)
    print(f"Wrote {acc_path} with {len(account_rows)} account groups")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Download character DKP pages linked from the members list, then compare each
page's including-alts total and raid history to that account in the database.

Usage:
  python scripts/pull_parse_dkp_site/pull_character_dkp_pages.py download
  python scripts/pull_parse_dkp_site/pull_character_dkp_pages.py download --all
  python scripts/pull_parse_dkp_site/pull_character_dkp_pages.py compare

Requires cookies.txt (same as pull_members_dkp.py) for download, and
SUPABASE_URL plus a key for compare. No database writes.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import parse_character_dkp_html as character_pages
import parse_members_dkp_html as members_parse
import pull_members_dkp as members

OUT_DIR = ROOT / "data" / "character_dkp"
MANIFEST = OUT_DIR / "manifest.json"
REPORT = ROOT / "data" / "character_dkp_account_compare.txt"
MEMBERS_URL = (
    "https://azureguardtakp.gamerlaunch.com/rapid_raid/members.php?gid=547766&ts=1:2"
)

# Accounts whose members-list earned is above the once-per-tic account total.
MISMATCH_NAMES = [
    "Inacht",
    "Lanny",
    "Bhodi",
    "Crushzilla",
    "Fayze",
    "Rimidal",
    "Uberest",
    "Zentile",
    "Minpal",
    "Jarisy",
    "Akbar",
    "Beanwolf",
    "Slay",
    "Adilene",
    "Pugnacious",
    "Fireblade",
    "Debrie",
    "Ammordius",
    "Frinop",
    "Aldiss",
    "Jyslia",
    "Pigpen",
    "Rembylynn",
    "Zaltak",
    "Monara",
    "Darco",
    "Tuluvien",
    "Rangerwoodelf",
    "Handolur",
    "Silent",
    "Pursuit",
    "Noze",
    "Dopp",
    "Serro",
    "Headcrushar",
    "Yuukii",
    "Bopp",
]


def _safe_name(name: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*]', "_", name.strip())
    return cleaned or "character"


def _page_path(name: str, char_id: str) -> Path:
    return OUT_DIR / f"{_safe_name(name)}_{char_id}.html"


def _is_saved_character_page(path: Path) -> bool:
    if not path.is_file():
        return False
    text = path.read_text(encoding="utf-8", errors="replace")
    if members.is_probably_logged_out(text):
        return False
    return "Current DKP" in text


def parse_member_links(html: str) -> list[dict[str, Any]]:
    """Members-table rows, including the character_dkp.php href the name audit drops."""
    if character_pages.BeautifulSoup is None:
        raise RuntimeError("pip install beautifulsoup4")
    soup = character_pages.BeautifulSoup(html, "lxml")
    tbody = soup.find("tbody", class_=re.compile(r"data_table"))
    if not tbody:
        for table in soup.find_all("table"):
            if table.find("th", string=re.compile(r"Earned", re.I)):
                tbody = table.find("tbody") or table
                break
    if not tbody:
        raise ValueError("Could not find member DKP table in HTML")

    rows: list[dict[str, Any]] = []
    for tr in tbody.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 8:
            continue
        link = tds[1].find("a", href=re.compile(r"character_dkp\.php\?char="))
        if not link:
            continue
        href = character_pages._norm(link.get("href"))
        char_id = character_pages._query_param(href, character_pages.CHAR_RE)
        name = character_pages._norm(link.get_text())
        if not name or not char_id:
            continue
        earned_span = tr.find("span", class_="dkp_earned")
        spent_span = tr.find("span", class_="dkp_spent")
        rows.append({
            "name": name,
            "char_id": char_id,
            "href": href,
            "members_earned": members_parse._int_from_dkp_span(
                earned_span.get_text() if earned_span else ""
            ),
            "members_spent": members_parse._int_from_dkp_span(
                spent_span.get_text() if spent_span else ""
            ),
        })
    return rows


def _session(cookies_file: Path):
    if not cookies_file.exists():
        print(f"Missing {cookies_file}. Put your GamerLaunch Cookie header on one line.", file=sys.stderr)
        return None
    raw = cookies_file.read_text(encoding="utf-8").strip()
    if not raw:
        print(f"{cookies_file} is empty.", file=sys.stderr)
        return None
    import requests

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Referer": members.BASE + "/",
        "Accept-Language": "en-US,en;q=0.9",
        "Connection": "keep-alive",
    }
    session = requests.Session()
    session.headers.update(headers)
    for key, value in members.parse_cookie_header(raw).items():
        session.cookies.set(key, value, domain="azureguardtakp.gamerlaunch.com", path="/")
    return session


def _get(session, url: str, timeout: int) -> str | None:
    import requests

    try:
        response = session.get(url, timeout=timeout)
        response.raise_for_status()
    except requests.HTTPError as exc:
        print(f"HTTP error: {exc}", file=sys.stderr)
        if exc.response is not None and exc.response.status_code == 403:
            print(
                "403: Refresh cookies from Chrome (F12 -> Network -> copy Cookie header into cookies.txt).",
                file=sys.stderr,
            )
        return None
    except Exception as exc:
        print(f"Request failed: {exc}", file=sys.stderr)
        return None
    html = response.text
    if members.is_probably_logged_out(html):
        print("Page looks like login or Cloudflare challenge.", file=sys.stderr)
        print("Copy fresh cookies from Chrome while logged into Gamer Launch, then rerun.", file=sys.stderr)
        return None
    return html


def _warmup(session, gid: int, timeout: int) -> bool:
    warmup_url = f"{members.RAIDS_LIST_URL}?mode=past&gid={gid}&ts=3:1"
    print(f"Warmup: {warmup_url}")
    html = _get(session, warmup_url, timeout)
    if html is None:
        return False
    if "raid_pool=" not in html and "raid_details.php" not in html:
        print("Warmup returned login or wrong page. Refresh cookies from the browser.", file=sys.stderr)
        return False
    session.headers["Referer"] = warmup_url
    session.headers["Origin"] = members.BASE
    return True


def download_pages(args: argparse.Namespace) -> int:
    session = _session(Path(args.cookies_file))
    if session is None:
        return 2
    if not args.no_warmup and not _warmup(session, args.gid, args.timeout):
        return 4

    print(f"Fetching {args.members_url}")
    members_html = _get(session, args.members_url, args.timeout)
    if members_html is None:
        return 3
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    members_path = OUT_DIR / "members_dkp.html"
    members_path.write_text(members_html, encoding="utf-8")

    try:
        links = parse_member_links(members_html)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 4
    wanted = None if args.all else {name.casefold() for name in MISMATCH_NAMES}
    chosen = [row for row in links if wanted is None or row["name"].casefold() in wanted]
    if wanted is not None:
        found = {row["name"].casefold() for row in chosen}
        missing = [name for name in MISMATCH_NAMES if name.casefold() not in found]
        if missing:
            print("Not on the members page: " + ", ".join(missing), file=sys.stderr)

    print(f"{len(chosen)} character pages to fetch")
    manifest: list[dict[str, Any]] = []
    for index, row in enumerate(chosen):
        dest = _page_path(row["name"], row["char_id"])
        entry = {**row, "path": str(dest.relative_to(ROOT))}
        if _is_saved_character_page(dest):
            print(f"skip {dest.name}")
            manifest.append(entry)
            continue
        url = urljoin(members.BASE + "/", row["href"])
        print(f"[{index + 1}/{len(chosen)}] {row['name']} {url}")
        if index:
            time.sleep(args.sleep)
        html = _get(session, url, args.timeout)
        if html is None:
            MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            return 3
        if "Current DKP" not in html:
            print(f"Not a character DKP page: {url}", file=sys.stderr)
            MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            return 4
        dest.write_text(html, encoding="utf-8")
        manifest.append(entry)
    MANIFEST.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Saved {len(manifest)} pages under {OUT_DIR}")
    return 0


def _chunks(values: list[str], size: int) -> list[list[str]]:
    return [values[i:i + size] for i in range(0, len(values), size)]


def _one_tic_values(events: list[dict[str, Any]]) -> dict[tuple[str, str], int]:
    """Sum the tics stored under one attendance event_id. Same order and name count once."""
    best: dict[tuple[str, str, str, str], tuple[int, int]] = {}
    for event in events:
        raid_id = character_pages._norm(event.get("raid_id"))
        event_id = character_pages._norm(event.get("event_id"))
        if not raid_id or not event_id:
            continue
        try:
            row_id = int(event.get("id") or 0)
        except (TypeError, ValueError):
            row_id = 0
        order = character_pages._norm(event.get("event_order"))
        name = character_pages._norm(event.get("event_name")).casefold()
        value = character_pages._int_from_text(str(event.get("dkp_value") or 0))
        key = (raid_id, event_id, order, name)
        current = best.get(key)
        if current is None or row_id < current[0]:
            best[key] = (row_id, value)
    totals: dict[tuple[str, str], int] = {}
    for (raid_id, event_id, _order, _name), (_row_id, value) in best.items():
        totals[(raid_id, event_id)] = totals.get((raid_id, event_id), 0) + value
    return totals


def _fetch_ordered(client: Any, table: str, columns: str, order_by: str, **filters: Any) -> list[dict[str, Any]]:
    """Page with a stable order. Unordered range() skips rows on large tables."""
    out: list[dict[str, Any]] = []
    offset = 0
    page_size = 1000
    while True:
        query = client.table(table).select(columns)
        for key, val in filters.items():
            if isinstance(val, list):
                if not val:
                    return out
                query = query.in_(key, val)
            elif val is None:
                query = query.is_(key, "null")
            else:
                query = query.eq(key, val)
        resp = query.order(order_by).range(offset, offset + page_size - 1).execute()
        rows = resp.data or []
        if not rows:
            break
        out.extend(rows)
        if len(rows) < page_size:
            break
        offset += page_size
    return out


def _names_for_accounts(client: Any, account_ids: list[str]) -> dict[str, str]:
    """Character name to account, for attendance rows that were never stamped with an account."""
    links = _fetch_ordered(
        client, "character_account", "char_id,account_id", "char_id", account_id=account_ids
    )
    char_account: dict[str, str] = {}
    for row in links:
        char_id = character_pages._norm(row.get("char_id"))
        account_id = character_pages._norm(row.get("account_id"))
        if char_id and account_id and char_id not in char_account:
            char_account[char_id] = account_id
    names: dict[str, str] = {}
    ambiguous: set[str] = set()
    for chunk in _chunks(sorted(char_account), 80):
        for row in _fetch_ordered(client, "characters", "char_id,name", "char_id", char_id=chunk):
            name = character_pages._norm(row.get("name"))
            account_id = char_account.get(character_pages._norm(row.get("char_id")), "")
            if not name or not account_id:
                continue
            previous = names.get(name)
            if previous and previous != account_id:
                ambiguous.add(name)
            else:
                names[name] = account_id
    for name in ambiguous:
        names.pop(name, None)
    return names


def _account_raid_earned(client: Any, account_ids: list[str]) -> dict[tuple[str, str], int]:
    wanted = set(account_ids)
    attendance: list[dict[str, Any]] = []
    for chunk in _chunks(account_ids, 8):
        attendance.extend(
            _fetch_ordered(
                client,
                "raid_event_attendance",
                "id,account_id,raid_id,event_id,character_name",
                "id",
                account_id=chunk,
            )
        )
    name_to_account = _names_for_accounts(client, account_ids)
    for chunk in _chunks(sorted(name_to_account), 40):
        attendance.extend(
            _fetch_ordered(
                client,
                "raid_event_attendance",
                "id,account_id,raid_id,event_id,character_name",
                "id",
                character_name=chunk,
                account_id=None,
            )
        )
    seen: set[tuple[str, str, str]] = set()
    raid_ids: set[str] = set()
    for row in attendance:
        account_id = character_pages._norm(row.get("account_id"))
        if account_id not in wanted:
            account_id = "" if account_id else name_to_account.get(
                character_pages._norm(row.get("character_name")), ""
            )
        raid_id = character_pages._norm(row.get("raid_id"))
        event_id = character_pages._norm(row.get("event_id"))
        if account_id and raid_id and event_id:
            seen.add((account_id, raid_id, event_id))
            raid_ids.add(raid_id)

    events: list[dict[str, Any]] = []
    for chunk in _chunks(sorted(raid_ids), 40):
        events.extend(
            _fetch_ordered(
                client, "raid_events", "id,raid_id,event_id,event_order,event_name,dkp_value", "id", raid_id=chunk
            )
        )
    values = _one_tic_values(events)
    earned: dict[tuple[str, str], int] = {}
    for account_id, raid_id, event_id in seen:
        key = (account_id, raid_id)
        earned[key] = earned.get(key, 0) + values.get((raid_id, event_id), 0)
    return earned


def _raid_name_key(name: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "", (name or "").casefold())
    if text.startswith("po"):
        text = text[2:]
    return text


def _alias_manual_raids(
    client: Any,
    raid_earned: dict[tuple[str, str], int],
    page_raids: dict[str, dict[str, Any]],
) -> dict[tuple[str, str], int]:
    """Move attendance stored under manual-* ids onto the site raid id for the same night."""
    manual_ids = sorted({raid_id for _account, raid_id in raid_earned if raid_id.startswith("manual-")})
    if not manual_ids:
        return raid_earned
    info = {
        character_pages._norm(row.get("raid_id")): row
        for row in _fetch_ordered(
            client, "raids", "raid_id,raid_name,date_iso", "raid_id", raid_id=manual_ids
        )
    }
    alias: dict[str, str] = {}
    for raid_id, row in info.items():
        key = _raid_name_key(row.get("raid_name") or "")
        date = character_pages._norm(row.get("date_iso"))
        if not key or not date:
            continue
        matches = []
        for site_id, page in page_raids.items():
            if _raid_name_key(page.get("raid_name") or "") != key:
                continue
            site_date = character_pages._norm(page.get("date"))
            if site_date and abs(_date_delta(site_date, date)) <= 1:
                matches.append(site_id)
        if len(matches) == 1:
            alias[raid_id] = matches[0]
    if not alias:
        return raid_earned
    merged: dict[tuple[str, str], int] = {}
    for (account_id, raid_id), earned in raid_earned.items():
        raid_id = alias.get(raid_id, raid_id)
        key = (account_id, raid_id)
        merged[key] = merged.get(key, 0) + earned
    return merged


def _date_delta(left: str, right: str) -> int:
    from datetime import date

    try:
        return abs((date.fromisoformat(left[:10]) - date.fromisoformat(right[:10])).days)
    except ValueError:
        return 999


def _load_manifest() -> list[dict[str, Any]]:
    if not MANIFEST.exists():
        pages = sorted(OUT_DIR.glob("*.html"))
        pages = [p for p in pages if p.name != "members_dkp.html" and _is_saved_character_page(p)]
        return [{"path": str(p.relative_to(ROOT)), "name": p.stem} for p in pages]
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else []


def compare_pages() -> int:
    character_pages.load_dotenv()
    import os

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    )
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY) for compare.", file=sys.stderr)
        return 1
    try:
        from supabase import create_client
    except ImportError:
        print("pip install supabase", file=sys.stderr)
        return 1

    manifest = _load_manifest()
    if not manifest:
        print(f"No saved pages in {OUT_DIR}. Run download first.", file=sys.stderr)
        return 1

    client = create_client(url, key)
    accounts = members_parse.fetch_all(client, "accounts", "account_id, display_name, toon_names")
    links = members_parse.fetch_all(client, "character_account", "char_id, account_id")
    characters = members_parse.fetch_all(client, "characters", "char_id, name")
    name_to_aid = members_parse.build_name_to_account_id(accounts, links, characters)
    summary = {
        character_pages._norm(row.get("account_id")): row
        for row in members_parse.fetch_all(client, "account_dkp_summary", "account_id, earned, spent")
    }

    parsed: list[tuple[dict[str, Any], dict[str, Any]]] = []
    account_ids: list[str] = []
    for entry in manifest:
        path = ROOT / entry["path"]
        if not path.is_file():
            print(f"Missing {path}", file=sys.stderr)
            continue
        page = character_pages.parse_character_dkp_html(path)
        name = entry.get("name") or page.get("name") or ""
        account_id = name_to_aid.get(name) or name_to_aid.get(page.get("name") or "")
        entry = {**entry, "resolved_name": name, "account_id": account_id}
        parsed.append((entry, page))
        if account_id:
            account_ids.append(account_id)

    raid_earned = _account_raid_earned(client, sorted(set(account_ids)))
    page_raid_meta: dict[str, dict[str, Any]] = {}
    for _entry, page in parsed:
        for raid in page.get("raids") or []:
            page_raid_meta.setdefault(raid["raid_id"], raid)
    raid_earned = _alias_manual_raids(client, raid_earned, page_raid_meta)
    raid_titles: dict[str, str] = {}
    titled_ids = sorted({raid_id for _account_id, raid_id in raid_earned})
    for chunk in _chunks(titled_ids, 80):
        for row in _fetch_ordered(client, "raids", "raid_id,raid_name", "raid_id", raid_id=chunk):
            raid_titles[character_pages._norm(row.get("raid_id"))] = character_pages._norm(row.get("raid_name"))
    lines: list[str] = ["=== Character pages vs account totals ===", ""]
    mismatches = 0
    for entry, page in parsed:
        account_id = entry.get("account_id") or ""
        label = entry.get("resolved_name") or page.get("name") or "?"
        if page.get("has_including_alts"):
            page_earned = int(page["including_alts_earned"])
            page_spent = int(page["including_alts_spent"])
        else:
            page_earned = int(page["earned"])
            page_spent = int(page["spent"])
        db = summary.get(account_id, {})
        db_earned = int(db.get("earned") or 0)
        db_spent = int(db.get("spent") or 0)
        earned_delta = page_earned - db_earned
        spent_delta = page_spent - db_spent
        lines.append(f"{label} (account_id={account_id or 'unmatched'})")
        lines.append(f"  earned: page={page_earned}  DB={db_earned}  delta={earned_delta}")
        lines.append(f"  spent:  page={page_spent}  DB={db_spent}  delta={spent_delta}")

        page_raids: dict[str, int] = {}
        raid_names: dict[str, str] = {}
        for raid in page.get("raids") or []:
            raid_id = raid["raid_id"]
            page_raids[raid_id] = page_raids.get(raid_id, 0) + int(raid["earned"])
            raid_names[raid_id] = raid.get("raid_name") or raid_titles.get(raid_id, "")
        raid_sum = sum(page_raids.values())
        if raid_sum != page_earned:
            lines.append(f"  raid history on this page sums to {raid_sum}")
        db_raids = {
            raid_id: earned
            for (aid, raid_id), earned in raid_earned.items()
            if aid == account_id
        }
        raid_ids = sorted(set(page_raids) | set(db_raids))
        diffs = []
        for raid_id in raid_ids:
            page_val = page_raids.get(raid_id, 0)
            db_val = db_raids.get(raid_id, 0)
            if page_val != db_val:
                diffs.append((raid_id, raid_names.get(raid_id) or raid_titles.get(raid_id, ""), page_val, db_val))
        if diffs:
            lines.append("  raids that differ:")
            for raid_id, raid_name, page_val, db_val in diffs:
                lines.append(f"    {raid_id} {raid_name}  page={page_val}  DB={db_val}")
        if not account_id or earned_delta or spent_delta or diffs:
            mismatches += 1
        lines.append("")

    if mismatches:
        lines.append(f"Differences: {mismatches}")
    else:
        lines.append("Character pages match the account totals.")
    report = "\n".join(lines).rstrip() + "\n"
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(report, encoding="utf-8")
    print(report, end="")
    print(f"Wrote {REPORT}")
    return 1 if mismatches else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    download = sub.add_parser("download", help="Download character DKP pages linked from the members list")
    download.add_argument("--members-url", default=MEMBERS_URL)
    download.add_argument("--gid", type=int, default=547766)
    download.add_argument("--cookies-file", default="cookies.txt")
    download.add_argument("--sleep", type=float, default=2.0, help="Seconds between character pages")
    download.add_argument("--timeout", type=int, default=30)
    download.add_argument("--no-warmup", action="store_true")
    download.add_argument("--all", action="store_true", help="Download every member link, not only the mismatch list")

    sub.add_parser("compare", help="Compare saved pages to account totals, one account at a time")

    args = parser.parse_args()
    if args.command == "download":
        return download_pages(args)
    return compare_pages()


if __name__ == "__main__":
    sys.exit(main())

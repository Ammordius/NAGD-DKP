#!/usr/bin/env python3
"""
Parse saved Gamer Launch character DKP pages (character_dkp.php, Chrome "complete webpage")
and compare each character's raid and item history to Supabase.

The page has two totals for the NAGD pool:
  Current DKP (Including Alts)  — the account number the members list shows
  Current DKP                   — this character only

Usage:
  python scripts/pull_parse_dkp_site/parse_character_dkp_html.py parse
  python scripts/pull_parse_dkp_site/parse_character_dkp_html.py parse data/asparagus.html -o data/character_dkp_snapshot.json
  python scripts/pull_parse_dkp_site/parse_character_dkp_html.py compare
  python scripts/pull_parse_dkp_site/parse_character_dkp_html.py compare data/asparagus.html

With no paths, parse/compare every data/*.html that is a character DKP page
(including alt pages that only have "Current DKP", not "Including Alts").
Folders named *_files/ are skipped. Requires SUPABASE_* for compare.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent

try:
    from bs4 import BeautifulSoup, Tag
except ImportError:
    BeautifulSoup = None  # type: ignore
    Tag = Any  # type: ignore

MARKER = "Current DKP (Including Alts)"
# Alt pages omit the including-alts heading and only have "Current DKP - {pool}".
CHARACTER_PAGE = "Current DKP - "
CHAR_RE = re.compile(r"[?&]char=(\d+)")
RAID_RE = re.compile(r"[?&]raidId=([^&\"'#]+)", re.I)
EVENT_RE = re.compile(r"[?&]raid_event_id=(\d+)")


def load_dotenv() -> None:
    for env_path in (ROOT / ".env", ROOT / "web" / ".env", ROOT / "web" / ".env.local"):
        if not env_path.exists():
            continue
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip("'\"")
            if k and k not in os.environ:
                os.environ[k] = v
        for vite, plain in (
            ("VITE_SUPABASE_URL", "SUPABASE_URL"),
            ("VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"),
            ("VITE_SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
        ):
            if not os.environ.get(plain) and os.environ.get(vite):
                os.environ[plain] = os.environ[vite]


def _resolve_path(p: Path) -> Path:
    if not p.is_absolute():
        return (ROOT / p).resolve()
    return p.resolve()


def _norm(s: str | None) -> str:
    return "" if s is None else str(s).strip()


def _int_from_text(text: str) -> int:
    cleaned = re.sub(r"[,\s]", "", _norm(text))
    if not cleaned:
        return 0
    try:
        return int(cleaned)
    except ValueError:
        try:
            return int(float(cleaned))
        except ValueError:
            return 0


def _query_param(href: str | None, pattern: re.Pattern[str]) -> str:
    if not href:
        return ""
    m = pattern.search(href)
    return m.group(1) if m else ""


def discover_html(paths: list[Path] | None) -> list[Path]:
    """Saved character pages. Explicit files are used as given; directories and the default scan data/*.html."""
    if not paths:
        candidates = sorted((ROOT / "data").glob("*.html"))
    else:
        candidates = []
        for raw in paths:
            p = _resolve_path(raw)
            if p.is_dir():
                candidates.extend(sorted(p.glob("*.html")))
            else:
                candidates.append(p)
    found: list[Path] = []
    for p in candidates:
        if not p.is_file():
            continue
        if p.parent.name.endswith("_files"):
            continue
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if MARKER in text or (CHARACTER_PAGE in text and "Raid History" in text):
            found.append(p)
    return found


def _next_table(heading: Tag) -> Tag | None:
    for sib in heading.next_siblings:
        name = getattr(sib, "name", None)
        if name == "table":
            return sib
        if name in ("h3", "h4"):
            return None
        if name and hasattr(sib, "find"):
            table = sib.find("table")
            if table:
                return table
    return None


def _span_int(tr: Tag, class_name: str) -> int:
    span = tr.find("span", class_=class_name)
    return _int_from_text(span.get_text(" ", strip=True) if span else "")


def _is_main_link(a: Tag) -> bool:
    prev = a.previous_sibling
    while prev is not None and not getattr(prev, "name", None):
        prev = getattr(prev, "previous_sibling", None)
    if getattr(prev, "name", None) != "img":
        return False
    blob = f"{prev.get('title') or ''} {prev.get('src') or ''}".lower()
    return "main" in blob or "crown" in blob


def _identity(soup: Tag) -> tuple[str, str]:
    nav = soup.select_one(".panelSubNav")
    if nav:
        link = nav.find("a", href=CHAR_RE)
        if link:
            return _norm(link.get_text()), _query_param(link.get("href"), CHAR_RE)
    selected = soup.select_one("#character_selector option[selected]")
    if selected:
        return _norm(selected.get_text()), _query_param(selected.get("value"), CHAR_RE)
    link = soup.find("a", href=re.compile(r"character_dkp\.php\?char=\d+"))
    if link:
        return _norm(link.get_text()), _query_param(link.get("href"), CHAR_RE)
    return "", ""


def _pool_name(heading_text: str) -> str:
    if " - " in heading_text:
        return heading_text.split(" - ", 1)[1].strip()
    return ""


def _parse_totals(soup: Tag) -> list[dict[str, Any]]:
    totals: list[dict[str, Any]] = []
    for h4 in soup.find_all("h4"):
        text = " ".join(h4.get_text(" ", strip=True).split())
        if not text.startswith("Current DKP"):
            continue
        table = _next_table(h4)
        if not table:
            continue
        data_row = None
        for tr in table.find_all("tr"):
            if tr.find("span", class_="dkp_earned"):
                data_row = tr
                break
        if data_row is None:
            continue
        cells = data_row.find_all("td")
        last_raid = _norm(cells[3].get_text(" ", strip=True)) if len(cells) > 3 else ""
        totals.append({
            "including_alts": text.startswith("Current DKP (Including Alts)"),
            "pool": _pool_name(text),
            "earned": _span_int(data_row, "dkp_earned"),
            "spent": _span_int(data_row, "dkp_spent"),
            "total": _span_int(data_row, "dkp_current"),
            "last_raid": last_raid,
        })
    return totals


def _parse_alts(soup: Tag) -> list[dict[str, Any]]:
    heading = None
    for h3 in soup.find_all("h3"):
        if h3.get_text(" ", strip=True) == "Alts":
            heading = h3
            break
    if heading is None:
        return []
    container = heading.find_parent("div") or heading.parent
    alts: list[dict[str, Any]] = []
    seen: set[str] = set()
    for a in container.find_all("a", href=CHAR_RE):
        char_id = _query_param(a.get("href"), CHAR_RE)
        if not char_id or char_id in seen:
            continue
        if "character_dkp.php" not in (a.get("href") or "") and "character_detail.php" not in (a.get("href") or ""):
            continue
        seen.add(char_id)
        alts.append({
            "name": _norm(a.get_text()),
            "char_id": char_id,
            "is_main": _is_main_link(a),
        })
    return alts


def _parse_raid_history(soup: Tag) -> list[dict[str, Any]]:
    heading = None
    for h3 in soup.find_all("h3"):
        if h3.get_text(" ", strip=True) == "Raid History":
            heading = h3
            break
    if heading is None:
        return []
    table = _next_table(heading)
    if table is None:
        return []
    rows: list[dict[str, Any]] = []
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 3:
            continue
        link = tds[0].find("a", href=RAID_RE)
        if not link:
            continue
        rows.append({
            "raid_name": _norm(link.get_text()),
            "raid_id": _query_param(link.get("href"), RAID_RE),
            "date": _norm(tds[1].get_text(" ", strip=True)),
            "earned": _int_from_text(tds[2].get_text(" ", strip=True)),
        })
    return rows


def _item_name(td: Tag) -> str:
    span = td.find("span")
    raw = span.get_text(" ", strip=True) if span else td.get_text(" ", strip=True)
    raw = _norm(raw)
    if raw.startswith("[") and "]" in raw:
        raw = raw[1:raw.index("]")]
    return raw.strip()


def _parse_items(soup: Tag) -> list[dict[str, Any]]:
    heading = None
    for h4 in soup.find_all("h4"):
        if h4.get_text(" ", strip=True) == "Item History":
            heading = h4
            break
    if heading is None:
        return []
    table = _next_table(heading)
    if table is None:
        return []
    rows: list[dict[str, Any]] = []
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 5:
            continue
        raid_link = tds[3].find("a", href=RAID_RE)
        event_link = tds[4].find("a", href=EVENT_RE)
        if not raid_link:
            continue
        rows.append({
            "item_name": _item_name(tds[0]),
            "spent": _int_from_text(tds[1].get_text(" ", strip=True)),
            "date": _norm(tds[2].get_text(" ", strip=True)),
            "raid_id": _query_param(raid_link.get("href"), RAID_RE),
            "raid_name": _norm(raid_link.get_text()),
            "raid_event_id": _query_param(event_link.get("href"), EVENT_RE) if event_link else "",
            "event_name": _norm(event_link.get_text()) if event_link else "",
        })
    return rows


def _parse_adjustments(soup: Tag) -> list[dict[str, Any]]:
    heading = None
    for h4 in soup.find_all("h4"):
        if h4.get_text(" ", strip=True) == "Adjustments":
            heading = h4
            break
    if heading is None:
        return []
    table = _next_table(heading)
    if table is None:
        return []
    rows: list[dict[str, Any]] = []
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 6:
            continue
        rows.append({
            "date": _norm(tds[0].get_text(" ", strip=True)),
            "amount": _int_from_text(tds[1].get_text(" ", strip=True)),
            "reason": _norm(tds[2].get_text(" ", strip=True)),
            "earned": _int_from_text(tds[3].get_text(" ", strip=True)),
            "spent": _int_from_text(tds[4].get_text(" ", strip=True)),
            "total": _int_from_text(tds[5].get_text(" ", strip=True)),
        })
    return rows


def _pick_total(totals: list[dict[str, Any]], including_alts: bool) -> dict[str, Any] | None:
    nagd = [t for t in totals if t["including_alts"] is including_alts and "NAGD" in t.get("pool", "")]
    if nagd:
        return nagd[0]
    matching = [t for t in totals if t["including_alts"] is including_alts]
    return matching[0] if matching else None


def parse_character_dkp_html(html_path: Path) -> dict[str, Any]:
    if BeautifulSoup is None:
        raise RuntimeError("pip install beautifulsoup4")
    html = html_path.read_text(encoding="utf-8", errors="replace")
    soup = BeautifulSoup(html, "lxml")
    name, char_id = _identity(soup)
    totals = _parse_totals(soup)
    character = _pick_total(totals, False) or {"earned": 0, "spent": 0, "total": 0, "pool": "", "last_raid": ""}
    including_row = _pick_total(totals, True)
    including = including_row or {"earned": 0, "spent": 0, "total": 0, "pool": "", "last_raid": ""}
    raids = _parse_raid_history(soup)
    items = _parse_items(soup)
    adjustments = _parse_adjustments(soup)
    raid_earned = sum(r["earned"] for r in raids)
    item_spent = sum(i["spent"] for i in items)
    adjustment_earned = sum(a["earned"] for a in adjustments)
    adjustment_spent = sum(a["spent"] for a in adjustments)
    warnings: list[str] = []
    if raids and raid_earned + adjustment_earned != character["earned"]:
        warnings.append(
            f"raid history earned {raid_earned} + adjustments {adjustment_earned} "
            f"!= character earned {character['earned']}"
        )
    if items and item_spent + adjustment_spent != character["spent"]:
        warnings.append(
            f"item history spent {item_spent} + adjustments {adjustment_spent} "
            f"!= character spent {character['spent']}"
        )
    if not items and character["spent"] and character["spent"] != adjustment_spent:
        warnings.append(f"no item history but character spent is {character['spent']}")
    if not raids and character["earned"] and character["earned"] != adjustment_earned:
        warnings.append(f"no raid history but character earned is {character['earned']}")
    return {
        "source": str(html_path.relative_to(ROOT)) if html_path.is_relative_to(ROOT) else str(html_path),
        "name": name,
        "char_id": char_id,
        "pool": character.get("pool") or including.get("pool") or "",
        "earned": character["earned"],
        "spent": character["spent"],
        "total": character["total"],
        "last_raid": character.get("last_raid") or "",
        "has_including_alts": including_row is not None,
        "including_alts_earned": including["earned"],
        "including_alts_spent": including["spent"],
        "including_alts_total": including["total"],
        "alts": _parse_alts(soup),
        "raids": raids,
        "items": items,
        "adjustments": adjustments,
        "warnings": warnings,
    }


def _print_page(page: dict[str, Any]) -> None:
    including = ""
    if page.get("has_including_alts"):
        including = f"  including alts {page['including_alts_earned']}/{page['including_alts_spent']}"
    print(
        f"{page['name']} (char_id={page['char_id']})  "
        f"character {page['earned']}/{page['spent']}{including}  "
        f"raids={len(page['raids'])} items={len(page['items'])} adjustments={len(page['adjustments'])}"
    )
    alt_bits = [
        f"{a['name']}{'*' if a['is_main'] else ''} ({a['char_id']})"
        for a in page["alts"]
    ]
    if alt_bits:
        print(f"  alts: {', '.join(alt_bits)}")
    for warning in page["warnings"]:
        print(f"  warning: {warning}")


def fetch_filtered(client: Any, table: str, columns: str, **filters: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    offset = 0
    page_size = 1000
    while True:
        q = client.table(table).select(columns)
        for key, val in filters.items():
            if isinstance(val, list):
                if not val:
                    return out
                q = q.in_(key, val)
            else:
                q = q.eq(key, val)
        resp = q.range(offset, offset + page_size - 1).execute()
        rows = resp.data or []
        if not rows:
            break
        out.extend(rows)
        if len(rows) < page_size:
            break
        offset += page_size
    return out


def _chunk(values: list[str], size: int = 100) -> list[list[str]]:
    return [values[i:i + size] for i in range(0, len(values), size)]


def _db_earned_by_raid(client: Any, char_ids: list[str]) -> dict[tuple[str, str], int]:
    attendance = fetch_filtered(
        client, "raid_event_attendance", "char_id,raid_id,event_id", char_id=char_ids
    )
    raid_ids = sorted({_norm(r.get("raid_id")) for r in attendance if _norm(r.get("raid_id"))})
    dkp_by_event: dict[tuple[str, str], int] = {}
    for chunk in _chunk(raid_ids):
        for ev in fetch_filtered(client, "raid_events", "raid_id,event_id,dkp_value", raid_id=chunk):
            dkp_by_event[(_norm(ev.get("raid_id")), _norm(ev.get("event_id")))] = _int_from_text(
                str(ev.get("dkp_value") or 0)
            )
    earned: dict[tuple[str, str], int] = {}
    for row in attendance:
        char_id = _norm(row.get("char_id"))
        raid_id = _norm(row.get("raid_id"))
        event_id = _norm(row.get("event_id"))
        key = (char_id, raid_id)
        earned[key] = earned.get(key, 0) + dkp_by_event.get((raid_id, event_id), 0)
    return earned


def _db_items(client: Any, char_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    rows = fetch_filtered(
        client, "raid_loot", "id,char_id,raid_id,event_id,item_name,cost", char_id=char_ids
    )
    by_char: dict[str, list[dict[str, Any]]] = {cid: [] for cid in char_ids}
    for row in rows:
        cid = _norm(row.get("char_id"))
        by_char.setdefault(cid, []).append({
            "item_name": _norm(row.get("item_name")),
            "spent": _int_from_text(str(row.get("cost") or 0)),
            "raid_id": _norm(row.get("raid_id")),
            "raid_event_id": _norm(row.get("event_id")),
        })
    return by_char


def _count_map(rows: list[tuple]) -> dict[tuple, int]:
    out: dict[tuple, int] = {}
    for row in rows:
        out[row] = out.get(row, 0) + 1
    return out


def _missing(page_counts: dict[tuple, int], db_counts: dict[tuple, int]) -> list[tuple]:
    missing: list[tuple] = []
    for key, count in page_counts.items():
        gap = count - db_counts.get(key, 0)
        missing.extend([key] * gap)
    return missing


def _alt_groups(pages: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    by_id = {p["char_id"]: p for p in pages if p.get("char_id")}
    seen: set[str] = set()
    groups: list[list[dict[str, Any]]] = []
    for page in pages:
        cid = page.get("char_id") or ""
        if not cid or cid in seen:
            continue
        member_ids = [a["char_id"] for a in page.get("alts") or []] or [cid]
        group = []
        for mid in member_ids:
            seen.add(mid)
            if mid in by_id:
                group.append(by_id[mid])
        if page not in group:
            group.append(page)
            seen.add(cid)
        groups.append(group)
    return groups


def _group_label(group: list[dict[str, Any]]) -> str:
    for page in group:
        for alt in page.get("alts") or []:
            if alt.get("is_main"):
                return f"{alt['name']} ({alt['char_id']})"
    page = group[0]
    return f"{page['name']} ({page['char_id']})"


def compare_pages(pages: list[dict[str, Any]]) -> int:
    load_dotenv()
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

    client = create_client(url, key)
    char_ids = [p["char_id"] for p in pages if p.get("char_id")]
    earned_by_raid = _db_earned_by_raid(client, char_ids)
    items_by_char = _db_items(client, char_ids)
    mismatches = 0

    print("=== Characters ===")
    for page in pages:
        cid = page["char_id"]
        db_raids = {raid_id: earned for (char_id, raid_id), earned in earned_by_raid.items() if char_id == cid}
        page_raids: dict[str, int] = {}
        raid_names: dict[str, str] = {}
        for raid in page["raids"]:
            page_raids[raid["raid_id"]] = page_raids.get(raid["raid_id"], 0) + raid["earned"]
            raid_names[raid["raid_id"]] = raid["raid_name"]
        db_earned = sum(db_raids.values())
        db_items = items_by_char.get(cid, [])
        db_spent = sum(item["spent"] for item in db_items)
        earned_delta = page["earned"] - db_earned
        spent_delta = page["spent"] - db_spent
        print(f"{page['name']} (char_id={cid})")
        print(f"  earned: page={page['earned']}  DB={db_earned}  delta={earned_delta}")
        print(f"  spent:  page={page['spent']}  DB={db_spent}  delta={spent_delta}")

        only_page_raids = []
        for raid_id, earned in sorted(page_raids.items(), key=lambda kv: kv[0]):
            db_val = db_raids.get(raid_id, 0)
            if earned != db_val:
                only_page_raids.append((raid_id, raid_names.get(raid_id, ""), earned, db_val))
        only_db_raids = [
            (raid_id, earned) for raid_id, earned in sorted(db_raids.items()) if raid_id not in page_raids
        ]
        if only_page_raids or only_db_raids:
            mismatches += 1
            if only_page_raids:
                print("  raids that differ:")
                for raid_id, name, page_earned, db_val in only_page_raids:
                    print(f"    {raid_id} {name}  page={page_earned}  DB={db_val}")
            if only_db_raids:
                print("  raids only in DB:")
                for raid_id, earned in only_db_raids:
                    print(f"    {raid_id}  DB={earned}")

        page_item_keys = [
            (item["raid_id"], item["raid_event_id"], item["spent"], item["item_name"])
            for item in page["items"]
        ]
        db_item_keys = [
            (item["raid_id"], item["raid_event_id"], item["spent"], item["item_name"])
            for item in db_items
        ]
        page_counts = _count_map([(k[0], k[1], k[2]) for k in page_item_keys])
        db_counts = _count_map([(k[0], k[1], k[2]) for k in db_item_keys])
        page_only = _missing(page_counts, db_counts)
        db_only = _missing(db_counts, page_counts)
        if page_only or db_only:
            mismatches += 1
            names_for = {}
            for raid_id, event_id, spent, item_name in page_item_keys:
                names_for.setdefault((raid_id, event_id, spent), item_name)
            db_names = {}
            for raid_id, event_id, spent, item_name in db_item_keys:
                db_names.setdefault((raid_id, event_id, spent), item_name)
            if page_only:
                print("  items only on page:")
                for key in page_only:
                    print(f"    raid={key[0]} event={key[1]} spent={key[2]}  {names_for.get(key, '')}")
            if db_only:
                print("  items only in DB:")
                for key in db_only:
                    print(f"    raid={key[0]} event={key[1]} spent={key[2]}  {db_names.get(key, '')}")
        elif earned_delta or spent_delta:
            mismatches += 1

    print()
    print("=== Including alts ===")
    for group in _alt_groups(pages):
        listed = next((p.get("alts") or [] for p in group if p.get("alts")), [])
        saved_ids = {p["char_id"] for p in group}
        missing_pages = [a for a in listed if a["char_id"] not in saved_ids]
        saved_earned = sum(p["earned"] for p in group)
        saved_spent = sum(p["spent"] for p in group)
        anchor = next((p for p in group if p.get("has_including_alts")), None)
        html_earned = anchor["including_alts_earned"] if anchor else saved_earned
        html_spent = anchor["including_alts_spent"] if anchor else saved_spent
        print(f"{_group_label(group)}")
        print(
            f"  including alts: page={html_earned}/{html_spent}  "
            f"saved character pages={saved_earned}/{saved_spent}  "
            f"delta={html_earned - saved_earned}/{html_spent - saved_spent}"
        )
        if missing_pages:
            mismatches += 1
            names = ", ".join(f"{a['name']} ({a['char_id']})" for a in missing_pages)
            print(f"  no saved page for: {names}")
        elif html_earned != saved_earned or html_spent != saved_spent:
            mismatches += 1
            print("  saved pages do not add up to the including-alts total")

    print()
    if mismatches:
        print(f"Differences: {mismatches}")
    else:
        print("Saved pages match the database.")
    return 1 if mismatches else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_parse = sub.add_parser("parse", help="Parse saved character DKP HTML to JSON")
    p_parse.add_argument("paths", nargs="*", type=Path, help="HTML files or a directory (default: data/*.html)")
    p_parse.add_argument("-o", "--out", dest="out_json", type=Path, default=None)

    p_compare = sub.add_parser("compare", help="Compare parsed pages to raid attendance and loot")
    p_compare.add_argument("paths", nargs="*", type=Path, help="HTML files or a directory (default: data/*.html)")

    args = parser.parse_args()
    pages_paths = discover_html(getattr(args, "paths", None) or None)
    if not pages_paths:
        print("No saved character DKP pages found (looked for Current DKP (Including Alts)).", file=sys.stderr)
        return 1

    pages = [parse_character_dkp_html(path) for path in pages_paths]
    for page in pages:
        _print_page(page)

    if args.command == "parse":
        if args.out_json:
            out = _resolve_path(args.out_json)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps({"characters": pages}, indent=2), encoding="utf-8")
            print(f"Wrote {out}")
        return 1 if any(p["warnings"] for p in pages) else 0

    print()
    return compare_pages(pages)


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Backfill missing raid_loot rows from an officer spreadsheet export (TSV/CSV).

Expected columns (header row, case-insensitive): Item, Spent, Date, Raid Name, Event
(or ItemSpent when item and cost share one column). Rows pasted as ``[item] cost`` without a tab
before the number shift columns; the script repairs that when Spent looks like an ISO date.

Optional: raid_id — when set, skips fuzzy raid matching for that row.
Optional: event_id — when set, skips fuzzy event matching for that row (must belong to the resolved raid).

By default, once a raid is resolved the script does **not** require event matching: it uses the first
``raid_events`` row for that raid (by ``event_order``), or leaves ``event_id`` empty when the raid has
no event rows in the DB (common for raids indexed without a detail HTML upload). Use ``--strict-event``
to require fuzzy event matching again.

The sheet ``Event`` column is only used for fuzzy matching when ``--strict-event`` is set, or to rank
candidates in reports. Optional ``event_id`` column still wins when provided.

Raid matching uses ``--date-slop-days`` (default 1): DB raid date may differ from the sheet date by
up to that many days while still matching by raid name score. If many rows show ``unresolved_raid``,
try ``--date-slop-days 2`` or ``3``, lower ``--min-raid-score`` slightly, or set ``raid_id`` on stubborn rows.
If still unmatched, the default **nearest-date** fallback picks the closest ``raids.date_iso`` within
``--nearest-raid-max-days`` (see ``--no-nearest-raid-fallback``).

After resolving inserts, the script prints total DKP (sum of integer cost) that would apply to the
named character for new loot rows (dry-run and apply).

Use ``--explain-duplicates`` to print sample lines that were skipped as duplicates (already in raid_loot).
Use ``--explain-duplicate-limit N`` to show more than the default 25 samples.

Spend is recorded only on ``raid_loot`` (item_name is free text); nothing is validated against a guild item list.

Use ``--no-dedupe`` only if you intentionally want every resolved row inserted even when it matches existing
raid_loot (fixes false duplicate matches but can double-count spent).

Use ``--explain-unresolved`` to print sample unresolved rows with top raid/event fuzzy candidates.

Example::

  python scripts/pull_parse_dkp_site/backfill_loot_spend_from_officer_table.py \\
    --in data/karis_loot.tsv --character Karis --dry-run
  python scripts/pull_parse_dkp_site/backfill_loot_spend_from_officer_table.py \\
    --in data/karis_loot.tsv --character Karis --apply

Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see web/.env).
After --apply, calls refresh_account_dkp_summary() so account spent totals update.
Use --also-refresh-dkp-summary to also run refresh_dkp_summary() (legacy character cache / windows).
"""

from __future__ import annotations

import argparse
import csv
import difflib
import io
import os
import re
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent

PAGE_SIZE = 5000
INSERT_BATCH = 100

# Default fuzzy thresholds (ratio 0..1)
DEFAULT_MIN_RAID_SCORE = 0.35
DEFAULT_MIN_EVENT_SCORE = 0.55


def _load_env_file(path: Path) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip("'\"")
            if k:
                os.environ.setdefault(k, v)
    for vite, plain in (
        ("VITE_SUPABASE_URL", "SUPABASE_URL"),
        ("VITE_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY"),
        ("VITE_SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
    ):
        if not os.environ.get(plain) and os.environ.get(vite):
            os.environ[plain] = os.environ[vite]


def load_dotenv() -> None:
    for path in (ROOT / ".env", ROOT / "web" / ".env", ROOT / "web" / ".env.local"):
        if path.exists():
            _load_env_file(path)


def fetch_all(client: Any, table: str, select: str = "*") -> list[dict]:
    out: list[dict] = []
    offset = 0
    while True:
        resp = client.table(table).select(select).range(offset, offset + PAGE_SIZE - 1).execute()
        rows = resp.data or []
        if not rows:
            break
        out.extend(rows)
        if len(rows) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return out


def raid_date_from_iso(date_iso: str | None) -> date | None:
    """Match SQL raid_date_parsed: leading YYYY-MM-DD only."""
    if not date_iso:
        return None
    t = str(date_iso).strip()
    if len(t) >= 10 and re.match(r"^\d{4}-\d{2}-\d{2}", t):
        try:
            return datetime.strptime(t[:10], "%Y-%m-%d").date()
        except ValueError:
            return None
    return None


def parse_row_date(s: str) -> date | None:
    """Parse Date column; stdlib only."""
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y", "%m/%d/%y", "%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    # Loose M/D/YYYY with trailing junk
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})\b", s)
    if m:
        a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100:
            y += 2000 if y < 70 else 1900
        for month, day in ((a, b), (b, a)):
            if 1 <= month <= 12 and 1 <= day <= 31:
                try:
                    return date(y, month, day)
                except ValueError:
                    continue
    return None


def parse_row_date_with_typos(s: str) -> date | None:
    """Like parse_row_date but fixes common one-digit month typo (e.g. 0/3/2019 -> 9/3/2019)."""
    d = parse_row_date(s)
    if d is not None:
        return d
    s2 = (s or "").strip()
    if re.match(r"^0/\d{1,2}/\d{4}", s2):
        return parse_row_date(re.sub(r"^0/", "9/", s2, count=1))
    return None


# Item cell sometimes pasted as ``[Name] 6`` (space before cost) so tabs shift: Spent holds ISO date.
_ITEM_INLINE_COST = re.compile(r"^(.+\])\s*(\d+)\s*$")


def _looks_like_iso_date_prefix(s: str) -> bool:
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}", (s or "").strip()))


def normalize_officer_row_cells(
    raw_item: str,
    spent_c: str,
    date_c: str,
    raid_c: str,
    event_c: str,
) -> tuple[str, str, str, str, str]:
    """Undo ``[item] cost`` merged into Item when that shifted Spent/Date/Raid/Event columns."""
    raw_item = (raw_item or "").strip()
    spent_c = (spent_c or "").strip()
    date_c = (date_c or "").strip()
    raid_c = (raid_c or "").strip()
    event_c = (event_c or "").strip()

    m = _ITEM_INLINE_COST.match(raw_item)
    if m and _looks_like_iso_date_prefix(spent_c):
        item_name = strip_item_brackets(m.group(1))
        cost = m.group(2)
        # spent_c is the real calendar date; date_c is raid title; raid_c is often event label
        return item_name, cost, spent_c, date_c, raid_c
    if m:
        item_name = strip_item_brackets(m.group(1))
        inline_cost = m.group(2)
        if spent_c.isdigit():
            return item_name, spent_c, date_c, raid_c, event_c
        return item_name, inline_cost, date_c, raid_c, event_c
    return strip_item_brackets(raw_item), spent_c, date_c, raid_c, event_c


def norm_match_text(s: str) -> str:
    s = (s or "").lower()
    return " ".join("".join(ch if ch.isalnum() else " " for ch in s).split())


def score_similar(a: str, b: str) -> float:
    na, nb = norm_match_text(a), norm_match_text(b)
    if not na and not nb:
        return 1.0
    if not na or not nb:
        return 0.0
    return difflib.SequenceMatcher(None, na, nb).ratio()


def strip_item_brackets(name: str) -> str:
    s = (name or "").strip()
    if s.startswith("[") and s.endswith("]") and len(s) >= 2:
        s = s[1:-1].strip()
    return s


@dataclass
class ParsedRow:
    line_no: int
    item: str
    spent: str
    date_raw: str
    raid_name: str
    event: str
    raid_id_override: str = ""
    event_id_override: str = ""


@dataclass
class ResolvedInsert:
    raid_id: str
    event_id: str
    item_name: str
    char_id: str | None
    character_name: str
    cost: str
    source_line_no: int
    event_match_score: float
    raid_match_score: float


def _normalize_header(h: str) -> str:
    return re.sub(r"\s+", " ", (h or "").strip().lower())


def _sniff_delimiter(sample: str) -> str:
    first = sample.splitlines()[0] if sample else ""
    return "\t" if first.count("\t") >= first.count(",") else ","


def read_officer_table(path: Path) -> list[ParsedRow]:
    raw = path.read_text(encoding="utf-8-sig")
    delim = _sniff_delimiter(raw)
    reader = csv.DictReader(io.StringIO(raw), delimiter=delim)
    if not reader.fieldnames:
        raise SystemExit(f"No header row in {path}")

    fn_map: dict[str, str] = {}
    for col in reader.fieldnames:
        key = _normalize_header(col)
        fn_map[key] = col

    def col(*aliases: str) -> str | None:
        for a in aliases:
            k = _normalize_header(a)
            if k in fn_map:
                return fn_map[k]
        return None

    c_item = col("item")
    c_spent = col("spent")
    c_itemspent = col("itemspent", "item spent")
    c_date = col("date")
    c_raid_name = col("raid name", "raid_name")
    c_event = col("event")
    c_raid_id = col("raid_id", "raid id")
    c_event_id = col("event_id", "event id")

    if c_itemspent and not c_item:
        c_item = c_itemspent
        c_spent = c_itemspent

    missing: list[str] = []
    if not (c_item or c_itemspent):
        missing.append("Item")
    if not c_spent and not c_itemspent:
        missing.append("Spent")
    if not c_date:
        missing.append("Date")
    if not c_raid_name:
        missing.append("Raid Name")
    if not c_event:
        missing.append("Event")
    if missing:
        raise SystemExit(f"Missing required columns: {', '.join(missing)}. Found: {reader.fieldnames}")

    rows: list[ParsedRow] = []
    for i, rec in enumerate(reader, start=2):
        assert c_item and c_spent and c_date and c_raid_name and c_event
        raw_item = (rec.get(c_item) or "").strip()
        spent_c = (rec.get(c_spent) or "").strip()
        item, spent, date_raw, raid_name, event = normalize_officer_row_cells(
            raw_item, spent_c,
            (rec.get(c_date) or "").strip(),
            (rec.get(c_raid_name) or "").strip(),
            (rec.get(c_event) or "").strip(),
        )
        rid_ov = ""
        if c_raid_id:
            rid_ov = (rec.get(c_raid_id) or "").strip()
        eid_ov = ""
        if c_event_id:
            eid_ov = (rec.get(c_event_id) or "").strip()
        rows.append(
            ParsedRow(
                line_no=i,
                item=item,
                spent=str(spent).strip(),
                date_raw=date_raw,
                raid_name=raid_name,
                event=event,
                raid_id_override=rid_ov,
                event_id_override=eid_ov,
            )
        )
    return rows


def pick_best_raid(
    row: ParsedRow,
    row_date: date,
    raids_by_id: dict[str, dict],
    min_score: float,
    *,
    date_slop_days: int,
) -> tuple[str | None, float, list[tuple[str, float, str]]]:
    """Returns (raid_id or None, best_score, top candidates for logging)."""
    if row.raid_id_override:
        rid = row.raid_id_override.strip()
        if rid not in raids_by_id:
            return None, 0.0, []
        r = raids_by_id[rid]
        d = raid_date_from_iso(r.get("date_iso"))
        score = score_similar(row.raid_name, r.get("raid_name") or "")
        if d is not None and abs((d - row_date).days) > date_slop_days:
            print(
                f"  line {row.line_no}: WARN raid_id override {rid}: DB date_iso={r.get('date_iso')!r} "
                f"differs from row date {row_date} by > {date_slop_days} day(s); using override anyway",
                file=sys.stderr,
            )
        return rid, score, [(rid, score, r.get("raid_name") or "")]

    scored: list[tuple[str, float, str]] = []
    for rid, r in raids_by_id.items():
        d = raid_date_from_iso(r.get("date_iso"))
        if d is None:
            continue
        if abs((d - row_date).days) > date_slop_days:
            continue
        name = r.get("raid_name") or ""
        sc = score_similar(row.raid_name, name)
        if d == row_date:
            sc = min(1.0, sc + 0.001)
        scored.append((rid, sc, name))
    if not scored:
        return None, 0.0, []
    scored.sort(key=lambda x: -x[1])
    best = scored[0][1]
    if best < min_score:
        return None, best, scored[:5]
    tied_at_top = [t for t in scored if abs(t[1] - best) <= 1e-9]
    if len(tied_at_top) > 1:
        return None, best, scored[:5]
    return tied_at_top[0][0], best, scored[:5]


def pick_nearest_raid_by_date(
    row_date: date,
    raid_name: str,
    raids_by_id: dict[str, dict],
    *,
    max_days: int | None,
) -> tuple[str | None, float, list[tuple[str, float, str]], int]:
    """Closest raid by calendar date, then best name score. Returns (raid_id, name_score, top5, day_diff)."""
    ranked: list[tuple[int, float, str, str]] = []
    for rid, r in raids_by_id.items():
        d = raid_date_from_iso(r.get("date_iso"))
        if d is None:
            continue
        day_diff = abs((d - row_date).days)
        if max_days is not None and day_diff > max_days:
            continue
        name = r.get("raid_name") or ""
        sc = score_similar(raid_name, name)
        ranked.append((day_diff, -sc, rid, name))
    if not ranked:
        return None, 0.0, [], -1
    ranked.sort()
    day_diff, neg_sc, rid, name = ranked[0]
    top = [(r[2], -r[1], r[3]) for r in ranked[:5]]
    return rid, -neg_sc, top, day_diff


def pick_event_id(
    raid_id: str,
    event_text: str,
    events_by_raid: dict[str, list[dict]],
    min_score: float,
) -> tuple[str | None, float, str]:
    """Returns (event_id, score, note)."""
    events = events_by_raid.get(raid_id) or []
    if not events:
        return None, 0.0, "no_events_for_raid"
    best_eid: str | None = None
    best_sc = -1.0
    for ev in events:
        eid = str(ev.get("event_id") or "").strip()
        ename = ev.get("event_name") or ""
        sc = score_similar(event_text, ename)
        if sc > best_sc:
            best_sc = sc
            best_eid = eid or None
    if best_sc >= min_score and best_eid:
        return best_eid, best_sc, "matched"
    if len(events) == 1:
        only = str(events[0].get("event_id") or "").strip()
        if only:
            return only, best_sc, "fallback_single_event"
    return None, best_sc, "no_match"


def pick_any_event_id(
    raid_id: str,
    events_by_raid: dict[str, list[dict]],
) -> tuple[str | None, str]:
    """First event_id for raid (lowest event_order), when fuzzy matching is not required."""
    events = events_by_raid.get(raid_id) or []
    if not events:
        return None, "no_events_for_raid"

    def sort_key(ev: dict) -> tuple[int, str]:
        eo = ev.get("event_order")
        try:
            order = int(eo) if eo is not None and str(eo).strip() != "" else 999999
        except (TypeError, ValueError):
            order = 999999
        return (order, str(ev.get("event_id") or ""))

    for ev in sorted(events, key=sort_key):
        eid = str(ev.get("event_id") or "").strip()
        if eid:
            return eid, "fallback_any_event"
    return None, "no_events_for_raid"


def rank_event_candidates(
    raid_id: str,
    event_text: str,
    events_by_raid: dict[str, list[dict]],
) -> list[tuple[str, float, str]]:
    """(event_id, score, event_name) sorted by score descending."""
    out: list[tuple[str, float, str]] = []
    for ev in events_by_raid.get(raid_id) or []:
        eid = str(ev.get("event_id") or "").strip()
        if not eid:
            continue
        ename = ev.get("event_name") or ""
        out.append((eid, score_similar(event_text, ename), ename))
    out.sort(key=lambda x: -x[1])
    return out


def format_event_rankings(ranked: list[tuple[str, float, str]], limit: int) -> str:
    """Single-cell TSV-safe summary for report rows."""
    parts: list[str] = []
    for eid, sc, ename in ranked[: max(0, limit)]:
        safe = (ename or "").replace("\t", " ").replace("\n", " ")[:80]
        parts.append(f"{eid}:{sc:.2f}:{safe}")
    return " ; ".join(parts)


def build_event_id_index(all_events: list[dict]) -> dict[str, list[tuple[str, str]]]:
    """event_id -> [(raid_id, event_name), ...] for diagnostics when override is wrong raid."""
    idx: dict[str, list[tuple[str, str]]] = {}
    for ev in all_events:
        eid = str(ev.get("event_id") or "").strip()
        if not eid:
            continue
        rid = str(ev.get("raid_id") or "").strip()
        ename = ev.get("event_name") or ""
        idx.setdefault(eid, []).append((rid, ename))
    return idx


def loot_dedupe_key(
    raid_id: str,
    event_id: str,
    item_name: str,
    character_name: str,
    cost: str,
) -> tuple[str, str, str, str, str]:
    return (
        raid_id.strip(),
        (event_id or "").strip(),
        norm_match_text(item_name),
        (character_name or "").strip().lower(),
        str(cost or "").strip(),
    )


def sum_insert_costs(to_insert: list[dict[str, Any]]) -> tuple[int, int]:
    """Sum integer DKP costs; returns (total, count_of_unparseable_costs)."""
    total = 0
    bad = 0
    for r in to_insert:
        s = str(r.get("cost") or "").strip()
        if not s:
            continue
        try:
            total += int(s, 10)
        except ValueError:
            bad += 1
    return total, bad


def main() -> int:
    load_dotenv()
    sys.path.insert(0, str(SCRIPT_DIR))
    from upload_raid_detail_to_supabase import _fetch_characters_maps, _resolve_upload_char_id

    ap = argparse.ArgumentParser(
        description="Backfill raid_loot from officer table (Item, Spent, Date, Raid Name, Event)."
    )
    ap.add_argument("--in", dest="in_path", type=Path, required=True, help="Input TSV or CSV path")
    ap.add_argument("--character", required=True, help="Buyer character name (must exist in characters)")
    ap.add_argument("--dry-run", action="store_true", help="Resolve and report only; no inserts")
    ap.add_argument("--apply", action="store_true", help="Insert rows and refresh summaries")
    ap.add_argument(
        "--min-raid-score",
        type=float,
        default=DEFAULT_MIN_RAID_SCORE,
        help="Min fuzzy score for sheet Raid Name vs raids.raid_name (default 0.35). Lower slightly if many unresolved_raid.",
    )
    ap.add_argument(
        "--min-event-score",
        type=float,
        default=DEFAULT_MIN_EVENT_SCORE,
        help="Min fuzzy score for sheet Event vs raid_events.event_name (default 0.55). Prefer event_id column when guild labels differ from Rapid Raid headers.",
    )
    ap.add_argument(
        "--date-slop-days",
        type=int,
        default=1,
        metavar="N",
        help="Match raids when abs(raid_date - row_date) <= N days (default 1). Try 2–3 if site raid date is often off by a weekend boundary vs the officer date.",
    )
    ap.add_argument(
        "--nearest-raid-max-days",
        type=int,
        default=60,
        metavar="N",
        help="When fuzzy raid match fails, pick closest raids.date_iso within N days (default 60).",
    )
    ap.add_argument(
        "--no-nearest-raid-fallback",
        action="store_true",
        help="Do not assign rows to the nearest-date raid when fuzzy/slop matching fails.",
    )
    ap.add_argument(
        "--strict-event",
        action="store_true",
        help="Require fuzzy Event vs raid_events.event_name (or event_id column). Default: use any event on the raid, or empty event_id if none.",
    )
    ap.add_argument("--report", type=Path, default=None, help="Write unresolved/problem rows as TSV here")
    ap.add_argument(
        "--explain-duplicates",
        action="store_true",
        help="After counts, print sample sheet rows skipped as duplicates (see --explain-duplicate-limit).",
    )
    ap.add_argument(
        "--explain-duplicate-limit",
        type=int,
        default=25,
        metavar="N",
        help="Max duplicate samples to print with --explain-duplicates (default 25).",
    )
    ap.add_argument(
        "--explain-unresolved",
        action="store_true",
        help="After counts, print sample unresolved_raid / unresolved_event rows with top fuzzy candidates.",
    )
    ap.add_argument(
        "--explain-unresolved-limit",
        type=int,
        default=25,
        metavar="N",
        help="Max unresolved samples to print with --explain-unresolved (default 25).",
    )
    ap.add_argument(
        "--no-dedupe",
        action="store_true",
        help="Insert every resolved row even if an identical raid_loot key already exists (DANGEROUS: double-counts spent unless you clean DB first).",
    )
    ap.add_argument(
        "--also-refresh-dkp-summary",
        action="store_true",
        help="After apply, also call refresh_dkp_summary() (legacy dkp_summary / period windows).",
    )
    ap.add_argument(
        "--no-refresh",
        action="store_true",
        help="With --apply, skip refresh_account_dkp_summary (not recommended).",
    )
    args = ap.parse_args()

    if args.apply and args.dry_run:
        print("Use only one of --apply or --dry-run.", file=sys.stderr)
        return 2
    if not args.apply and not args.dry_run:
        print("Specify --dry-run or --apply.", file=sys.stderr)
        return 2

    in_path: Path = args.in_path
    if not in_path.is_file():
        print(f"Input not found: {in_path}", file=sys.stderr)
        return 1

    try:
        parsed_rows = read_officer_table(in_path)
    except SystemExit as e:
        print(str(e), file=sys.stderr)
        return 1

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    )
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)
    known_char_ids, name_to_char_id = _fetch_characters_maps(client)
    buyer_name = args.character.strip()
    resolved_cid, note = _resolve_upload_char_id(
        None,
        buyer_name,
        known_char_ids=known_char_ids,
        name_to_char_id=name_to_char_id,
    )
    if not resolved_cid and buyer_name.lower() not in name_to_char_id:
        print(
            f"ERROR: character {buyer_name!r} not found in public.characters (by name).",
            file=sys.stderr,
        )
        return 1
    char_id_for_insert: str | None = resolved_cid
    if note:
        print(note)

    raids = fetch_all(client, "raids", "raid_id, raid_name, date_iso")
    raids_by_id = {str(r["raid_id"]).strip(): r for r in raids if r.get("raid_id")}

    all_events = fetch_all(client, "raid_events", "raid_id, event_id, event_name, event_order")
    events_by_raid: dict[str, list[dict]] = {}
    for ev in all_events:
        rid = str(ev.get("raid_id") or "").strip()
        events_by_raid.setdefault(rid, []).append(ev)

    event_id_index = build_event_id_index(all_events)

    stats = {
        "parsed": len(parsed_rows),
        "bad_date": 0,
        "unresolved_raid": 0,
        "unresolved_event": 0,
        "duplicate": 0,
        "to_insert": 0,
    }
    report_lines: list[list[str]] = []
    resolved: list[ResolvedInsert] = []
    explain_unresolved: list[str] = []
    explain_unres_lim = max(0, args.explain_unresolved_limit)

    def push_explain_unresolved(block: str) -> None:
        if args.explain_unresolved and len(explain_unresolved) < explain_unres_lim:
            explain_unresolved.append(block)

    for row in parsed_rows:
        rd = parse_row_date_with_typos(row.date_raw)
        if not rd:
            stats["bad_date"] += 1
            report_lines.append([
                str(row.line_no), row.item, row.spent, row.date_raw, row.raid_name, row.event,
                row.raid_id_override, row.event_id_override, "", "", "bad_date",
            ])
            continue

        rid, rscore, candidates = pick_best_raid(
            row, rd, raids_by_id, args.min_raid_score, date_slop_days=max(0, args.date_slop_days),
        )
        if not rid and not args.no_nearest_raid_fallback:
            max_nd = max(0, args.nearest_raid_max_days)
            near_rid, near_sc, near_cands, near_days = pick_nearest_raid_by_date(
                rd, row.raid_name, raids_by_id, max_days=max_nd if max_nd else None,
            )
            if near_rid:
                rid, rscore, candidates = near_rid, near_sc, near_cands
                print(
                    f"  line {row.line_no}: WARN raid fuzzy/slop failed; using nearest-date "
                    f"raid_id={rid} ({near_days} day(s) from row date) name_score={rscore:.2f}",
                    file=sys.stderr,
                )
        if not rid:
            stats["unresolved_raid"] += 1
            cand_str = "; ".join(f"{c[0]}({c[1]:.2f}:{c[2][:40]})" for c in candidates[:3])
            report_lines.append([
                str(row.line_no), row.item, row.spent, row.date_raw, row.raid_name, row.event,
                row.raid_id_override, row.event_id_override, "", "", f"unresolved_raid:{cand_str}",
            ])
            blk = (
                f"  unresolved_raid line {row.line_no} date={row.date_raw!r} raid_name={row.raid_name!r} "
                f"raid_id_override={row.raid_id_override!r}\n"
            )
            if candidates:
                blk += "    top raid candidates (id score name_prefix):\n"
                for c0, c1, c2 in candidates[:5]:
                    blk += f"      {c0}  {c1:.2f}  {c2[:72]!r}\n"
            else:
                blk += (
                    "    (no raids with parseable date_iso in DB, or none within --nearest-raid-max-days; "
                    "raids table may be missing that era)\n"
                )
            push_explain_unresolved(blk)
            continue

        ranked_events = rank_event_candidates(rid, row.event, events_by_raid)
        top_events_cell = format_event_rankings(ranked_events, 8)

        eid_ov = (row.event_id_override or "").strip()
        eid: str | None = None
        escore = 0.0
        enote = ""

        if eid_ov:
            ev_ids = {
                str(e.get("event_id") or "").strip()
                for e in (events_by_raid.get(rid) or [])
                if e.get("event_id")
            }
            if eid_ov in ev_ids:
                eid, escore, enote = eid_ov, 1.0, "event_id_override"
            elif args.strict_event:
                stats["unresolved_event"] += 1
                where = event_id_index.get(eid_ov, [])
                where_s = (
                    "; ".join(f"raid_id={r} name={n[:50]!r}" for r, n in where[:4])
                    if where
                    else "event_id not found in raid_events"
                )
                reason = f"unresolved_event:bad_event_id_override:{eid_ov!r} not in raid {rid}; {where_s}"
                report_lines.append([
                    str(row.line_no), row.item, row.spent, row.date_raw, row.raid_name, row.event,
                    row.raid_id_override, row.event_id_override, rid, top_events_cell, reason,
                ])
                blk = (
                    f"  unresolved_event line {row.line_no} resolved_raid_id={rid} "
                    f"event_id_override={eid_ov!r} sheet_event={row.event!r}\n"
                    f"    {reason}\n"
                )
                if ranked_events:
                    blk += "    top event fuzzy scores for this raid (id:score:name):\n"
                    for e_eid, e_sc, e_nm in ranked_events[:5]:
                        blk += f"      {e_eid}  {e_sc:.2f}  {e_nm[:72]!r}\n"
                else:
                    blk += "    (0 rows in raid_events for this raid_id)\n"
                push_explain_unresolved(blk)
                continue
            else:
                print(
                    f"  line {row.line_no}: WARN event_id override {eid_ov!r} not on raid {rid}; "
                    f"ignoring override",
                    file=sys.stderr,
                )

        if not eid:
            eid, escore, enote = pick_event_id(
                rid, row.event, events_by_raid, args.min_event_score,
            )

        if not eid and not args.strict_event:
            eid, enote = pick_any_event_id(rid, events_by_raid)
            escore = 0.0
            if not eid and enote == "no_events_for_raid":
                eid = ""
                enote = "no_events_empty_event_id"

        if not eid and args.strict_event:
            stats["unresolved_event"] += 1
            report_lines.append([
                str(row.line_no), row.item, row.spent, row.date_raw, row.raid_name, row.event,
                row.raid_id_override, row.event_id_override, rid, top_events_cell,
                f"unresolved_event:{enote}:{escore:.2f}",
            ])
            blk = (
                f"  unresolved_event line {row.line_no} resolved_raid_id={rid} "
                f"sheet_event={row.event!r} min_event_score={args.min_event_score}\n"
            )
            if ranked_events:
                blk += "    top event fuzzy scores for this raid (id:score:name):\n"
                for e_eid, e_sc, e_nm in ranked_events[:5]:
                    blk += f"      {e_eid}  {e_sc:.2f}  {e_nm[:72]!r}\n"
            else:
                blk += "    (0 rows in raid_events for this raid_id — upload raid detail HTML or set event_id)\n"
            push_explain_unresolved(blk)
            continue

        if enote == "fallback_single_event":
            print(
                f"  line {row.line_no}: WARN event fuzzy low ({escore:.2f}); "
                f"using single event_id={eid} for raid {rid}",
                file=sys.stderr,
            )
        elif enote == "fallback_any_event":
            print(
                f"  line {row.line_no}: WARN using first event_id={eid} for raid {rid} "
                f"(sheet Event={row.event!r} not matched)",
                file=sys.stderr,
            )
        elif enote == "no_events_empty_event_id":
            print(
                f"  line {row.line_no}: WARN raid_id={rid} has no raid_events rows; "
                f"inserting loot with empty event_id",
                file=sys.stderr,
            )

        resolved.append(
            ResolvedInsert(
                raid_id=rid,
                event_id=eid,
                item_name=row.item,
                char_id=char_id_for_insert,
                character_name=buyer_name,
                cost=row.spent,
                source_line_no=row.line_no,
                event_match_score=escore,
                raid_match_score=rscore,
            )
        )

    raid_ids_needed = {r.raid_id for r in resolved}
    existing_keys: set[tuple[str, str, str, str, str]] = set()
    buyer_lower = buyer_name.strip().lower()
    existing_loot_rows_for_buyer = 0
    if raid_ids_needed:
        # PostgREST in() — batch raid ids to avoid huge URLs
        id_list = list(raid_ids_needed)
        for i in range(0, len(id_list), 80):
            chunk = id_list[i : i + 80]
            resp = (
                client.table("raid_loot")
                .select("raid_id, event_id, item_name, character_name, char_id, cost")
                .in_("raid_id", chunk)
                .execute()
            )
            for lr in resp.data or []:
                cname = (lr.get("character_name") or "").strip()
                cid = (lr.get("char_id") or "").strip()
                name_match = cname.lower() == buyer_lower
                id_match = bool(char_id_for_insert and cid == char_id_for_insert)
                if not name_match and not id_match:
                    continue
                existing_loot_rows_for_buyer += 1
                existing_keys.add(
                    loot_dedupe_key(
                        str(lr.get("raid_id") or ""),
                        str(lr.get("event_id") or ""),
                        str(lr.get("item_name") or ""),
                        buyer_name,
                        str(lr.get("cost") or ""),
                    )
                )

    db_keys_only: frozenset = frozenset(existing_keys)

    to_insert: list[dict[str, Any]] = []
    duplicate_samples: list[str] = []
    dup_limit = max(0, args.explain_duplicate_limit)
    for r in resolved:
        key = loot_dedupe_key(r.raid_id, r.event_id, r.item_name, buyer_name, r.cost)
        if not args.no_dedupe and key in existing_keys:
            stats["duplicate"] += 1
            if args.explain_duplicates and len(duplicate_samples) < dup_limit:
                duplicate_samples.append(
                    f"  line {r.source_line_no}  raid_id={r.raid_id}  event_id={r.event_id}  "
                    f"item={r.item_name!r}  cost={r.cost}"
                )
            continue
        if not args.no_dedupe:
            existing_keys.add(key)
        to_insert.append({
            "raid_id": r.raid_id,
            "event_id": r.event_id,
            "item_name": r.item_name,
            "char_id": r.char_id or None,
            "character_name": r.character_name,
            "cost": r.cost,
        })
        stats["to_insert"] += 1

    collide_with_db = 0
    if args.no_dedupe and resolved:
        for r in resolved:
            key = loot_dedupe_key(r.raid_id, r.event_id, r.item_name, buyer_name, r.cost)
            if key in db_keys_only:
                collide_with_db += 1

    print(
        f"Parsed={stats['parsed']} bad_date={stats['bad_date']} "
        f"unresolved_raid={stats['unresolved_raid']} unresolved_event={stats['unresolved_event']} "
        f"duplicate={stats['duplicate']} to_insert={stats['to_insert']}"
    )
    chk = (
        stats["bad_date"] + stats["unresolved_raid"] + stats["unresolved_event"] + len(resolved)
    )
    print(
        f"Reconcile (must equal parsed): bad_date({stats['bad_date']}) + unresolved_raid({stats['unresolved_raid']}) "
        f"+ unresolved_event({stats['unresolved_event']}) + resolved({len(resolved)}) = {chk} "
        f"(parsed={stats['parsed']})"
    )
    if chk != stats["parsed"]:
        print("  ERROR: reconciliation mismatch — file a bug with your input sample.", file=sys.stderr)
    r2 = stats["duplicate"] + stats["to_insert"]
    print(
        f"Reconcile resolved: duplicate({stats['duplicate']}) + to_insert({stats['to_insert']}) = {r2} "
        f"(resolved={len(resolved)})"
    )
    if not args.no_dedupe and r2 != len(resolved):
        print("  ERROR: duplicate+to_insert != resolved", file=sys.stderr)
    if args.no_dedupe:
        print(
            f"WARNING: --no-dedupe: inserting all {len(resolved)} resolved row(s). "
            f"{collide_with_db} of them match an existing raid_loot key for this buyer "
            f"(spent totals will double-count those unless you delete/fix DB rows first).",
            file=sys.stderr,
        )

    print(
        f"Resolved raid+event: {len(resolved)} row(s). "
        f"Existing raid_loot rows for this buyer in those raids (dedupe pool): {existing_loot_rows_for_buyer}."
    )
    print(
        "Note: there is no separate item catalog — spend is stored as text on raid_loot.item_name. "
        "duplicate=N means N resolved rows already match an existing raid_loot row for this buyer "
        "(same raid_id, event_id, normalized item name, and cost)."
    )
    if explain_unresolved:
        print("--- explain-unresolved (samples; see --explain-unresolved-limit) ---")
        for block in explain_unresolved:
            print(block)
    if duplicate_samples:
        total_dup = stats["duplicate"]
        cap = len(duplicate_samples)
        print(
            f"Sample rows skipped as duplicate (already in DB), first {cap} of {total_dup}:"
        )
        for line in duplicate_samples:
            print(line)
    total_dkp, bad_cost = sum_insert_costs(to_insert)
    acct = buyer_name.strip()
    print(
        f"Account spend from new loot (sum of cost for {acct}): {total_dkp} DKP "
        f"across {len(to_insert)} new row(s)."
    )
    if bad_cost:
        print(
            f"  Warning: {bad_cost} row(s) had a non-integer cost and were omitted from the sum.",
            file=sys.stderr,
        )

    if args.report and report_lines:
        rep = args.report
        rep.parent.mkdir(parents=True, exist_ok=True)
        with rep.open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, delimiter="\t")
            w.writerow([
                "line_no", "item", "spent", "date", "raid_name", "event",
                "raid_id_override", "event_id_override", "resolved_raid_id",
                "event_top_candidates", "reason",
            ])
            w.writerows(report_lines)
        print(f"Wrote report: {rep}")

    if args.dry_run:
        for ins in to_insert[:50]:
            print(f"  would insert raid_id={ins['raid_id']} event_id={ins['event_id']} "
                  f"item={ins['item_name']!r} cost={ins['cost']}")
        if len(to_insert) > 50:
            print(f"  ... and {len(to_insert) - 50} more")
        return 0

    if not to_insert:
        print("Nothing to insert.")
        if not args.no_refresh and args.apply:
            print("Calling refresh_account_dkp_summary() anyway (no new rows)...")
            try:
                client.rpc("refresh_account_dkp_summary").execute()
            except Exception as e:
                print(f"Warning: refresh_account_dkp_summary: {e}", file=sys.stderr)
        return 0

    for i in range(0, len(to_insert), INSERT_BATCH):
        chunk = to_insert[i : i + INSERT_BATCH]
        client.table("raid_loot").insert(chunk).execute()
    print(f"Inserted {len(to_insert)} raid_loot row(s).")

    if not args.no_refresh:
        print("Calling refresh_account_dkp_summary()...")
        try:
            client.rpc("refresh_account_dkp_summary").execute()
            print("refresh_account_dkp_summary() completed.")
        except Exception as e:
            print(f"ERROR: refresh_account_dkp_summary failed: {e}", file=sys.stderr)
            return 3
        if args.also_refresh_dkp_summary:
            print("Calling refresh_dkp_summary()...")
            try:
                client.rpc("refresh_dkp_summary").execute()
                print("refresh_dkp_summary() completed.")
            except Exception as e:
                print(f"Warning: refresh_dkp_summary failed: {e}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())

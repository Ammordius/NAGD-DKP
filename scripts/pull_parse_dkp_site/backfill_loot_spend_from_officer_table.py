#!/usr/bin/env python3
"""
Backfill missing raid_loot rows from an officer spreadsheet export (TSV/CSV).

Expected columns (header row, case-insensitive): Item, Spent, Date, Raid Name, Event
Optional: raid_id — when set, skips fuzzy raid matching for that row.

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
    c_date = col("date")
    c_raid_name = col("raid name", "raid_name")
    c_event = col("event")
    c_raid_id = col("raid_id", "raid id")
    missing = [x for x, v in [
        ("Item", c_item), ("Spent", c_spent), ("Date", c_date),
        ("Raid Name", c_raid_name), ("Event", c_event),
    ] if not v]
    if missing:
        raise SystemExit(f"Missing required columns: {', '.join(missing)}. Found: {reader.fieldnames}")

    rows: list[ParsedRow] = []
    for i, rec in enumerate(reader, start=2):
        assert c_item and c_spent and c_date and c_raid_name and c_event
        item = strip_item_brackets((rec.get(c_item) or "").strip())
        spent = str((rec.get(c_spent) or "").strip())
        date_raw = (rec.get(c_date) or "").strip()
        raid_name = (rec.get(c_raid_name) or "").strip()
        event = (rec.get(c_event) or "").strip()
        rid_ov = ""
        if c_raid_id:
            rid_ov = (rec.get(c_raid_id) or "").strip()
        rows.append(
            ParsedRow(
                line_no=i,
                item=item,
                spent=spent,
                date_raw=date_raw,
                raid_name=raid_name,
                event=event,
                raid_id_override=rid_ov,
            )
        )
    return rows


def pick_best_raid(
    row: ParsedRow,
    row_date: date,
    raids_by_id: dict[str, dict],
    min_score: float,
) -> tuple[str | None, float, list[tuple[str, float, str]]]:
    """Returns (raid_id or None, best_score, top candidates for logging)."""
    if row.raid_id_override:
        rid = row.raid_id_override.strip()
        if rid not in raids_by_id:
            return None, 0.0, []
        r = raids_by_id[rid]
        d = raid_date_from_iso(r.get("date_iso"))
        score = score_similar(row.raid_name, r.get("raid_name") or "")
        if d != row_date:
            print(
                f"  line {row.line_no}: WARN raid_id override {rid}: DB date_iso={r.get('date_iso')!r} "
                f"!= row date {row_date}; using override anyway",
                file=sys.stderr,
            )
        return rid, score, [(rid, score, r.get("raid_name") or "")]

    scored: list[tuple[str, float, str]] = []
    for rid, r in raids_by_id.items():
        d = raid_date_from_iso(r.get("date_iso"))
        if d != row_date:
            continue
        name = r.get("raid_name") or ""
        sc = score_similar(row.raid_name, name)
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
    ap.add_argument("--min-raid-score", type=float, default=DEFAULT_MIN_RAID_SCORE)
    ap.add_argument("--min-event-score", type=float, default=DEFAULT_MIN_EVENT_SCORE)
    ap.add_argument("--report", type=Path, default=None, help="Write unresolved/problem rows as TSV here")
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

    all_events = fetch_all(client, "raid_events", "raid_id, event_id, event_name")
    events_by_raid: dict[str, list[dict]] = {}
    for ev in all_events:
        rid = str(ev.get("raid_id") or "").strip()
        events_by_raid.setdefault(rid, []).append(ev)

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

    for row in parsed_rows:
        rd = parse_row_date(row.date_raw)
        if not rd:
            stats["bad_date"] += 1
            report_lines.append([
                str(row.line_no), row.item, row.spent, row.date_raw, row.raid_name, row.event,
                row.raid_id_override, "bad_date",
            ])
            continue

        rid, rscore, candidates = pick_best_raid(row, rd, raids_by_id, args.min_raid_score)
        if not rid:
            stats["unresolved_raid"] += 1
            cand_str = "; ".join(f"{c[0]}({c[1]:.2f}:{c[2][:40]})" for c in candidates[:3])
            report_lines.append([
                str(row.line_no), row.item, row.spent, row.date_raw, row.raid_name, row.event,
                row.raid_id_override, f"unresolved_raid:{cand_str}",
            ])
            continue

        eid, escore, enote = pick_event_id(
            rid, row.event, events_by_raid, args.min_event_score,
        )
        if not eid:
            stats["unresolved_event"] += 1
            report_lines.append([
                str(row.line_no), row.item, row.spent, row.date_raw, row.raid_name, row.event,
                row.raid_id_override, f"unresolved_event:{enote}:{escore:.2f}",
            ])
            continue
        if enote == "fallback_single_event":
            print(
                f"  line {row.line_no}: WARN event fuzzy low ({escore:.2f}); "
                f"using single event_id={eid} for raid {rid}",
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
                existing_keys.add(
                    loot_dedupe_key(
                        str(lr.get("raid_id") or ""),
                        str(lr.get("event_id") or ""),
                        str(lr.get("item_name") or ""),
                        buyer_name,
                        str(lr.get("cost") or ""),
                    )
                )

    to_insert: list[dict[str, Any]] = []
    for r in resolved:
        key = loot_dedupe_key(r.raid_id, r.event_id, r.item_name, buyer_name, r.cost)
        if key in existing_keys:
            stats["duplicate"] += 1
            continue
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

    print(
        f"Parsed={stats['parsed']} bad_date={stats['bad_date']} "
        f"unresolved_raid={stats['unresolved_raid']} unresolved_event={stats['unresolved_event']} "
        f"duplicate={stats['duplicate']} to_insert={stats['to_insert']}"
    )

    if args.report and report_lines:
        rep = args.report
        rep.parent.mkdir(parents=True, exist_ok=True)
        with rep.open("w", encoding="utf-8", newline="") as f:
            w = csv.writer(f, delimiter="\t")
            w.writerow([
                "line_no", "item", "spent", "date", "raid_name", "event", "raid_id_override", "reason",
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

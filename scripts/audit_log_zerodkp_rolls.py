#!/usr/bin/env python3
"""
Log audit tool: find 0 DKP and DKP loot in EQ chat logs and match to raids by overlap.

Reads .txt/.log files in log directory(ies), parses "says out of character" and
"tells Nag:1" / "tells Nagd:1" loot messages. Extracts both 0 DKP roll awards (top roll,
no bids, high roll 0 dkp, grats X w/ N roll) and positive DKP awards (grats X N dkp).
Matches log dates to raids by comparing parsed loot (0 + DKP) to existing raid_loot:
for each log date, candidates are raids within ±max_days; the raid with the most
(item, character) matches in raid_loot is chosen (one-to-one with known good data).
Fuzzy-matches winner names to characters; excludes 0 DKP rows already in raid_loot.
Outputs JSON: generated_for_upload (0 DKP to add), audit, all_parsed_loot (0 + DKP),
and raid_match_quality (overlap counts per date).

Usage:
  python scripts/audit_log_zerodkp_rolls.py [--logs DIR] [--data DIR] [--out FILE] [--max-days N] [--characters A,B,C] [--verbose]
  Default logs dir: ./logs (or data/logs if present)
  Default data dir: ./data
  Output: writes audit_zerodkp_rolls.json (or --out path)
  Raid matching: same-day raid by date_iso; if none, nearest raid within --max-days (default 1).
  If --characters is set, only scan eqlog_{name}_loginse.txt for those names (e.g. TAKPv22 logs).
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import defaultdict
from datetime import datetime
from difflib import get_close_matches
from pathlib import Path


# ---- Log line format: [Mon Feb 09 21:24:35 2026] Speaker says out of character, 'message'
# Also: [timestamp] Speaker tells Nag:1, 'message' or tells Nagd:1, 'message' (raid /tells)
LOG_LINE_OOC = re.compile(
    r"^\[([^\]]+)\]\s+\w+\s+says\s+out\s+of\s+character\s*,\s*'([^']*)'",
    re.IGNORECASE,
)
LOG_LINE_TELL = re.compile(
    r"^\[([^\]]+)\]\s+(\w+)\s+tells\s+\S+\s*,\s*'([^']*)'",
    re.IGNORECASE,
)
# Sender of a tell is the loot master; never treat them as the winner. Also skip parser false-hits.
WINNER_BLACKLIST = frozenset({"congrats", "grats", "you"})
LOG_DATE_FMT = "%a %b %d %H:%M:%S %Y"  # Mon Feb 09 21:24:35 2026


def parse_log_timestamp(ts_str: str) -> str | None:
    """Return YYYY-MM-DD or None."""
    try:
        dt = datetime.strptime(ts_str.strip(), LOG_DATE_FMT)
        return dt.strftime("%Y-%m-%d")
    except ValueError:
        return None


def load_characters(data_dir: Path) -> list[dict]:
    """Load characters.csv; return list of { char_id, name }."""
    path = data_dir / "characters.csv"
    if not path.exists():
        return []
    out = []
    with open(path, encoding="utf-8", newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            name = (row.get("name") or "").strip()
            if name:
                out.append({"char_id": (row.get("char_id") or "").strip(), "name": name})
    return out


def load_raids(data_dir: Path) -> list[dict]:
    """Load raids.csv; return list of { raid_id, date_iso, raid_name }."""
    path = data_dir / "raids.csv"
    if not path.exists():
        return []
    out = []
    with open(path, encoding="utf-8", newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            date_iso = (row.get("date_iso") or "").strip()
            if date_iso and len(date_iso) >= 10:
                out.append({
                    "raid_id": (row.get("raid_id") or "").strip(),
                    "date_iso": date_iso[:10],
                    "raid_name": (row.get("raid_name") or "").strip(),
                })
    return out


def load_raid_loot(data_dir: Path) -> set[tuple[str, str, str]]:
    """Load raid_loot.csv; return set of (raid_id, item_name normalized, character_name normalized)."""
    path = data_dir / "raid_loot.csv"
    if not path.exists():
        return set()
    out = set()
    with open(path, encoding="utf-8", newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            raid_id = (row.get("raid_id") or "").strip()
            item = (row.get("item_name") or "").strip().lower()
            char = (row.get("character_name") or "").strip().lower()
            if raid_id and item:
                out.add((raid_id, item, char))
    return out


def load_item_names(data_dir: Path) -> list[str]:
    """Build sorted-by-length (longest first) list of known item names from dkp_mob_loot + raid_loot."""
    names = set()

    # dkp_mob_loot.json
    path = data_dir / "dkp_mob_loot.json"
    if path.exists():
        with open(path, encoding="utf-8") as f:
            obj = json.load(f)
        for mob_data in (obj or {}).values():
            if isinstance(mob_data, dict) and "loot" in mob_data:
                for entry in mob_data["loot"]:
                    if isinstance(entry, dict) and entry.get("name"):
                        names.add(entry["name"].strip())

    # raid_loot.csv
    path = data_dir / "raid_loot.csv"
    if path.exists():
        with open(path, encoding="utf-8", newline="") as f:
            r = csv.DictReader(f)
            for row in r:
                n = (row.get("item_name") or "").strip()
                if n and not (n.startswith("(item ") and n.endswith(")")):
                    names.add(n)

    return sorted(names, key=len, reverse=True)


def best_item_match(text: str, item_names: list[str]) -> str | None:
    """Find longest item name that appears in text (case-insensitive)."""
    lower = text.lower()
    for name in item_names:
        if name and name.lower() in lower:
            return name
    return None


def is_likely_item_name(name: str, item_names: list[str]) -> bool:
    """True if name is a known item or normalizable to one; False if it looks like chat phrase."""
    if not name or len(name) > 120:
        return False
    lower = name.lower()
    # Drop lines where we accidentally captured a phrase instead of item
    for phrase in ("congrats", "grats", "top roll", "loot on correct char", "no bids", "other with the high"):
        if phrase in lower:
            return False
    # Exact match (case-insensitive) to known item
    for n in item_names:
        if n and n.lower() == lower:
            return True
    # Longest substring match: if something in item_names appears in name, treat as item
    for n in item_names:
        if n and len(n) >= 4 and n.lower() in lower:
            return True
    return True  # allow unknown item names that don't look like phrases


def normalize_item_name(name: str, item_names: list[str]) -> str:
    """Return canonical item name from list if we have a case-insensitive match; else name."""
    if not name:
        return name
    lower = name.lower()
    for n in item_names:
        if n and n.lower() == lower:
            return n
    return name


def fuzzy_match_character(log_name: str, characters: list[dict], cutoff: float = 0.5) -> dict | None:
    """Return best matching character { char_id, name } or None."""
    log_clean = log_name.strip()
    if not log_clean:
        return None
    char_names = [c["name"] for c in characters]
    # Prefer exact match (case-insensitive)
    for c in characters:
        if c["name"].lower() == log_clean.lower():
            return c
    # Then prefix: log "TAPPYAMMO" might be abbrev for "Tappyammo"
    for c in characters:
        if c["name"].lower().startswith(log_clean.lower()) or log_clean.lower().startswith(c["name"].lower()):
            return c
    # Fuzzy
    matches = get_close_matches(log_clean, char_names, n=1, cutoff=cutoff)
    if not matches:
        return None
    name = matches[0]
    for c in characters:
        if c["name"] == name:
            return c
    return None


def _item_candidates_from_message(msg: str) -> list[str]:
    """Extract possible item name(s) from message (text before grats/congrats/no bids/tie, or first segment)."""
    lower = msg.lower()
    item_candidates = []
    for sep in [" grats ", " congrats ", " no bids", " tie"]:
        idx = lower.find(sep)
        if idx > 0:
            head = msg[:idx].strip()
            if head:
                item_candidates.append(head.strip())
    if not item_candidates and lower.startswith("no bids "):
        first_part = msg.split(",")[0].strip() if "," in msg else msg
        item_candidates.append(re.sub(r"^no\s+bids\s+", "", first_part, flags=re.IGNORECASE).strip())
    if not item_candidates and " no bids" in lower:
        idx = lower.find(" no bids")
        if idx > 0:
            item_candidates.append(msg[:idx].strip())
    if not item_candidates:
        head = msg.split(",")[0].strip() if "," in msg else msg
        if head:
            item_candidates.append(head)
    return item_candidates


def parse_dkp_awards(line_message: str, log_date: str) -> list[dict]:
    """
    Parse a single log message for positive-DKP loot awards.
    Returns list of { item_name_placeholder, winner_log_name, cost (int), log_date }.
    E.g. "Item grats X 5 dkp", "Item 5 DKP grats X", "Item Grats A 9 dkp , and Grats B 8dkp".
    """
    msg = line_message.strip()
    if not msg:
        return []
    lower = msg.lower()
    if "grats" not in lower and "congrats" not in lower:
        return []
    dkp_match = re.search(r"(\d+)\s*dkp", lower)
    if not dkp_match or int(dkp_match.group(1)) == 0:
        return []
    item_candidates = _item_candidates_from_message(msg)
    results = []
    # "grats X N dkp" or "congrats X N dkp" (winner then cost)
    for m in re.finditer(r"(?:congrats|grats)\s+([A-Za-z0-9]+)\s+(\d+)\s*dkp", msg, re.IGNORECASE):
        winner, cost_str = m.group(1).strip(), m.group(2)
        cost = int(cost_str)
        if cost > 0:
            results.append({
                "item_name_placeholder": item_candidates[0] if item_candidates else "",
                "winner_log_name": winner,
                "cost": cost,
                "log_date": log_date,
            })
    # "N dkp ... grats X" or "N DKP grats X"
    if not results:
        for m in re.finditer(r"(\d+)\s*dkp\s*[,!.]?\s*(?:and\s+)?(?:congrats|grats)\s+([A-Za-z0-9]+)", msg, re.IGNORECASE):
            cost, winner = int(m.group(1)), m.group(2).strip()
            if cost > 0:
                results.append({
                    "item_name_placeholder": item_candidates[0] if item_candidates else "",
                    "winner_log_name": winner,
                    "cost": cost,
                    "log_date": log_date,
                })
    # Single "Item N DKP grats X" pattern
    if not results:
        single = re.search(r"(\d+)\s*dkp\s*(?:congrats|grats)\s+([A-Za-z0-9]+)", msg, re.IGNORECASE)
        if single:
            cost, winner = int(single.group(1)), single.group(2).strip()
            if cost > 0:
                results.append({
                    "item_name_placeholder": item_candidates[0] if item_candidates else "",
                    "winner_log_name": winner,
                    "cost": cost,
                    "log_date": log_date,
                })
    return results


def parse_zerodkp_roll_awards(line_message: str, log_date: str) -> list[dict]:
    """
    Parse a single log message; return list of { item_name, winner_log_name, log_date } for 0 DKP roll awards only.
    Skips: positive DKP awards, "anyone beat X/Y" (roll in progress), tie-only lines (no actual award).
    """
    msg = line_message.strip()
    if not msg:
        return []
    lower = msg.lower()
    results = []

    # Skip roll-in-progress lines (no grats/congrats and has "anyone beat" / "beat X/Y")
    if "anyone beat" in lower and "grats" not in lower and "congrats" not in lower:
        return []
    if re.search(r"\d+\s*/\s*\d+\s*(?:raud\s+)?roll\s+on\s+", lower) and "grats" not in lower and "congrats" not in lower:
        return []

    # Skip lines that are only "N DKP" awards (no "0 dkp" / "top roll" / "no bids" / "high roll")
    has_zerodkp_indicator = (
        "top roll" in lower
        or "top rolls" in lower
        or re.search(r"top\s+\d*\s*rolls?", lower)
        or "no bids" in lower
        or ("high roll" in lower and "0 dkp" in lower)
        or ("0 dkp" in lower)
    )
    # If line has a positive DKP number and no 0 DKP / roll wording, skip entire line (single award)
    if not has_zerodkp_indicator:
        dkp_match = re.search(r"(\d+)\s*dkp", lower)
        if dkp_match and int(dkp_match.group(1)) > 0:
            return []
    # Tie-only line: "X DKP, tie... Jasie and Y" with no "grats X" for winner — skip; the next line awards
    if "tie" in lower and "grats" not in lower and "congrats" not in lower:
        return []

    item_candidates = _item_candidates_from_message(msg)

    # ---- Extract winner(s) ----
    winners = []

    # "no bids, Slay and Tolsarian top rolls, grats!"
    no_bids = re.search(
        r"no\s+bids\s*,\s*([^.!]+?)\s+top\s+rolls?\s*[,!.]",
        msg,
        re.IGNORECASE | re.DOTALL,
    )
    if no_bids:
        names_part = no_bids.group(1).strip()
        for part in re.split(r"\s+and\s+|\s*,\s*", names_part, flags=re.IGNORECASE):
            w = part.strip()
            if len(w) > 1 and w not in ("no", "bids"):
                winners.append((w, msg))

    # "Girdle... congrats cicatriz and tracka top rolls, no bids" (no bids at end)
    if not winners:
        congrats_two = re.search(
            r"(?:congrats|grats)\s+([A-Za-z0-9]+(?:\s+and\s+[A-Za-z0-9]+)?)\s+.*?top\s+rolls?\s*(?:[,!.]|\s|$)",
            msg,
            re.IGNORECASE | re.DOTALL,
        )
        if congrats_two:
            part = congrats_two.group(1).strip()
            for name in re.split(r"\s+and\s+", part, flags=re.IGNORECASE):
                w = name.strip()
                if w:
                    winners.append((w, msg))

    # "no bids Mask of Conceptual Energy, slay top roll" -> winner "slay"
    if not winners:
        no_bids_item_winner = re.search(
            r"no\s+bids\s+[^,]+,?\s*([A-Za-z0-9]+)\s+top\s+roll",
            msg,
            re.IGNORECASE,
        )
        if no_bids_item_winner:
            winners.append((no_bids_item_winner.group(1).strip(), msg))

    # "Mask of Conceptual Energy no bids, jarisy diox top 2 rolls?" -> two winners
    if not winners:
        no_bids_then_names = re.search(
            r"no\s+bids\s*,\s*([^.?]+?)\s+top\s+\d*\s*rolls?\s*[?!.]?",
            msg,
            re.IGNORECASE,
        )
        if no_bids_then_names:
            names_part = no_bids_then_names.group(1).strip()
            for part in re.split(r"\s+and\s+|\s*,\s*", names_part, flags=re.IGNORECASE):
                w = part.strip()
                if len(w) > 1 and w not in ("no", "bids"):
                    winners.append((w, msg))

    # "congrats X top roll" / "grats X top roll, loot on correct char" — only roll-related (skip "grats X, 2 DKP")
    if not winners:
        grats = re.findall(
            r"(?:congrats|grats)\s+([A-Za-z0-9]+)\s+.*?top\s+roll",
            msg,
            re.IGNORECASE | re.DOTALL,
        )
        for w in grats:
            winners.append((w.strip(), msg))

    # "Headcrushar other with the high roll 0 dkp" — name immediately before "other with"
    high_roll = re.search(
        r"([A-Za-z0-9]+)\s+other\s+with\s+the\s+high\s+roll\s+0\s*dkp",
        msg,
        re.IGNORECASE,
    )
    if high_roll:
        w = high_roll.group(1).strip()
        if w and (w, msg) not in [(x, _) for x, _ in winners]:
            winners.append((w, msg))

    # "X and Y top rolls" — allow trailing comma/period or space (e.g. "top rolls Girdle of...")
    if not winners:
        top_rolls = re.search(
            r"([A-Za-z0-9]+(?:\s+and\s+[A-Za-z0-9]+)?)\s+top\s+rolls?\s*(?:[,!.]|\s|$)",
            msg,
            re.IGNORECASE,
        )
        if top_rolls:
            part = top_rolls.group(1).strip()
            for name in re.split(r"\s+and\s+", part, flags=re.IGNORECASE):
                w = name.strip()
                if w:
                    winners.append((w, msg))

    # "grats dullwin with a 176 roll Ring of Force"
    if not winners:
        grats_with_roll = re.search(
            r"(?:congrats|grats)\s+([A-Za-z0-9]+)\s+with\s+a\s+\d+\s+roll",
            msg,
            re.IGNORECASE,
        )
        if grats_with_roll:
            winners.append((grats_with_roll.group(1).strip(), msg))

    # "No bids - Grats YUUKII w/ 423/999 (fire)" or "Grats X w/ N/N"
    if not winners:
        grats_w_slash = re.search(
            r"(?:congrats|grats)\s+([A-Za-z0-9]+)\s+w/\s*\d+",
            msg,
            re.IGNORECASE,
        )
        if grats_w_slash:
            winners.append((grats_w_slash.group(1).strip(), msg))

    if not winners:
        return []

    # One entry per winner; item name will be filled by caller using item list
    for win_name, _ in winners:
        # Use first candidate as placeholder; caller replaces with best_item_match
        item_placeholder = item_candidates[0] if item_candidates else ""
        results.append({
            "item_name_placeholder": item_placeholder,
            "winner_log_name": win_name,
            "log_date": log_date,
        })
    return results


def find_raid_for_date(log_date: str, raids: list[dict]) -> dict | None:
    """Return raid with date_iso equal to log_date (YYYY-MM-DD); if multiple, first by raid_id."""
    for r in raids:
        if r.get("date_iso") == log_date:
            return r
    return None


def find_raids_near_date(log_date: str, raids: list[dict], max_days: int = 1) -> list[dict]:
    """Return raids within max_days of log_date, sorted by date proximity (then raid_id)."""
    try:
        log_dt = datetime.strptime(log_date, "%Y-%m-%d")
    except ValueError:
        return []
    out = []
    for r in raids:
        try:
            raid_dt = datetime.strptime(r["date_iso"], "%Y-%m-%d")
        except (ValueError, KeyError):
            continue
        delta = abs((log_dt - raid_dt).days)
        if delta <= max_days:
            out.append((delta, r))
    out.sort(key=lambda x: (x[0], x[1]["raid_id"]))
    return [r for _, r in out]


def build_raid_loot_by_raid(existing_loot: set[tuple[str, str, str]]) -> dict[str, set[tuple[str, str]]]:
    """From (raid_id, item_lower, char_lower) set, return raid_id -> set of (item_lower, char_lower)."""
    by_raid: dict[str, set[tuple[str, str]]] = {}
    for raid_id, item, char in existing_loot:
        by_raid.setdefault(raid_id, set()).add((item, char))
    return by_raid


def find_best_raid_for_date(
    log_date: str,
    entries_for_date: list[dict],
    raids: list[dict],
    raid_loot_by_raid: dict[str, set[tuple[str, str]]],
    max_days: int = 1,
) -> tuple[dict | None, int]:
    """
    Pick the raid that best matches parsed loot for this log_date.
    entries_for_date: list of { item_name, character_name (resolved) }; raid_loot_by_raid from build_raid_loot_by_raid.
    Returns (best_raid, overlap_count). Uses same-day and ±max_days; scores by number of (item, char) matches in raid_loot.
    """
    candidates = find_raids_near_date(log_date, raids, max_days=max_days)
    if not candidates:
        return None, 0
    keys_for_date = [(e["item_name"].lower(), e["character_name"].lower()) for e in entries_for_date]
    best_raid = None
    best_score = -1
    for raid in candidates:
        raid_id = raid["raid_id"]
        loot_set = raid_loot_by_raid.get(raid_id) or set()
        score = sum(1 for k in keys_for_date if k in loot_set)
        same_day = 1 if raid.get("date_iso") == log_date else 0
        if score > best_score or (score == best_score and same_day and (not best_raid or best_raid.get("date_iso") != log_date)):
            best_score = score
            best_raid = raid
    return best_raid, best_score


def _is_valid_winner(winner_log_name: str, sender: str | None) -> bool:
    """Exclude the message sender (loot master) and non-name words from being treated as winner."""
    if not winner_log_name or not winner_log_name.strip():
        return False
    low = winner_log_name.strip().lower()
    if low in WINNER_BLACKLIST:
        return False
    if sender and low == sender.lower():
        return False
    return True


def scan_log_file(path: Path, item_names: list[str]) -> list[dict]:
    """Return list of { log_date, item_name, winner_log_name, cost (int), raw_line } for all loot (0 DKP roll + DKP)."""
    entries = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.rstrip("\n\r")
            m = LOG_LINE_TELL.match(line)
            if m:
                ts_str, sender, quoted = m.group(1), m.group(2), m.group(3)
            else:
                m = LOG_LINE_OOC.match(line)
                if not m:
                    continue
                ts_str, quoted = m.group(1), m.group(2)
                sender = None
            log_date = parse_log_timestamp(ts_str)
            if not log_date:
                continue
            # 0 DKP roll awards
            for a in parse_zerodkp_roll_awards(quoted, log_date):
                if not _is_valid_winner(a["winner_log_name"], sender):
                    continue
                text = a["item_name_placeholder"] + " " + quoted
                item_name = best_item_match(text, item_names)
                if not item_name:
                    item_name = a["item_name_placeholder"] or "Unknown"
                entries.append({
                    "log_date": log_date,
                    "item_name": item_name,
                    "winner_log_name": a["winner_log_name"],
                    "cost": 0,
                    "raw_line": line,
                })
            # Positive DKP awards
            for a in parse_dkp_awards(quoted, log_date):
                if not _is_valid_winner(a["winner_log_name"], sender):
                    continue
                text = a["item_name_placeholder"] + " " + quoted
                item_name = best_item_match(text, item_names)
                if not item_name:
                    item_name = a["item_name_placeholder"] or "Unknown"
                entries.append({
                    "log_date": log_date,
                    "item_name": item_name,
                    "winner_log_name": a["winner_log_name"],
                    "cost": a["cost"],
                    "raw_line": line,
                })
    return entries


def _log_stem_to_character_name(stem: str) -> str | None:
    """Extract character name from log file stem. Returns None if not an eqlog_*_loginse* file."""
    s = stem.lower()
    if not s.startswith("eqlog_"):
        return None
    # eqlog_ammomage_loginse or eqlog_ammomage_loginse_20250104_150610
    if "_loginse" not in s:
        return None
    mid = s[6 : s.index("_loginse")]
    return mid if mid else None


def main() -> None:
    ap = argparse.ArgumentParser(description="Audit logs for 0 DKP roll loot; output JSON for upload.")
    ap.add_argument("--logs", type=Path, action="append", default=None, help="Directory/directories containing .txt/.log files (repeat for multiple, e.g. TAKPv22 and rotated EQ)")
    ap.add_argument("--data", type=Path, default=None, help="Data directory (characters, raids, raid_loot, dkp_mob_loot)")
    ap.add_argument("--out", type=Path, default=None, help="Output JSON path")
    ap.add_argument("--max-days", type=int, default=1, help="If no same-day raid, match raid within this many days (default 1)")
    ap.add_argument("--characters", type=str, default=None, help="Comma-separated character names; only scan eqlog_{name}_loginse*.txt (case-insensitive)")
    ap.add_argument("--all-logs", action="store_true", help="Scan all eqlog_*_loginse* files in log dir(s), not just --characters")
    ap.add_argument("--verbose", action="store_true", help="Print parsed lines and matches")
    args = ap.parse_args()

    root = Path(__file__).resolve().parent.parent
    data_dir = (args.data or root / "data").resolve()
    if not data_dir.is_dir():
        print(f"Data directory not found: {data_dir}")
        return

    logs_dirs = args.logs
    if not logs_dirs:
        for d in (root / "logs", root / "data" / "logs", root / "log"):
            if d.is_dir():
                logs_dirs = [d]
                break
        if not logs_dirs:
            logs_dirs = [root / "logs"]
    logs_dirs = [Path(d).resolve() for d in logs_dirs]
    for d in logs_dirs:
        if not d.is_dir():
            print(f"Logs directory not found: {d}. Skipping.")
    logs_dirs = [d for d in logs_dirs if d.is_dir()]
    if not logs_dirs:
        print("No valid log directories. Create a logs folder and add EQ log files.")
        return

    out_path = args.out or root / "audit_zerodkp_rolls.json"

    characters = load_characters(data_dir)
    raids = load_raids(data_dir)
    existing_loot = load_raid_loot(data_dir)
    item_names = load_item_names(data_dir)

    # Collect log files from all directories: eqlog_{name}_loginse.txt and eqlog_{name}_loginse_*.txt (rotated)
    all_txt = []
    for logs_dir in logs_dirs:
        all_txt.extend(logs_dir.glob("*.txt"))
        all_txt.extend(logs_dir.glob("*.log"))
    if args.all_logs:
        # Scan any file that looks like eqlog_*_loginse*
        log_files = []
        seen_path = set()
        for path in all_txt:
            path_key = (path.resolve(), path.name)
            if path_key in seen_path:
                continue
            if _log_stem_to_character_name(path.stem) is not None:
                seen_path.add(path_key)
                log_files.append(path)
        log_files.sort(key=lambda p: (p.parent, p.name.lower()))
    elif args.characters:
        want_names = {n.strip().lower() for n in args.characters.split(",") if n.strip()}
        log_files = []
        seen_path = set()
        for path in all_txt:
            path_key = (path.resolve(), path.name)
            if path_key in seen_path:
                continue
            name = _log_stem_to_character_name(path.stem)
            if name is not None and name in want_names:
                seen_path.add(path_key)
                log_files.append(path)
        log_files.sort(key=lambda p: (p.parent, p.name.lower()))
    else:
        log_files = sorted(set(all_txt), key=lambda p: (p.parent, p.name.lower()))

    if args.verbose or args.characters:
        print(f"Scanning {len(log_files)} log file(s) in {len(logs_dirs)} directory(ies)")
        for p in log_files:
            print(f"  {p.parent.name}/{p.name}")

    # Collect all 0 DKP roll entries from logs
    all_entries = []
    for path in log_files:
        entries = scan_log_file(path, item_names)
        all_entries.extend(entries)

    # Dedupe by identical log line (timestamp + message) so same line in multiple toons' logs counts once
    seen_line = set()
    deduped_entries = []
    for e in all_entries:
        key = e["raw_line"]
        if key in seen_line:
            continue
        seen_line.add(key)
        deduped_entries.append(e)
    all_entries = deduped_entries

    # Build (raid_id, item_lower, char_name_lower) for existing loot and per-raid set for overlap scoring
    existing_triples = existing_loot
    raid_loot_by_raid = build_raid_loot_by_raid(existing_loot)

    # Resolve character for every entry (so we can score raids by loot overlap)
    for e in all_entries:
        char = fuzzy_match_character(e["winner_log_name"], characters)
        e["character_name"] = char["name"] if char else None
        e["char_id"] = char["char_id"] if char else None

    # Group by log_date and pick best raid per date by overlap with existing raid_loot (±max_days)
    by_date: dict[str, list[dict]] = defaultdict(list)
    for e in all_entries:
        by_date[e["log_date"]].append(e)

    date_to_raid: dict[str, dict] = {}
    raid_match_quality: list[dict] = []
    for log_date, date_entries in by_date.items():
        entries_with_char = [x for x in date_entries if x.get("character_name")]
        if entries_with_char:
            best_raid, overlap = find_best_raid_for_date(
                log_date, entries_with_char, raids, raid_loot_by_raid, max_days=args.max_days
            )
            date_to_raid[log_date] = best_raid
            raid_match_quality.append({
                "log_date": log_date,
                "raid_id": best_raid["raid_id"] if best_raid else None,
                "raid_date_iso": best_raid.get("date_iso") if best_raid else None,
                "overlap_with_raid_loot": overlap,
                "parsed_loot_count": len(entries_with_char),
            })
        else:
            # No resolved characters for this date; fall back to same-day or nearest
            best_raid = find_raid_for_date(log_date, raids)
            if not best_raid:
                near = find_raids_near_date(log_date, raids, max_days=args.max_days)
                best_raid = near[0] if near else None
            date_to_raid[log_date] = best_raid
            raid_match_quality.append({
                "log_date": log_date,
                "raid_id": best_raid["raid_id"] if best_raid else None,
                "raid_date_iso": best_raid.get("date_iso") if best_raid else None,
                "overlap_with_raid_loot": 0,
                "parsed_loot_count": 0,
            })

    # Assign raid to each entry; build upload (0 DKP only, not already in raid_loot) and all_parsed_loot
    upload = []
    all_parsed_loot = []
    for e in all_entries:
        log_date = e["log_date"]
        item_name = e["item_name"]
        winner_log = e["winner_log_name"]
        cost = e["cost"]
        raid = date_to_raid.get(log_date)
        char_name = e.get("character_name")

        if raid:
            all_parsed_loot.append({
                "log_date": log_date,
                "raid_id": raid["raid_id"],
                "raid_date_iso": raid.get("date_iso"),
                "item_name": item_name,
                "character_name": char_name,
                "cost": cost,
            })

        if cost != 0:
            continue
        char_id = e.get("char_id")
        if not char_name:
            if args.verbose:
                print(f"  No character match for '{winner_log}' (item={item_name}, date={log_date})")
            continue
        if not raid:
            if args.verbose:
                print(f"  No raid for date {log_date} (item={item_name}, winner={winner_log})")
            continue

        key = (raid["raid_id"], item_name.lower(), char_name.lower())
        if key in existing_triples:
            if args.verbose:
                print(f"  Already in raid_loot: {raid['raid_id']} / {item_name} / {char_name}")
            continue

        if not is_likely_item_name(item_name, item_names):
            if args.verbose:
                print(f"  Skipping phrase-as-item: {item_name!r}")
            continue
        item_name = normalize_item_name(item_name, item_names)

        upload.append({
            "raid_id": raid["raid_id"],
            "event_id": None,
            "item_name": item_name,
            "char_id": char_id,
            "character_name": char_name,
            "cost": "0",
            "source_log_date": log_date,
            "source_log_winner_raw": winner_log,
        })

    # Dedupe by (raid_id, item_name, char_id) keeping first
    seen = set()
    deduped = []
    for u in upload:
        k = (u["raid_id"], u["item_name"].lower(), (u["char_id"] or u["character_name"] or "").lower())
        if k in seen:
            continue
        seen.add(k)
        deduped.append(u)

    result = {
        "generated_for_upload": [
            {
                "raid_id": u["raid_id"],
                "event_id": u["event_id"],
                "item_name": u["item_name"],
                "char_id": u["char_id"],
                "character_name": u["character_name"],
                "cost": u["cost"],
            }
            for u in deduped
        ],
        "audit": [
            {
                "raid_id": u["raid_id"],
                "item_name": u["item_name"],
                "character_name": u["character_name"],
                "cost": u["cost"],
                "source_log_date": u.get("source_log_date"),
                "source_log_winner_raw": u.get("source_log_winner_raw"),
            }
            for u in deduped
        ],
        "all_parsed_loot": all_parsed_loot,
        "raid_match_quality": raid_match_quality,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)

    n_zerodkp = sum(1 for e in all_entries if e.get("cost") == 0)
    n_dkp = len(all_entries) - n_zerodkp
    print(f"Scanned {len(log_files)} log file(s); {len(all_entries)} unique loot lines ({n_zerodkp} 0 DKP, {n_dkp} DKP); {len(deduped)} 0 DKP to add (not already in raid_loot).")
    print(f"Output: {out_path}")
    print("Use 'generated_for_upload' to insert into raid_loot (e.g. via Officer UI or Supabase).")


if __name__ == "__main__":
    main()

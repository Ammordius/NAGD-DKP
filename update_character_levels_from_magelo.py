#!/usr/bin/env python3
"""
Update character level and class_name in Supabase from the Magelo TAKP_character.txt export.
Only updates characters that have a one-to-one name match: the name must appear exactly once
in the Magelo file and exactly once in our characters table. Level is updated even if it
already exists (always overwrite with Magelo data for matched names).

Used by the loot-to-character CI after assigning loot; runs when Magelo dumps are available.

Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY if RLS allows).
  python update_character_levels_from_magelo.py --character-file .magelo_dump/TAKP_character.txt
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from collections import defaultdict

SCRIPT_DIR = Path(__file__).resolve().parent

# TAKP_character.txt header: name last_name guild_name level race class deity gender id ...
# Index: 0=name, 3=level, 5=class, 8=id
MAGELO_NAME_IDX = 0
MAGELO_LEVEL_IDX = 3
MAGELO_CLASS_IDX = 5
MAGELO_ID_IDX = 8
MAGELO_MIN_PARTS = 9


def load_magelo_levels_by_name(char_file: Path) -> dict[str, tuple[str, str]]:
    """
    Read Magelo character file. Return name -> (level, class) only for names
    that appear exactly once in the file (one-to-one).
    """
    name_to_data: dict[str, list[tuple[str, str]]] = defaultdict(list)
    if not char_file.exists():
        return {}
    with open(char_file, "r", encoding="utf-8") as f:
        next(f)  # header
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) < MAGELO_MIN_PARTS:
                continue
            name = (parts[MAGELO_NAME_IDX] or "").strip()
            level = (parts[MAGELO_LEVEL_IDX] or "").strip()
            cls = (parts[MAGELO_CLASS_IDX] or "").strip()
            if not name:
                continue
            name_to_data[name].append((level, cls))
    # Only names that appear exactly once
    return {
        name: data[0]
        for name, data in name_to_data.items()
        if len(data) == 1
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Update Supabase character level/class from Magelo export (one-to-one name match only)."
    )
    ap.add_argument(
        "--character-file",
        type=Path,
        required=True,
        help="Path to TAKP_character.txt (Magelo export)",
    )
    ap.add_argument("--dry-run", action="store_true", help="Print what would be updated, do not call Supabase")
    args = ap.parse_args()

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip() or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("Install supabase: pip install supabase", file=sys.stderr)
        return 1

    magelo_one_to_one = load_magelo_levels_by_name(args.character_file)
    if not magelo_one_to_one:
        print("No Magelo names with unique match (or file empty).")
        return 0

    if args.dry_run:
        print(f"Magelo: {len(magelo_one_to_one)} names with unique level/class.")
        # Still need DB names to report what would be updated
        client = create_client(url, key)
    else:
        client = create_client(url, key)

    # Fetch all characters from Supabase; build name -> list of char_id
    all_chars: list[dict] = []
    offset = 0
    page_size = 1000
    while True:
        resp = client.table("characters").select("char_id, name, level, class_name").range(
            offset, offset + page_size - 1
        ).execute()
        rows = resp.data or []
        if not rows:
            break
        all_chars.extend(rows)
        if len(rows) < page_size:
            break
        offset += page_size

    name_to_char_ids: dict[str, list[str]] = defaultdict(list)
    for row in all_chars:
        name = (row.get("name") or "").strip()
        cid = (row.get("char_id") or "").strip()
        if name and cid:
            name_to_char_ids[name].append(cid)

    # Only names that appear exactly once in our DB
    db_one_to_one = {name: cids[0] for name, cids in name_to_char_ids.items() if len(cids) == 1}

    # Names in both: one-to-one in Magelo and one-to-one in DB
    to_update: list[tuple[str, str, str, str]] = []  # char_id, name, level, class_name
    for name, (level, cls) in magelo_one_to_one.items():
        if name in db_one_to_one:
            to_update.append((db_one_to_one[name], name, level, cls))

    if not to_update:
        print("No characters with one-to-one name match to update.")
        return 0

    if args.dry_run:
        print(f"Would update {len(to_update)} characters (level/class from Magelo):")
        for char_id, name, level, cls in to_update[:20]:
            print(f"  {name} (char_id={char_id}) -> level={level}, class={cls}")
        if len(to_update) > 20:
            print(f"  ... and {len(to_update) - 20} more")
        return 0

    updated = 0
    for char_id, name, level, cls in to_update:
        try:
            client.table("characters").update({
                "level": level,
                "class_name": cls or None,
            }).eq("char_id", char_id).execute()
            updated += 1
        except Exception as e:
            print(f"Failed to update {name} ({char_id}): {e}", file=sys.stderr)
    print(f"Updated level/class for {updated} characters (one-to-one name match).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

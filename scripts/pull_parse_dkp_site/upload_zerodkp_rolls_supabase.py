#!/usr/bin/env python3
"""
Validate audit_zerodkp_rolls.json against Supabase (raids + characters) and optionally
insert valid 0 DKP loot rows into raid_loot, then refresh DKP summary.

  python scripts/upload_zerodkp_rolls_supabase.py [--json path] [--dry-run] [--apply]
  Default JSON: audit_zerodkp_rolls.json in repo root.

Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY if RLS allows insert).
  Load from .env / web/.env / web/.env.local (VITE_SUPABASE_* also supported).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent  # repo root (script in scripts/pull_parse_dkp_site/)
PAGE_SIZE = 5000


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


def fetch_all(client, table: str, select: str = "*") -> list[dict]:
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


def main() -> int:
    load_dotenv()
    ap = argparse.ArgumentParser(description="Validate and optionally upload 0 DKP roll loot to Supabase.")
    ap.add_argument("--json", type=Path, default=ROOT / "audit_zerodkp_rolls.json", help="Path to audit JSON")
    ap.add_argument("--dry-run", action="store_true", help="Only validate; print what would be inserted")
    ap.add_argument("--out-valid", type=str, default="", help="With --dry-run, write valid rows to this JSON file")
    ap.add_argument("--apply", action="store_true", help="Insert valid rows and run refresh_dkp_summary")
    ap.add_argument("--list-valid", action="store_true", help="Only list rows that pass raid+character validation (ignore duplicate check); write to --out-valid if set")
    args = ap.parse_args()

    if not args.json.exists():
        print(f"JSON not found: {args.json}", file=sys.stderr)
        return 1

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    )
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).", file=sys.stderr)
        print("  Use .env or web/.env with those names, or VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("Install supabase: pip install supabase", file=sys.stderr)
        return 1

    with open(args.json, encoding="utf-8") as f:
        data = json.load(f)
    rows = data.get("generated_for_upload") or []
    if not rows:
        print("No generated_for_upload entries in JSON.")
        return 0

    print(f"Loaded {len(rows)} candidate rows from {args.json}. Connecting to Supabase...", flush=True)
    client = create_client(url, key)

    # Fetch valid raid_ids and characters
    raids = fetch_all(client, "raids", "raid_id")
    valid_raid_ids = {r["raid_id"] for r in raids if r.get("raid_id")}
    characters = fetch_all(client, "characters", "char_id, name")
    valid_char_ids = {str(c["char_id"]).strip() for c in characters if c.get("char_id")}
    valid_char_names_lower = {(c.get("name") or "").strip().lower() for c in characters if (c.get("name") or "").strip()}
    valid_char_by_id = {str(c["char_id"]).strip(): c for c in characters}
    valid_char_by_name_lower = {(c.get("name") or "").strip().lower(): c for c in characters if (c.get("name") or "").strip()}

    # Existing raid_loot: (raid_id, item_name_lower, character_name_lower) to skip duplicates
    loot = fetch_all(client, "raid_loot", "raid_id, item_name, character_name")
    existing = set()
    for r in loot:
        raid = (r.get("raid_id") or "").strip()
        item = (r.get("item_name") or "").strip().lower()
        char = (r.get("character_name") or "").strip().lower()
        if raid and item:
            existing.add((raid, item, char))

    valid = []
    invalid = []
    for row in rows:
        raid_id = (row.get("raid_id") or "").strip()
        item_name = (row.get("item_name") or "").strip()
        char_id = (row.get("char_id") or "").strip() or None
        character_name = (row.get("character_name") or "").strip()
        cost = (row.get("cost") or "0").strip()

        if not raid_id:
            invalid.append((row, "missing raid_id"))
            continue
        if raid_id not in valid_raid_ids:
            invalid.append((row, f"raid_id {raid_id} not in Supabase raids"))
            continue

        # Character: must have char_id or character_name that exists
        char_ok = False
        if char_id and char_id in valid_char_ids:
            char_ok = True
        if not char_ok and character_name:
            if character_name.lower() in valid_char_names_lower:
                char_ok = True
        if not char_ok:
            invalid.append((row, f"character not in Supabase: char_id={char_id!r} character_name={character_name!r}"))
            continue

        key = (raid_id, item_name.lower(), character_name.lower())
        if not args.list_valid and key in existing:
            invalid.append((row, "already in raid_loot (duplicate)"))
            continue

        valid.append({
            "raid_id": raid_id,
            "event_id": row.get("event_id"),
            "item_name": item_name,
            "char_id": char_id,
            "character_name": character_name,
            "cost": cost,
        })
        existing.add(key)

    print(f"Valid: {len(valid)}, Invalid: {len(invalid)}", flush=True)
    if invalid and len(invalid) <= 30:
        for row, reason in invalid:
            print(f"  Skip: {row.get('raid_id')} / {row.get('item_name')} / {row.get('character_name')} — {reason}")
    elif invalid:
        print(f"  (First 15 invalid:)", flush=True)
        for row, reason in invalid[:15]:
            print(f"  Skip: {row.get('raid_id')} / {row.get('item_name')} / {row.get('character_name')} — {reason}")

    if not valid:
        print("Nothing to insert.")
        return 0

    if args.list_valid:
        print(f"Valid (raid+character in Supabase): {len(valid)} rows.")
        if args.out_valid:
            out_path = Path(args.out_valid)
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(valid, f, indent=2)
            print(f"Wrote to {out_path}")
        else:
            for i, row in enumerate(valid):
                print(f"  {i+1}. {row['raid_id']} | {row['item_name']} | {row['character_name']} | cost={row['cost']}")
        return 0

    if args.dry_run:
        print(f"Dry run: would insert {len(valid)} rows into raid_loot. Run with --apply to insert.")
        if args.out_valid:
            out_path = Path(args.out_valid)
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(valid, f, indent=2)
            print(f"Wrote {len(valid)} valid rows to {out_path}")
        return 0

    if not args.apply:
        print("No --apply: skipping insert. Use --dry-run to validate only, or --apply to insert.")
        return 0

    # Optionally write the valid rows to a file for record
    if args.out_valid:
        out_path = Path(args.out_valid)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(valid, f, indent=2)
        print(f"Wrote {len(valid)} valid rows to {out_path}")

    # Insert in batches
    batch_size = 100
    for i in range(0, len(valid), batch_size):
        chunk = valid[i : i + batch_size]
        client.table("raid_loot").insert(chunk).execute()
    print(f"Inserted {len(valid)} rows into raid_loot.", flush=True)

    # Refresh DKP summary so spent totals update
    print("Calling refresh_dkp_summary()...", flush=True)
    try:
        client.rpc("refresh_dkp_summary").execute()
        print("refresh_dkp_summary() completed.")
    except Exception as e:
        print(f"Warning: refresh_dkp_summary failed: {e}. You can run it from the Officer UI or SQL Editor.", flush=True)

    return 0


if __name__ == "__main__":
    sys.exit(main())

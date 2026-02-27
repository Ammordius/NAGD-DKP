#!/usr/bin/env python3
"""
Upload characters from message (8).txt that are not currently in the DB.
- Uses Main as the account (display_name). Gets or creates one account per main.
- For each character in the message file: if not in characters table, insert with synthetic char_id (msg_<slug>).
- Links each character to its main's account via character_account.

Run from repo root. Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.

  python scripts/pull_parse_dkp_site/upload_message_characters.py [--dry-run] [--apply]
  Then: python scripts/pull_parse_dkp_site/diff_inactive_tic_loot_dry_run.py --data-dir data [--write]
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent
PAGE_SIZE = 1000
MSG_PREFIX = "msg_"


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


def load_dotenv() -> None:
    for path in (ROOT / ".env", ROOT / "web" / ".env", ROOT / "web" / ".env.local"):
        if path.exists():
            _load_env_file(path)


def fetch_all(client, table: str, columns: str = "*") -> list[dict]:
    out: list[dict] = []
    offset = 0
    while True:
        resp = client.table(table).select(columns).range(offset, offset + PAGE_SIZE - 1).execute()
        rows = resp.data or []
        if not rows:
            break
        out.extend(rows)
        if len(rows) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return out


def _norm(s) -> str:
    if s is None:
        return ""
    try:
        if isinstance(s, float) and s != s:
            return ""
    except Exception:
        pass
    return (str(s) or "").strip()


def slug(s: str, max_len: int = 60) -> str:
    """Safe identifier: alphanumeric and underscore only."""
    s = re.sub(r"[^a-zA-Z0-9]", "_", (s or "").strip())
    s = re.sub(r"_+", "_", s).strip("_")
    return (s or "unknown")[:max_len]


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(description="Upload characters from message (8).txt not in DB; account per main.")
    ap.add_argument("--message-file", type=Path, default=ROOT / "message (8).txt", help="Character\\tMain file")
    ap.add_argument("--dry-run", action="store_true", help="Only print what would be done (default if --apply not set)")
    ap.add_argument("--apply", action="store_true", help="Apply changes to Supabase")
    args = ap.parse_args()
    if not args.apply:
        args.dry_run = True

    msg_path = args.message_file
    if not msg_path.exists():
        print(f"Message file not found: {msg_path}", file=sys.stderr)
        return 1

    # Parse message file: Character \t Main
    lines = [l.strip().split("\t") for l in msg_path.read_text(encoding="utf-8").splitlines() if l.strip() and "\t" in l]
    if not lines or lines[0] == ["Character", "Main"]:
        lines = lines[1:] if lines and lines[0] == ["Character", "Main"] else lines
    # (character_name, main_name) preserving case from file
    char_main_pairs = [(_norm(c), _norm(m)) for c, m in lines if _norm(c) and _norm(m)]
    main_to_chars: dict[str, list[str]] = {}
    for char, main in char_main_pairs:
        main_to_chars.setdefault(main, []).append(char)
    mains = sorted(main_to_chars.keys())
    print(f"Message file: {len(char_main_pairs)} character–main pairs, {len(mains)} unique mains")

    if not args.apply:
        print("--- DRY RUN (use --apply to write to Supabase) ---")

    load_dotenv()
    url = os.environ.get("SUPABASE_URL", "").strip()
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        or os.environ.get("SUPABASE_ANON_KEY", "").strip()
    )
    if not url or not key:
        print("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).", file=sys.stderr)
        return 1

    try:
        from supabase import create_client
    except ImportError:
        print("pip install supabase", file=sys.stderr)
        return 1

    client = create_client(url, key)
    print("Fetching Supabase: characters, accounts, character_account...")
    characters = fetch_all(client, "characters", "char_id, name")
    accounts = fetch_all(client, "accounts", "account_id, display_name")
    ca_list = fetch_all(client, "character_account", "char_id, account_id")

    # name (normalized lower for match) -> list of (char_id, name as stored)
    name_to_chars: dict[str, list[tuple[str, str]]] = {}
    for r in characters:
        cid = _norm(r.get("char_id", ""))
        name = _norm(r.get("name", ""))
        if not cid:
            continue
        key_lower = name.lower()
        name_to_chars.setdefault(key_lower, []).append((cid, name))
    # account: by display_name (normalized) and account_id
    account_by_display: dict[str, str] = {}
    account_by_id: dict[str, dict] = {}
    for r in accounts:
        aid = _norm(r.get("account_id", ""))
        disp = _norm(r.get("display_name", ""))
        if aid:
            account_by_id[aid] = r
        if disp:
            account_by_display[disp.lower()] = aid
    linked = {( _norm(r.get("char_id", "")), _norm(r.get("account_id", "")) ) for r in ca_list}

    accounts_created = 0
    characters_created = 0
    links_created = 0
    accounts_existing = 0
    characters_existing = 0
    links_existing = 0

    def get_or_create_account_id(main_name: str) -> str:
        """Return account_id for this main. Create if missing (or simulate in dry-run)."""
        main_lower = main_name.lower()
        if main_lower in account_by_display:
            nonlocal accounts_existing
            accounts_existing += 1
            return account_by_display[main_lower]
        if main_name in account_by_id:
            accounts_existing += 1
            return main_name
        sid = slug(main_name)
        if sid in account_by_id:
            accounts_existing += 1
            return sid
        new_id = MSG_PREFIX + sid
        if new_id in account_by_id:
            accounts_existing += 1
            return new_id
        if args.apply:
            row = {
                "account_id": new_id,
                "display_name": main_name,
                "toon_count": 0,
                "char_ids": None,
                "toon_names": None,
            }
            client.table("accounts").upsert([row], on_conflict="account_id").execute()
            print(f"  Created account: {new_id!r} (display_name={main_name!r})")
        account_by_id[new_id] = {}
        account_by_display[main_lower] = new_id
        nonlocal accounts_created
        accounts_created += 1
        return new_id

    def char_id_for_name(character_name: str) -> str | None:
        """Return char_id if character exists (any match by name, case-insensitive). Else None."""
        key = character_name.lower()
        if key in name_to_chars:
            return name_to_chars[key][0][0]
        return None

    def ensure_character(character_name: str) -> str:
        """Return char_id for this character. Create with msg_<slug> if not in DB."""
        cid = char_id_for_name(character_name)
        if cid:
            return cid
        new_cid = MSG_PREFIX + slug(character_name)
        if args.apply:
            client.table("characters").upsert([{"char_id": new_cid, "name": character_name}], on_conflict="char_id").execute()
            print(f"  Created character: {new_cid!r} ({character_name!r})")
        name_to_chars[character_name.lower()] = [(new_cid, character_name)]
        nonlocal characters_created
        characters_created += 1
        return new_cid

    def link_char_to_account(char_id: str, account_id: str) -> bool:
        if (char_id, account_id) in linked:
            nonlocal links_existing
            links_existing += 1
            return False
        if args.apply:
            client.table("character_account").upsert([{"char_id": char_id, "account_id": account_id}], on_conflict="char_id,account_id").execute()
        linked.add((char_id, account_id))
        nonlocal links_created
        links_created += 1
        return True

    for main_name in mains:
        account_id = get_or_create_account_id(main_name)
        for char_name in main_to_chars[main_name]:
            existing_cid = char_id_for_name(char_name)
            if existing_cid:
                characters_existing += 1
                cid = existing_cid
            else:
                cid = ensure_character(char_name)
            link_char_to_account(cid, account_id)

    if args.dry_run:
        print(f"\nDry run: already in DB — accounts: {accounts_existing}, characters: {characters_existing}, links: {links_existing}")
        print(f"         would create — accounts: {accounts_created}, characters: {characters_created}, links: {links_created}")
        print("Re-run with --apply to write, then run: python scripts/pull_parse_dkp_site/diff_inactive_tic_loot_dry_run.py --data-dir data [--write]")
    else:
        print(f"\nDone. Accounts created: {accounts_created}, characters created: {characters_created}, links added: {links_created}")
        print("Next: python scripts/pull_parse_dkp_site/diff_inactive_tic_loot_dry_run.py --data-dir data --write")

    return 0


if __name__ == "__main__":
    sys.exit(main())

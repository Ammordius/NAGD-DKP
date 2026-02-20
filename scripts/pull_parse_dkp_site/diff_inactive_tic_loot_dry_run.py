#!/usr/bin/env python3
"""
1) Pull accounts (and character_account, characters) from Supabase.
2) Compare that set vs all tics we have in CSV: which tics are for characters
   that are NOT linked to any account (unlinked/inactive)?
3) Generate diff: add only those tics + loot from those characters.
4) For remaining (unlinked) character names: assign one synthetic account and
   one character per name; report how many tics/loot would attach to them.
5) Statistics (dry run only; no DB writes).

  python scripts/pull_parse_dkp_site/diff_inactive_tic_loot_dry_run.py [--data-dir data]

Requires: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env / web/.env.
"""

from __future__ import annotations

import os
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent.parent
PAGE_SIZE = 1000
UNLINKED_ACCOUNT_ID = "inactive_raiders"
UNLINKED_CHAR_PREFIX = "unlinked_"
# Names corrected in DB; do not add to inactive_raiders (excluded from apply SQL and stats).
EXCLUDE_UNLINKED_NAMES = frozenset({"Anmordius"})


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
        if isinstance(s, float) and s != s:  # NaN
            return ""
    except Exception:
        pass
    return (str(s) or "").strip()


def _char_key(char_id: str, character_name: str) -> tuple[str, str]:
    return (_norm(char_id), _norm(character_name))


def _tic_tuple(r: dict) -> tuple:
    return (
        _norm(str(r.get("raid_id", ""))),
        _norm(str(r.get("event_id", ""))),
        _norm(str(r.get("char_id", ""))),
        _norm(str(r.get("character_name", ""))),
    )


def _loot_tuple(r: dict) -> tuple:
    return (
        _norm(str(r.get("raid_id", ""))),
        _norm(str(r.get("event_id", ""))),
        _norm(str(r.get("item_name", ""))),
        _norm(str(r.get("char_id", ""))),
        _norm(str(r.get("character_name", ""))),
        _norm(str(r.get("cost", ""))),
    )


def slug_name(name: str) -> str:
    """Safe identifier from character name for unlinked char_id."""
    s = re.sub(r"[^a-zA-Z0-9]", "_", (name or "").strip())
    return (s or "unknown")[:64]


def _sql_escape(s: str) -> str:
    """Escape single quotes for SQL literal."""
    return (s or "").replace("'", "''")


def _parse_unapply_tic_tuples_from_sql(path: Path) -> list[tuple[str, str, str, str]]:
    """Parse docs/unapply_inactive_raiders.sql and return list of (raid_id, event_id, char_id, character_name) from the first DELETE IN (...)."""
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8")
    # Match lines like   ('1598436', '2498790', '22036483', 'Anmordius'),
    pattern = re.compile(r"\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)")
    out = []
    for m in pattern.finditer(text):
        out.append((m.group(1), m.group(2), m.group(3), m.group(4)))
    return out


def main() -> int:
    import argparse
    ap = argparse.ArgumentParser(
        description="Diff: CSV tics/loot vs Supabase; classify linked vs unlinked; stats for adding unlinked with one account."
    )
    ap.add_argument("--data-dir", type=Path, default=ROOT / "data", help="Directory with raid_*.csv")
    ap.add_argument("--unlinked-account", type=str, default=UNLINKED_ACCOUNT_ID, help="Account id for unlinked characters")
    ap.add_argument("--write", action="store_true", help="Write full summary .md and apply/unapply .sql to --output-dir")
    ap.add_argument("--output-dir", type=Path, default=ROOT / "docs", help="Where to write summary and SQL (default docs/)")
    ap.add_argument("--apply", action="store_true", help="Apply to Supabase: insert account, characters, character_account, missing tics; then refresh_dkp_summary()")
    ap.add_argument("--one-account-per-character", action="store_true", help="With --apply: create one account per unlinked name (e.g. Aadd, Frinop) instead of one 'Inactive Raiders' account. Use after initial apply to migrate.")
    ap.add_argument("--unapply", action="store_true", help="Revert applied inactive-raiders change: delete added tics, character_account, characters, account; then refresh_dkp_summary().")
    args = ap.parse_args()

    data_dir = args.data_dir
    if not data_dir.is_dir():
        print(f"Data directory not found: {data_dir}", file=sys.stderr)
        return 1

    try:
        import pandas as pd
    except ImportError:
        print("pip install pandas", file=sys.stderr)
        return 1

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

    # --- 1) Pull accounts and character linkage from Supabase ---
    print("Fetching Supabase: accounts, character_account, characters...")
    accounts = fetch_all(client, "accounts", "account_id, display_name, toon_names")
    ca_list = fetch_all(client, "character_account", "char_id, account_id")
    characters = fetch_all(client, "characters", "char_id, name")

    known_char_ids = {_norm(r.get("char_id", "")) for r in ca_list if _norm(r.get("char_id", ""))}
    char_id_to_name: dict[str, str] = {_norm(r["char_id"]): _norm(r.get("name", "")) for r in characters if _norm(r.get("char_id", ""))}
    account_ids = {_norm(r.get("account_id", "")) for r in accounts if _norm(r.get("account_id", ""))}

    # Build account_id -> set of names (display_name, toon_names split, and linked character names)
    account_to_names: dict[str, set[str]] = defaultdict(set)
    for r in accounts:
        aid = _norm(r.get("account_id", ""))
        if not aid:
            continue
        dn = _norm(r.get("display_name", ""))
        if dn:
            account_to_names[aid].add(dn)
        tn = _norm(r.get("toon_names", ""))
        if tn:
            for part in tn.split(","):
                account_to_names[aid].add(part.strip())
    # Linked character names per account
    for r in ca_list:
        aid = _norm(r.get("account_id", ""))
        cid = _norm(r.get("char_id", ""))
        if aid and cid:
            name = char_id_to_name.get(cid, "")
            if name:
                account_to_names[aid].add(name)
    # Name -> list of Supabase account_ids that have this name (display_name, toon_names, or linked char)
    name_to_supabase_accounts: dict[str, list[str]] = defaultdict(list)
    for aid, names in account_to_names.items():
        for n in names:
            if n and aid not in name_to_supabase_accounts[n]:
                name_to_supabase_accounts[n].append(aid)

    def is_linked(char_id: str, character_name: str) -> bool:
        cid = _norm(char_id)
        return bool(cid and cid in known_char_ids)

    print(f"  Accounts: {len(account_ids)}, character_account rows: {len(ca_list)}, known char_ids: {len(known_char_ids)}, characters: {len(characters)}")

    # --- Fetch existing tics and loot from Supabase (for diff) ---
    print("Fetching Supabase: raid_event_attendance, raid_loot...")
    rea_rows = fetch_all(client, "raid_event_attendance", "raid_id, event_id, char_id, character_name")
    loot_rows = fetch_all(client, "raid_loot", "raid_id, event_id, item_name, char_id, character_name, cost")

    db_tic_counter = Counter(_tic_tuple(r) for r in rea_rows)
    db_loot_counter = Counter(_loot_tuple(r) for r in loot_rows)
    print(f"  DB tics: {len(rea_rows)}, DB loot: {len(loot_rows)}")

    # --- Load CSV tics and loot ---
    csv_rea = data_dir / "raid_event_attendance.csv"
    csv_loot = data_dir / "raid_loot.csv"
    if not csv_rea.exists() or not csv_loot.exists():
        print(f"Missing {csv_rea} or {csv_loot}. Run extract_structured_data.py and parse_raid_attendees.py first.", file=sys.stderr)
        return 1

    df_rea = pd.read_csv(csv_rea)
    df_loot = pd.read_csv(csv_loot)
    csv_tic_tuples = [
        _tic_tuple({"raid_id": r.get("raid_id"), "event_id": r.get("event_id"), "char_id": r.get("char_id"), "character_name": r.get("character_name")})
        for _, r in df_rea.iterrows()
    ]
    csv_loot_tuples = [
        _loot_tuple({
            "raid_id": r.get("raid_id"), "event_id": r.get("event_id"), "item_name": r.get("item_name"),
            "char_id": r.get("char_id"), "character_name": r.get("character_name"), "cost": r.get("cost", ""),
        })
        for _, r in df_loot.iterrows()
    ]
    csv_tic_counter = Counter(csv_tic_tuples)
    csv_loot_counter = Counter(csv_loot_tuples)
    print(f"  CSV tics: {len(csv_tic_tuples)}, CSV loot: {len(csv_loot_tuples)}")

    # --- Load DKP site accounts.csv (account_id, toon_names) for dry-run comparison ---
    dkp_name_to_account_ids: dict[str, list[str]] = defaultdict(list)
    csv_accounts_path = data_dir / "accounts.csv"
    if csv_accounts_path.exists():
        try:
            df_acc = pd.read_csv(csv_accounts_path)
            for _, row in df_acc.iterrows():
                aid = _norm(str(row.get("account_id", "")))
                toon_names = _norm(str(row.get("toon_names", "")))
                if not aid:
                    continue
                for part in toon_names.split(","):
                    name = part.strip()
                    if name and aid not in dkp_name_to_account_ids[name]:
                        dkp_name_to_account_ids[name].append(aid)
            print(f"  DKP site accounts.csv: loaded, {len(df_acc)} accounts, names mapped for comparison")
        except Exception as e:
            print(f"  Could not parse {csv_accounts_path}: {e}", file=sys.stderr)
    else:
        print(f"  Optional {csv_accounts_path} not found; skipping DKP site account comparison")

    # --- Diff: to_add = CSV - DB (multiset; only positive excess) ---
    to_add_tic_counter: Counter = Counter()
    for key, cnt in csv_tic_counter.items():
        excess = cnt - db_tic_counter.get(key, 0)
        if excess > 0:
            to_add_tic_counter[key] = excess
    to_add_loot_counter: Counter = Counter()
    for key, cnt in csv_loot_counter.items():
        excess = cnt - db_loot_counter.get(key, 0)
        if excess > 0:
            to_add_loot_counter[key] = excess
    to_add_tics = list(to_add_tic_counter.elements())
    to_add_loot = list(to_add_loot_counter.elements())
    # Count CSV tics with empty char_id (inactive by parser) and unlinked in full CSV
    csv_tic_empty_char = sum(1 for t in csv_tic_tuples if not _norm(t[2]))
    csv_tic_unlinked_full = sum(1 for t in csv_tic_tuples if not is_linked(t[2], t[3]))
    csv_tic_count = len(csv_tic_tuples)
    db_only_tic_counter = db_tic_counter - csv_tic_counter
    tics_db_only = sum(db_only_tic_counter.values())

    print(f"\n--- Diff (CSV - DB) ---")
    print(f"  Tics to add (in CSV, not in DB): {len(to_add_tics)}")
    print(f"  Tics in DB not in CSV: {tics_db_only}")
    print(f"  In full CSV: tics with empty char_id (inactive): {csv_tic_empty_char} of {csv_tic_count}")
    print(f"  In full CSV: tics for unlinked chars (no account in Supabase): {csv_tic_unlinked_full} of {csv_tic_count}")
    print(f"  Loot rows to add: {len(to_add_loot)}")

    if not to_add_tics and not to_add_loot:
        print("\nNo tics/loot to add (CSV already contained in DB). Unlinked account+characters SQL can still be written with --write.")

    # --- Classify by linked vs unlinked ---
    # "Linked" = character has char_id in known_char_ids. Else unlinked (empty char_id or char_id not in Supabase).
    tics_linked: list[tuple] = []
    tics_unlinked: list[tuple] = []
    for t in to_add_tics:
        (rid, eid, cid, cname) = t
        if is_linked(cid, cname):
            tics_linked.append(t)
        else:
            tics_unlinked.append(t)

    loot_linked: list[tuple] = []
    loot_unlinked: list[tuple] = []
    for t in to_add_loot:
        (rid, eid, item, cid, cname, cost) = t
        if is_linked(cid, cname):
            loot_linked.append(t)
        else:
            loot_unlinked.append(t)

    # --- Unlinked: from TO-ADD only (for insert list) ---
    unlinked_char_keys_to_add: set[tuple[str, str]] = set()
    for t in tics_unlinked:
        unlinked_char_keys_to_add.add((t[2], t[3]))
    for t in loot_unlinked:
        unlinked_char_keys_to_add.add((t[3], t[4]))

    # --- Unlinked in FULL CSV: all tics/loot whose character has no account (for statistics) ---
    unlinked_tic_tuples_full = [t for t in csv_tic_tuples if not is_linked(t[2], t[3])]
    unlinked_loot_tuples_full = [t for t in csv_loot_tuples if not is_linked(t[3], t[4])]
    unlinked_char_keys_full: set[tuple[str, str]] = set()
    for t in unlinked_tic_tuples_full:
        unlinked_char_keys_full.add((t[2], t[3]))
    for t in unlinked_loot_tuples_full:
        unlinked_char_keys_full.add((t[3], t[4]))

    unlinked_names_to_add: set[str] = set()
    for cid, cname in unlinked_char_keys_to_add:
        name = cname or char_id_to_name.get(cid, "") or cid or "unknown"
        if name:
            unlinked_names_to_add.add(_norm(name))

    # Prefer character_name as display for full set
    unlinked_names_raw: set[str] = set()
    for cid, cname in unlinked_char_keys_full:
        name = cname or char_id_to_name.get(cid, "") or cid or "unknown"
        if name:
            unlinked_names_raw.add(_norm(name))
    unlinked_names = {n for n in unlinked_names_raw if n not in EXCLUDE_UNLINKED_NAMES}
    excluded_count = len(unlinked_names_raw) - len(unlinked_names)
    if excluded_count:
        print(f"  Excluded from inactive_raiders (corrected in DB): {EXCLUDE_UNLINKED_NAMES} ({excluded_count} name(s))")

    # Build synthetic char_id per unlinked name (for reporting: what we would insert)
    # Group by slug to avoid collisions when two names slug to the same id
    seen_slugs: dict[str, list[str]] = {}
    for name in sorted(unlinked_names):
        slug = slug_name(name)
        seen_slugs.setdefault(slug, []).append(name)
    name_to_synthetic_cid: dict[str, str] = {}
    for slug, names in seen_slugs.items():
        for j, name in enumerate(names):
            if len(names) == 1:
                name_to_synthetic_cid[name] = f"{UNLINKED_CHAR_PREFIX}{slug}"
            else:
                name_to_synthetic_cid[name] = f"{UNLINKED_CHAR_PREFIX}{slug}_{j}"

    # --- Statistics ---
    print("\n" + "=" * 60)
    print("STATISTICS (dry run)")
    print("=" * 60)
    print(f"\n1) Tics to add: {len(to_add_tics)} total")
    print(f"   - Linked (char_id already in Supabase character_account): {len(tics_linked)}")
    print(f"   - Unlinked (inactive / no account): {len(tics_unlinked)}")

    print(f"\n2) Loot rows to add: {len(to_add_loot)} total")
    print(f"   - Linked: {len(loot_linked)}")
    print(f"   - Unlinked: {len(loot_unlinked)}")

    print(f"\n3) Unlinked characters in FULL CSV (no account in Supabase)")
    print(f"   - Distinct names (would create one character per name): {len(unlinked_names)}")
    print(f"   - Tics in CSV for these: {len(unlinked_tic_tuples_full)}")
    print(f"   - Loot rows in CSV for these: {len(unlinked_loot_tuples_full)}")
    print(f"   - Would create one account per unlinked raider (each with one character):")
    print(f"   - Would create: {len(unlinked_names)} account rows, {len(unlinked_names)} character rows, {len(unlinked_names)} character_account rows")
    print(f"   - Of the TO-ADD diff: tics for unlinked: {len(tics_unlinked)}, loot for unlinked: {len(loot_unlinked)}")

    # Per-name tic/loot counts (from full CSV)
    unlinked_tic_count_by_name: dict[str, int] = defaultdict(int)
    unlinked_loot_count_by_name: dict[str, int] = defaultdict(int)
    for t in unlinked_tic_tuples_full:
        cid, cname = t[2], t[3]
        name = _norm(cname) or char_id_to_name.get(_norm(cid), "") or _norm(cid) or "unknown"
        if name:
            unlinked_tic_count_by_name[name] += 1
    for t in unlinked_loot_tuples_full:
        cid, cname = t[3], t[4]
        name = _norm(cname) or char_id_to_name.get(_norm(cid), "") or _norm(cid) or "unknown"
        if name:
            unlinked_loot_count_by_name[name] += 1

    sample = sorted(unlinked_names)[:30]
    print(f"\n4) Sample unlinked character names (first 30):")
    for n in sample:
        syn = name_to_synthetic_cid.get(n, "?")
        tc = unlinked_tic_count_by_name.get(n, 0)
        lc = unlinked_loot_count_by_name.get(n, 0)
        print(f"   {n!r} -> char_id={syn}  (CSV tics: {tc}, loot: {lc})")

    if len(unlinked_names) > 30:
        print(f"   ... and {len(unlinked_names) - 30} more")

    print(f"\n4b) Top 20 unlinked names by CSV tic count:")
    for n, _ in sorted(unlinked_tic_count_by_name.items(), key=lambda x: -x[1])[:20]:
        tc = unlinked_tic_count_by_name[n]
        lc = unlinked_loot_count_by_name.get(n, 0)
        print(f"   {n!r}: {tc} tics, {lc} loot")

    # --- Existing Supabase accounts (names) and match unlinked to appropriate accounts ---
    print("\n" + "=" * 60)
    print("EXISTING ACCOUNTS & UNLINKED NAME MATCHES (dry run)")
    print("=" * 60)
    # Existing account summary (sample)
    account_list = sorted(account_to_names.keys())
    print(f"\n6) Existing Supabase accounts: {len(account_list)} total")
    sample_accounts = account_list[:25]
    for aid in sample_accounts:
        names = account_to_names.get(aid, set())
        disp = next((r for r in accounts if _norm(r.get("account_id", "")) == aid), {})
        display_name = _norm(disp.get("display_name", "")) or "(none)"
        toon_names = _norm(disp.get("toon_names", ""))[:60]
        if len(_norm(disp.get("toon_names", ""))) > 60:
            toon_names += "..."
        print(f"   {aid!r}  display_name={display_name!r}  toon_names={toon_names!r}  linked_names={len(names)}")
    if len(account_list) > 25:
        print(f"   ... and {len(account_list) - 25} more accounts")

    # Unlinked names that match an existing Supabase account (by display_name / toon_names / linked char name)
    unlinked_matching_supabase: list[tuple[str, list[str]]] = []
    for n in sorted(unlinked_names):
        accs = name_to_supabase_accounts.get(n, [])
        if accs:
            unlinked_matching_supabase.append((n, accs))
    print(f"\n7) Unlinked names that MATCH an existing Supabase account (by name): {len(unlinked_matching_supabase)}")
    if unlinked_matching_supabase:
        print("   (These could be assigned to existing accounts instead of creating a new account if linked by character name.)")
        for n, accs in unlinked_matching_supabase[:30]:
            print(f"   {n!r} -> existing account(s): {accs}")
        if len(unlinked_matching_supabase) > 30:
            print(f"   ... and {len(unlinked_matching_supabase) - 30} more")
    else:
        print("   None. All unlinked names get their own account.")

    # Unlinked names that appear on DKP site under another account (from accounts.csv)
    unlinked_on_dkp_site: list[tuple[str, list[str]]] = []
    for n in sorted(unlinked_names):
        dkp_accs = dkp_name_to_account_ids.get(n, [])
        if dkp_accs:
            unlinked_on_dkp_site.append((n, dkp_accs))
    print(f"\n8) Unlinked names that appear on DKP site (accounts.csv) under another account: {len(unlinked_on_dkp_site)}")
    if unlinked_on_dkp_site:
        print("   (On the DKP site these toons are grouped under an account; the app would create one account per name because char_id is not in Supabase.)")
        for n, accs in unlinked_on_dkp_site[:25]:
            print(f"   {n!r} -> DKP site account_id(s): {accs}")
        if len(unlinked_on_dkp_site) > 25:
            print(f"   ... and {len(unlinked_on_dkp_site) - 25} more")
    else:
        print("   None (or accounts.csv not loaded).")

    # Summary: what the application will do vs current DKP site
    print("\n9) Application vs current DKP site (dry run summary)")
    print(f"   - Application AFTER apply: {len(unlinked_names)} accounts (one per unlinked raider), each with one character. account_id = synthetic id (e.g. unlinked_Frinop), display_name = character name.")
    print(f"   - Unlinked names that match an existing Supabase account (could be wrong bucket): {len(unlinked_matching_supabase)}")
    print(f"   - Unlinked names that are under another account on DKP site (accounts.csv): {len(unlinked_on_dkp_site)}")
    print("   - Recommendation: review section 7 and 8; if any name should belong to an existing account, link that character (char_id) to that account instead of creating a new one.")

    # Per-raid summary for unlinked tics
    unlinked_tic_raids: Counter[str] = Counter()
    for t in tics_unlinked:
        unlinked_tic_raids[t[0]] += 1
    print(f"\n5) Raids with unlinked tics to add: {len(unlinked_tic_raids)} raids")
    for rid, count in unlinked_tic_raids.most_common(15):
        print(f"   raid_id={rid}: +{count} tics")
    if len(unlinked_tic_raids) > 15:
        print(f"   ... and {len(unlinked_tic_raids) - 15} more raids")

    if getattr(args, "unapply", False):
        # --- Unapply: revert what apply added (same order as docs/unapply_inactive_raiders.sql) ---
        print("\n--- Unapplying from Supabase ---")
        # 1) Remove added tics (exact rows we would have added)
        for t in to_add_tics:
            q = client.table("raid_event_attendance").delete().eq("raid_id", t[0]).eq("event_id", t[1])
            if t[2] is not None and str(t[2]).strip():
                q = q.eq("char_id", t[2])
            else:
                q = q.is_("char_id", "null")
            if t[3] is not None and str(t[3]).strip():
                q = q.eq("character_name", t[3])
            else:
                q = q.is_("character_name", "null")
            q.execute()
        print(f"  raid_event_attendance: {len(to_add_tics)} rows deleted")
        # 2) Unlink characters from their accounts
        synthetic_ids = [name_to_synthetic_cid[n] for n in sorted(unlinked_names)]
        for i in range(0, len(synthetic_ids), 100):
            batch = synthetic_ids[i : i + 100]
            client.table("character_account").delete().in_("account_id", batch).execute()
        print(f"  character_account: {len(synthetic_ids)} rows deleted")
        # 3) Remove synthetic characters
        for i in range(0, len(synthetic_ids), 100):
            batch = synthetic_ids[i : i + 100]
            client.table("characters").delete().in_("char_id", batch).execute()
        print(f"  characters: {len(synthetic_ids)} rows deleted")
        # 4) Remove per-raider accounts
        for i in range(0, len(synthetic_ids), 100):
            batch = synthetic_ids[i : i + 100]
            client.table("accounts").delete().in_("account_id", batch).execute()
        print(f"  accounts: {len(synthetic_ids)} rows deleted")
        # 5) Refresh DKP summary
        client.rpc("refresh_dkp_summary").execute()
        print("  refresh_dkp_summary() completed.")
        print("Done. Unapplied from Supabase.")
    elif getattr(args, "apply", False):
        # --- Apply to Supabase via client (one account per unlinked raider) ---
        # Full diff was already run above: to_add_tics/loot and unlinked_names are from current DB state.
        # Only missing rows are applied; upsert for accounts/chars/ca; insert only for tics. Safe to re-run.
        print("\n--- Applying to Supabase (one account per unlinked raider) ---")
        print("  (Diff-first: only missing rows applied; safe to re-run; no duplicate uploads.)")
        BATCH = 100
        # 1) One account per unlinked raider
        account_rows = [{"account_id": name_to_synthetic_cid[n], "char_ids": None, "toon_names": None, "toon_count": 1, "display_name": n} for n in sorted(unlinked_names)]
        for i in range(0, len(account_rows), BATCH):
            client.table("accounts").upsert(account_rows[i : i + BATCH], on_conflict="account_id").execute()
        print(f"  accounts: {len(account_rows)} rows upserted")
        # 2) Characters (batched)
        char_rows = [{"char_id": name_to_synthetic_cid[n], "name": n} for n in sorted(unlinked_names)]
        for i in range(0, len(char_rows), BATCH):
            client.table("characters").upsert(char_rows[i : i + BATCH], on_conflict="char_id").execute()
        print(f"  characters: {len(char_rows)} rows upserted")
        # 3) character_account: each character linked to its own account
        ca_rows = [{"char_id": name_to_synthetic_cid[n], "account_id": name_to_synthetic_cid[n]} for n in sorted(unlinked_names)]
        for i in range(0, len(ca_rows), BATCH):
            client.table("character_account").upsert(ca_rows[i : i + BATCH], on_conflict="char_id,account_id").execute()
        print(f"  character_account: {len(ca_rows)} rows upserted")
        # 4) Missing tics (use restore-load mode so triggers no-op during bulk insert, then one full refresh)
        if to_add_tics:
            client.rpc("begin_restore_load").execute()
            print("  begin_restore_load() — triggers no-op during tic insert")
            try:
                tic_rows = [{"raid_id": t[0], "event_id": t[1], "char_id": t[2] or None, "character_name": t[3] or None} for t in to_add_tics]
                for i in range(0, len(tic_rows), BATCH):
                    client.table("raid_event_attendance").insert(tic_rows[i : i + BATCH]).execute()
                print(f"  raid_event_attendance: {len(tic_rows)} rows inserted")
            finally:
                try:
                    client.rpc("end_restore_load").execute()
                    print("  end_restore_load() — sequences + refresh_dkp_summary + refresh_all_raid_attendance_totals")
                except Exception as e:
                    if "timeout" in str(e).lower() or "57014" in str(e):
                        print("  end_restore_load() timed out (accounts/chars/tics were written). Run: python scripts/pull_parse_dkp_site/run_end_restore_load.py")
                        print("Done. Applied to Supabase. Run the command above to finish refresh.")
                        return 0
                    raise
        else:
            client.rpc("refresh_dkp_summary").execute()
            print("  refresh_dkp_summary() completed.")
        print("Done. Applied to Supabase.")
    else:
        print("\n--- Dry run only. No changes written to Supabase. ---")

    # --- Write summary and SQL if requested ---
    if getattr(args, "write", False):
        out_dir = getattr(args, "output_dir", ROOT / "docs")
        out_dir.mkdir(parents=True, exist_ok=True)

        # 1) Full dry-run summary (markdown)
        summary_path = out_dir / "dry_run_inactive_raiders_summary.md"
        lines = [
            "# Inactive / Unlinked Raiders — Full Dry Run Summary",
            "",
            "Generated by `diff_inactive_tic_loot_dry_run.py --write`. No database changes.",
            "",
            "## Where is the diff / what will be applied?",
            "",
            "| Output | Path |",
            "|--------|------|",
            "| **This summary** (diff stats, account matches, full character list) | `docs/dry_run_inactive_raiders_summary.md` |",
            "| **Apply SQL** (exact statements to run) | `docs/apply_inactive_raiders.sql` |",
            "| **Unapply SQL** (revert) | `docs/unapply_inactive_raiders.sql` |",
            "| **Plain list of names** (one per line) | `docs/inactive_raiders_to_add.txt` |",
            "",
            "**What the apply does (full detail):**",
            "",
            f"1. **{len(unlinked_names)} accounts** — one account per unlinked raider. Each account_id = synthetic id (e.g. `unlinked_Frinop`), display_name = character name. These are raiders not found in the existing account set.",
            f"2. **{len(unlinked_names)} characters** — one row per unlinked name with synthetic `char_id` like `unlinked_Frinop`. Full list in section 8 below.",
            f"3. **{len(unlinked_names)} character_account rows** — each character linked to its own account (one character per account).",
            f"4. **{len(to_add_tics)} raid_event_attendance rows** — missing tics (in CSV, not in DB). Exact rows listed in `apply_inactive_raiders.sql` section 4.",
            "",
            f"**Loot:** This script does **not** insert into `raid_loot`. Loot for these characters is already in the DB (from your normal CSV import). `refresh_dkp_summary()` attributes spent by `character_name` when `char_id` is empty, so once these characters and accounts exist and you run `SELECT refresh_dkp_summary();`, their existing loot rows will show under each raider's own account. In the CSV there are **{len(unlinked_loot_tuples_full)}** loot rows for unlinked names; those are already in `raid_loot` (diff reported 0 loot rows to add when DB is in sync).",
            "",
            f"## List of {len(unlinked_names)} raiders to be added",
            "",
            "One account will be created for each of the following (sorted alphabetically):",
            "",
            "| # | character_name | char_id |",
            "|---|----------------|--------|",
            ]
        for i, n in enumerate(sorted(unlinked_names), 1):
            lines.append(f"| {i} | {n!r} | {name_to_synthetic_cid.get(n, '?')} |")
        lines.extend([
            "",
            "---",
            "",
            "## 1. Diff (CSV − DB)",
            "",
            f"- **Tics to add** (in CSV, not in DB): {len(to_add_tics)}",
            f"- **Tics in DB not in CSV:** {tics_db_only}",
            f"- **In full CSV: tics with empty char_id (inactive):** {csv_tic_empty_char} of {csv_tic_count}",
            f"- **In full CSV: tics for unlinked chars** (no account in Supabase): {csv_tic_unlinked_full} of {csv_tic_count}",
            f"- **Loot rows to add:** {len(to_add_loot)}",
            "",
            "## 2. Statistics",
            "",
            f"- **Tics to add:** {len(to_add_tics)} total (linked: {len(tics_linked)}, unlinked: {len(tics_unlinked)})",
            f"- **Loot to add:** {len(to_add_loot)} total (linked: {len(loot_linked)}, unlinked: {len(loot_unlinked)})",
            f"- **Unlinked in full CSV:** {len(unlinked_names)} distinct names, {len(unlinked_tic_tuples_full)} tics, {len(unlinked_loot_tuples_full)} loot rows",
            f"- **Would create:** {len(unlinked_names)} accounts (one per unlinked raider), {len(unlinked_names)} characters, {len(unlinked_names)} character_account rows",
            "",
            "## 3. Top 20 unlinked names by CSV tic count",
            "",
            "| Name | CSV tics | CSV loot |",
            "|------|----------|---------|",
            ])
        for n, _ in sorted(unlinked_tic_count_by_name.items(), key=lambda x: -x[1])[:20]:
            tc = unlinked_tic_count_by_name[n]
            lc = unlinked_loot_count_by_name.get(n, 0)
            lines.append(f"| {n!r} | {tc} | {lc} |")
        lines.extend([
            "",
            "## 4. Existing Supabase accounts (sample)",
            "",
            "| account_id | display_name | toon_names (truncated) | linked_names count |",
            "|------------|--------------|------------------------|--------------------|",
            ])
        for aid in list(account_list)[:30]:
            names = account_to_names.get(aid, set())
            disp = next((r for r in accounts if _norm(r.get("account_id", "")) == aid), {})
            display_name = _norm(disp.get("display_name", "")) or "(none)"
            toon_names = (_norm(disp.get("toon_names", "")) or "")[:50]
            if len(_norm(disp.get("toon_names", ""))) > 50:
                toon_names += "..."
            lines.append(f"| {aid!r} | {display_name!r} | {toon_names!r} | {len(names)} |")
        if len(account_list) > 30:
            lines.append(f"| ... | ... | ... | ({len(account_list) - 30} more accounts) |")
        lines.extend([
            "",
            "## 5. Unlinked names that match an existing Supabase account",
            "",
            f"These {len(unlinked_matching_supabase)} names could be assigned to existing accounts instead of creating a new account (link by character name/char_id).",
            "",
            "| character_name | existing account_id(s) |",
            "|----------------|------------------------|",
            ])
        for n, accs in unlinked_matching_supabase:
            lines.append(f"| {n!r} | {accs} |")
        if not unlinked_matching_supabase:
            lines.append("| *(none)* | |")
        lines.extend([
            "",
            "## 6. Unlinked names that appear on DKP site (accounts.csv) under another account",
            "",
            f"These {len(unlinked_on_dkp_site)} names are grouped under an account on the DKP site; the app would create one account per name (char_id not in Supabase).",
            "",
            "| character_name | DKP site account_id(s) |",
            "|----------------|------------------------|",
            ])
        for n, accs in unlinked_on_dkp_site:
            lines.append(f"| {n!r} | {accs} |")
        if not unlinked_on_dkp_site:
            lines.append("| *(none or accounts.csv not loaded)* | |")
        lines.extend([
            "",
            "## 7. Application vs DKP site (dry run summary)",
            "",
            f"- **Application after apply:** {len(unlinked_names)} accounts (one per unlinked raider), each with one character. account_id = synthetic id (e.g. unlinked_Frinop), display_name = character name.",
            f"- **Unlinked names that match an existing Supabase account:** {len(unlinked_matching_supabase)} (review section 5).",
            f"- **Unlinked names under another account on DKP site:** {len(unlinked_on_dkp_site)} (review section 6).",
            "- **Recommendation:** If any name should belong to an existing account, link that character (char_id) to that account instead of creating a new one.",
            "",
            "## 8. All unlinked character names (synthetic char_id)",
            "",
            "| character_name | char_id | CSV tics | CSV loot |",
            "|----------------|--------|----------|---------|",
            ])
        for n in sorted(unlinked_names):
            syn = name_to_synthetic_cid.get(n, "?")
            tc = unlinked_tic_count_by_name.get(n, 0)
            lc = unlinked_loot_count_by_name.get(n, 0)
            lines.append(f"| {n!r} | {syn} | {tc} | {lc} |")
        lines.extend([
            "",
            "## 9. Apply / Unapply",
            "",
            "Run in Supabase SQL Editor:",
            "",
            "- **Apply:** `docs/apply_inactive_raiders.sql`",
            "- **Unapply (revert):** `docs/unapply_inactive_raiders.sql`",
            "",
            "After apply, run: `SELECT refresh_dkp_summary();` to refresh DKP totals.",
            "",
            "---",
            "",
            "*Dry run only. No changes written to Supabase by this script.*",
            "",
            ])
        summary_path.write_text("\n".join(lines), encoding="utf-8")
        print(f"Wrote {summary_path}")

        # 1b) Plain list of 226 names (one per line)
        list_path = out_dir / "inactive_raiders_to_add.txt"
        list_path.write_text(
            f"# List of {len(unlinked_names)} raiders to be added (one account each)\n# Generated by diff_inactive_tic_loot_dry_run.py --write\n\n" + "\n".join(sorted(unlinked_names)),
            encoding="utf-8",
        )
        print(f"Wrote {list_path}")

        # 2) Apply SQL (one account per unlinked raider)
        apply_path = out_dir / "apply_inactive_raiders.sql"
        apply_lines = [
            "-- Apply: one account per unlinked raider + characters + character_account + missing tics",
            "-- Run in Supabase SQL Editor. Then: SELECT refresh_dkp_summary();",
            "",
            "BEGIN;",
            "",
            "-- 1) One account per unlinked raider (account_id = synthetic id, display_name = character name)",
            "INSERT INTO accounts (account_id, char_ids, toon_names, toon_count, display_name) VALUES",
            ]
        account_values = [f"  ('{_sql_escape(name_to_synthetic_cid[n])}', NULL, NULL, 1, '{_sql_escape(n)}')" for n in sorted(unlinked_names)]
        apply_lines.append(",\n".join(account_values))
        apply_lines.append("ON CONFLICT (account_id) DO NOTHING;")
        apply_lines.append("")
        apply_lines.append("-- 2) One character per unlinked name")
        apply_lines.append("INSERT INTO characters (char_id, name) VALUES")
        char_values = [f"  ('{_sql_escape(name_to_synthetic_cid[n])}', '{_sql_escape(n)}')" for n in sorted(unlinked_names)]
        apply_lines.append(",\n".join(char_values))
        apply_lines.append("ON CONFLICT (char_id) DO NOTHING;")
        apply_lines.append("")
        apply_lines.append("-- 3) Link each character to its own account")
        apply_lines.append("INSERT INTO character_account (char_id, account_id) VALUES")
        ca_values = [f"  ('{_sql_escape(name_to_synthetic_cid[n])}', '{_sql_escape(name_to_synthetic_cid[n])}')" for n in sorted(unlinked_names)]
        apply_lines.append(",\n".join(ca_values))
        apply_lines.append("ON CONFLICT (char_id, account_id) DO NOTHING;")

        if to_add_tics:
            apply_lines.extend([
                "",
                "-- 4) Missing tics (in CSV, not in DB)",
                "INSERT INTO raid_event_attendance (raid_id, event_id, char_id, character_name) VALUES",
                ])
            tic_values = [f"  ('{_sql_escape(t[0])}', '{_sql_escape(t[1])}', '{_sql_escape(t[2])}', '{_sql_escape(t[3])}')" for t in to_add_tics]
            apply_lines.append(",\n".join(tic_values))
            apply_lines.append(";")

        apply_lines.extend(["", "COMMIT;", ""])
        apply_path.write_text("\n".join(apply_lines), encoding="utf-8")
        print(f"Wrote {apply_path}")

        # 3) Unapply SQL (reverse order)
        unapply_path = out_dir / "unapply_inactive_raiders.sql"
        unapply_lines = [
            "-- Unapply: remove what apply_inactive_raiders.sql added (reverse order)",
            "-- Run in Supabase SQL Editor. Then: SELECT refresh_dkp_summary();",
            "",
            "BEGIN;",
            "",
            ]

        if to_add_tics:
            unapply_lines.append("-- 1) Remove added tics (match exact rows)")
            unapply_lines.append("DELETE FROM raid_event_attendance WHERE (raid_id, event_id, COALESCE(char_id,''), COALESCE(character_name,'')) IN (")
            tic_in_values = [f"  ('{_sql_escape(t[0])}', '{_sql_escape(t[1])}', '{_sql_escape(t[2])}', '{_sql_escape(t[3])}')" for t in to_add_tics]
            unapply_lines.append(",\n".join(tic_in_values))
            unapply_lines.append(");")
            unapply_lines.append("")

        unapply_lines.append("-- 2) Unlink characters from their accounts")
        unapply_lines.append("DELETE FROM character_account WHERE account_id IN (")
        unapply_lines.append(",\n".join(f"  '{_sql_escape(name_to_synthetic_cid[n])}'" for n in sorted(unlinked_names)))
        unapply_lines.append(");")
        unapply_lines.append("")
        unapply_lines.append("-- 3) Remove synthetic characters")
        unapply_lines.append("DELETE FROM characters WHERE char_id IN (")
        unapply_lines.append(",\n".join(f"  '{_sql_escape(name_to_synthetic_cid[n])}'" for n in sorted(unlinked_names)))
        unapply_lines.append(");")
        unapply_lines.append("")
        unapply_lines.append("-- 4) Remove per-raider accounts")
        unapply_lines.append("DELETE FROM accounts WHERE account_id IN (")
        unapply_lines.append(",\n".join(f"  '{_sql_escape(name_to_synthetic_cid[n])}'" for n in sorted(unlinked_names)))
        unapply_lines.append(");")
        unapply_lines.extend(["", "COMMIT;", ""])
        unapply_path.write_text("\n".join(unapply_lines), encoding="utf-8")
        print(f"Wrote {unapply_path}")

    return 0


if __name__ == "__main__":
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    sys.exit(main())

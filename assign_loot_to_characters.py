#!/usr/bin/env python3
"""
Assign raid_loot to the character that actually has the item (from Magelo inventory).

Rules:
- Only assign rows that do not already have assigned_char_id/assigned_character_name set
  (unless --clear-assignments: then recompute all).
- For each loot row on an account: check all characters on that account for that item.
- Cap per toon per item: use the **number of that item on that toon in Magelo** (so if they have 2x on Magelo we can assign up to 2; if 1x then 1). No lore tag.
- Among toons that have the item and are under their Magelo cap: assign to the toon with the **most DKP spent**
  (aggregate cost of loot already assigned to that toon this run). Tie-break: most items assigned, then stable.
- If no toon has it -> leave unassigned (do not default to buyer/namesake).
- Elemental loot: use magelo/elemental_armor.json (item_ids that are elemental armor).
  A loot row is treated as elemental when its item name matches a name seen in Magelo
  inventory for an item_id in that JSON. Then we match any toon on the account that has
  any elemental armor (by item_id).

Inputs:
- DKP data: data/raid_loot.csv, data/raids.csv, data/character_account.csv, data/characters.csv, data/accounts.csv
- Magelo: character/TAKP_character.txt, inventory/TAKP_character_inventory.txt (or --magelo-dir)
- Elemental: magelo/elemental_armor.json (or --elemental-armor-json)

Outputs:
- data/raid_loot.csv with assigned_char_id, assigned_character_name
- data/character_loot_assignment_counts.csv (char_id, character_name, items_assigned)
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path
from collections import defaultdict
from typing import Optional

# Default paths relative to dkp repo
SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"
# Magelo repo may be sibling of dkp
MAGELO_DIR = SCRIPT_DIR.parent / "magelo"

def normalize_item_name(s: str) -> str:
    """Lowercase, strip, collapse spaces for matching."""
    if not s:
        return ""
    return " ".join(re.split(r"\s+", s.strip().lower()))


def load_raids(data_dir: Path) -> dict[str, str]:
    """raid_id -> date_iso."""
    path = data_dir / "raids.csv"
    if not path.exists():
        return {}
    out = {}
    with open(path, "r", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            out[row["raid_id"]] = (row.get("date_iso") or "").strip()
    return out


def load_character_account(data_dir: Path) -> tuple[dict[str, str], dict[str, list[str]]]:
    """char_id -> account_id; account_id -> [char_id, ...]."""
    path = data_dir / "character_account.csv"
    c2a = {}
    a2c = defaultdict(list)
    if not path.exists():
        return c2a, dict(a2c)
    with open(path, "r", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cid = (row.get("char_id") or "").strip()
            aid = (row.get("account_id") or "").strip()
            if cid and aid:
                c2a[cid] = aid
                a2c[aid].append(cid)
    return c2a, {k: list(v) for k, v in a2c.items()}


def load_characters(data_dir: Path) -> tuple[dict[str, str], dict[str, str]]:
    """(name -> char_id for lookup, char_id -> name for display)."""
    path = data_dir / "characters.csv"
    name_to_cid = {}
    cid_to_name = {}
    if not path.exists():
        return name_to_cid, cid_to_name
    with open(path, "r", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            name = (row.get("name") or "").strip()
            cid = (row.get("char_id") or "").strip()
            if name and cid:
                name_to_cid[name] = cid
                name_to_cid[normalize_item_name(name)] = cid
                cid_to_name[cid] = name
    return name_to_cid, cid_to_name


def load_raid_loot(data_dir: Path) -> list[dict]:
    """List of loot rows (with keys raid_id, event_id, item_name, char_id, character_name, cost)."""
    path = data_dir / "raid_loot.csv"
    if not path.exists():
        return []
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            # Keep only known columns; strip strings (allow missing assigned_* on first run)
            out = {k: (v.strip() if isinstance(v, str) else v) for k, v in row.items()}
            rows.append(out)
    return rows


def load_magelo_character_file(char_file: Path) -> tuple[dict[str, str], dict[str, str]]:
    """(name -> char_id, char_id -> name) for all characters in the dump."""
    name_to_id = {}
    id_to_name = {}
    if not char_file.exists():
        return name_to_id, id_to_name
    with open(char_file, "r", encoding="utf-8") as f:
        next(f)  # header
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) >= 9:
                name = parts[0].strip()
                cid = parts[8].strip()
                if name and cid:
                    name_to_id[name] = cid
                    id_to_name[cid] = name
    return name_to_id, id_to_name


def load_magelo_inventory(inv_file: Path) -> dict[str, list[dict]]:
    """char_id -> [ {item_id, item_name}, ... ] (all slots)."""
    inv: dict[str, list[dict]] = defaultdict(list)
    if not inv_file.exists():
        return dict(inv)
    with open(inv_file, "r", encoding="utf-8") as f:
        next(f)  # header
        for line in f:
            parts = line.strip().split("\t")
            if len(parts) < 4:
                continue
            cid = parts[0].strip()
            item_id = parts[2].strip()
            item_name = (parts[3] if len(parts) > 3 else "").strip()
            if cid:
                inv[cid].append({"item_id": item_id, "item_name": item_name})
    return dict(inv)


def load_elemental_armor(json_path: Path) -> set[str]:
    """Set of item_id (str) that are elemental armor (from magelo/elemental_armor.json)."""
    if not json_path.exists():
        return set()
    data = json.loads(json_path.read_text(encoding="utf-8"))
    return set(str(k) for k in data) if isinstance(data, dict) else set()


def build_elemental_item_names(
    magelo_inv: dict[str, list[dict]],
    elemental_item_ids: set[str],
    extra_names: Optional[list[str]] = None,
) -> frozenset[str]:
    """
    Set of normalized item names that count as elemental loot.
    Derived from Magelo inventory: any item whose item_id is in elemental_armor.json.
    Optional extra_names (e.g. from CLI) are added for names that may not appear in the dump.
    """
    names: set[str] = set()
    for _cid, items in magelo_inv.items():
        for it in items:
            if (it.get("item_id") or "").strip() in elemental_item_ids:
                name = (it.get("item_name") or "").strip()
                if name:
                    names.add(normalize_item_name(name))
    if extra_names:
        for n in extra_names:
            if n and n.strip():
                names.add(normalize_item_name(n.strip()))
    return frozenset(names)


def resolve_buyer_account(
    row: dict,
    char_to_account: dict[str, str],
    name_to_char: dict[str, str],
) -> Optional[str]:
    """Get account_id for the buyer (char_id or character_name) of this loot row."""
    cid = (row.get("char_id") or "").strip()
    name = (row.get("character_name") or "").strip()
    if cid and cid in char_to_account:
        return char_to_account[cid]
    if name:
        cid_from_name = name_to_char.get(name) or name_to_char.get(normalize_item_name(name))
        if cid_from_name and cid_from_name in char_to_account:
            return char_to_account[cid_from_name]
    return None


def which_toons_have_item(
    item_name: str,
    account_char_ids: list[str],
    magelo_inv: dict[str, list[dict]],
    elemental_item_ids: set[str],
    elemental_source_names: frozenset[str],
    dkp_to_magelo_id: Optional[dict[str, str]] = None,
) -> list[str]:
    """
    Return list of DKP char_ids on this account that have this item (by name or by elemental match).
    Uses dkp_to_magelo_id to look up Magelo inventory when DKP and Magelo use different char_id schemes.
    """
    norm_loot = normalize_item_name(item_name)
    is_elemental_source = norm_loot in {normalize_item_name(n) for n in elemental_source_names}
    d2m = dkp_to_magelo_id or {}

    candidates = []
    for cid in account_char_ids:
        magelo_id = d2m.get(cid) or cid  # use Magelo id for inventory lookup if we have a mapping
        items = magelo_inv.get(magelo_id, [])
        for it in items:
            inv_item_id = (it.get("item_id") or "").strip()
            inv_item_name = (it.get("item_name") or "").strip()
            if is_elemental_source:
                if inv_item_id in elemental_item_ids:
                    candidates.append(cid)
                    break
            else:
                if normalize_item_name(inv_item_name) == norm_loot:
                    candidates.append(cid)
                    break
    return candidates


def item_count_per_toon(
    item_name: str,
    account_char_ids: list[str],
    magelo_inv: dict[str, list[dict]],
    elemental_item_ids: set[str],
    elemental_source_names: frozenset[str],
    dkp_to_magelo_id: Optional[dict[str, str]] = None,
) -> dict[str, int]:
    """
    Return for each DKP char_id on this account the number of this item they have on Magelo.
    For elemental-source items: 1 if they have any matching elemental piece, else 0.
    For normal items: count of inventory slots with that item name.
    """
    norm_loot = normalize_item_name(item_name)
    is_elemental_source = norm_loot in {normalize_item_name(n) for n in elemental_source_names}
    d2m = dkp_to_magelo_id or {}
    out: dict[str, int] = {}
    for cid in account_char_ids:
        magelo_id = d2m.get(cid) or cid
        items = magelo_inv.get(magelo_id, [])
        if is_elemental_source:
            count = 0
            for it in items:
                if (it.get("item_id") or "").strip() in elemental_item_ids:
                    count = 1
                    break
            out[cid] = count
        else:
            count = sum(1 for it in items if normalize_item_name((it.get("item_name") or "").strip()) == norm_loot)
            out[cid] = count
    return out


def run(
    data_dir: Path,
    magelo_char_file: Path,
    magelo_inv_file: Path,
    elemental_json: Path,
    out_raid_loot: Path,
    out_counts: Path,
    elemental_extra_names: Optional[list[str]] = None,
    clear_assignments: bool = False,
) -> None:
    raids = load_raids(data_dir)
    char_to_account, account_to_chars = load_character_account(data_dir)
    name_to_char, dkp_char_id_to_name = load_characters(data_dir)
    loot_rows = load_raid_loot(data_dir)
    magelo_names_to_id, magelo_id_to_name = load_magelo_character_file(magelo_char_file)
    magelo_inv = load_magelo_inventory(magelo_inv_file)
    elemental_ids = load_elemental_armor(elemental_json)

    # Elemental loot: names derived from Magelo inventory (item_id in elemental_armor.json)
    elemental_source_norm = build_elemental_item_names(
        magelo_inv, elemental_ids, elemental_extra_names
    )

    # DKP roster and Magelo export often use different char_id schemes. Map DKP char_id -> Magelo id by name.
    dkp_to_magelo_id: dict[str, str] = {}
    for dkp_cid, name in dkp_char_id_to_name.items():
        magelo_id = magelo_names_to_id.get(name) or magelo_names_to_id.get(normalize_item_name(name))
        if magelo_id:
            dkp_to_magelo_id[dkp_cid] = magelo_id

    # Sort key for loot: (raid_date_iso, raid_id, event_id, index)
    def loot_sort_key(idx: int) -> tuple[str, str, str, int]:
        row = loot_rows[idx]
        rid = row.get("raid_id", "")
        date = raids.get(rid, "")
        ev = row.get("event_id", "")
        return (date, rid, ev, idx)

    # Group loot by account (buyer's account)
    loot_by_account: dict[str, list[int]] = defaultdict(list)
    for i, row in enumerate(loot_rows):
        acc = resolve_buyer_account(row, char_to_account, name_to_char)
        if acc:
            loot_by_account[acc].append(i)
        else:
            # No account found; treat as single-toon "account" (namesake only)
            cid = (row.get("char_id") or "").strip()
            name = (row.get("character_name") or "").strip()
            if cid:
                loot_by_account[cid].append(i)  # use char_id as fake account so we only have namesake
            elif name and name in name_to_char:
                loot_by_account[name_to_char[name]].append(i)
            else:
                loot_by_account["_unknown"].append(i)

    # Per-account assignment: process in raid order, maintain items_assigned per char.
    # Only assign rows that don't already have an assignment (we can't assign loot more than once).
    assigned_char_id: list[Optional[str]] = [None] * len(loot_rows)
    assigned_character_name: list[Optional[str]] = [None] * len(loot_rows)
    assigned_via_magelo: list[bool] = [False] * len(loot_rows)  # True if we found item on a toon (incl. namesake)

    # Preserve existing assignments from input (e.g. from Supabase) unless --clear-assignments.
    n_preserved = 0
    if not clear_assignments:
        for idx, row in enumerate(loot_rows):
            ac = (row.get("assigned_char_id") or "").strip()
            an = (row.get("assigned_character_name") or "").strip()
            if ac or an:
                assigned_char_id[idx] = ac or None
                assigned_character_name[idx] = an or None
                assigned_via_magelo[idx] = (row.get("assigned_via_magelo") or "").strip() == "1"
                n_preserved += 1

    for acc, indices in loot_by_account.items():
        # Sort by raid date then raid_id, event_id, index
        indices_sorted = sorted(indices, key=loot_sort_key)
        # Only "real" accounts have multiple toons; fake key (char_id or _unknown) has one
        account_toons = account_to_chars.get(acc)
        if not account_toons:
            account_toons = [acc] if acc != "_unknown" else []
        # Per-toon DKP spent (cost sum of assignments we make this run) and per-(toon, item) count for cap
        dkp_spent_per_char: dict[str, float] = defaultdict(float)
        count_per_char: dict[str, int] = defaultdict(int)
        item_count_per_char: dict[tuple[str, str], int] = defaultdict(int)  # (char_id, norm_item) -> count

        for idx in indices_sorted:
            # Skip rows that already have an assignment (only assign once per row) unless clear_assignments
            if not clear_assignments and (assigned_char_id[idx] or assigned_character_name[idx]):
                cid_existing = assigned_char_id[idx] or ""
                if cid_existing:
                    count_per_char[cid_existing] += 1
                    cost_val = float(loot_rows[idx].get("cost") or 0) or 0
                    dkp_spent_per_char[cid_existing] += cost_val
                    norm_item = normalize_item_name(loot_rows[idx].get("item_name") or "")
                    if norm_item:
                        item_count_per_char[(cid_existing, norm_item)] += 1
                continue
            row = loot_rows[idx]
            cid_buyer = (row.get("char_id") or "").strip()
            name_buyer = (row.get("character_name") or "").strip()
            item_name = (row.get("item_name") or "").strip()
            norm_item = normalize_item_name(item_name)
            cost_val = float(row.get("cost") or 0) or 0
            magelo_count_per_toon = item_count_per_toon(
                item_name,
                account_toons,
                magelo_inv,
                elemental_ids,
                elemental_source_norm,
                dkp_to_magelo_id,
            )

            if not account_toons:
                # Single-toon "account": leave unassigned so user can assign in UI
                continue

            candidates = which_toons_have_item(
                item_name,
                account_toons,
                magelo_inv,
                elemental_ids,
                elemental_source_norm,
                dkp_to_magelo_id,
            )

            if len(candidates) == 0:
                # No toon has item on Magelo: leave unassigned
                continue
            elif len(candidates) == 1:
                cid = candidates[0]
                cap = magelo_count_per_toon.get(cid, 0)
                if cap > 0 and item_count_per_char[(cid, norm_item)] < cap:
                    assigned_via_magelo[idx] = True
                    assigned_char_id[idx] = cid
                    assigned_character_name[idx] = dkp_char_id_to_name.get(cid) or magelo_id_to_name.get(dkp_to_magelo_id.get(cid, "")) or cid
                    count_per_char[cid] += 1
                    dkp_spent_per_char[cid] += cost_val
                    item_count_per_char[(cid, norm_item)] += 1
                else:
                    # Only one toon has the item and they're at cap (or 0 on Magelo); leave unassigned
                    continue
            else:
                # Multiple toons have the item: filter by Magelo cap, then choose by most DKP spent
                under_cap = [
                    c for c in candidates
                    if magelo_count_per_toon.get(c, 0) > 0 and item_count_per_char[(c, norm_item)] < magelo_count_per_toon.get(c, 0)
                ]
                if not under_cap:
                    # Multiple toons have item but all at cap; leave unassigned
                    continue
                else:
                    assigned_via_magelo[idx] = True
                    best = max(under_cap, key=lambda c: (dkp_spent_per_char[c], count_per_char[c], c))
                    assigned_char_id[idx] = best
                    assigned_character_name[idx] = dkp_char_id_to_name.get(best) or magelo_id_to_name.get(dkp_to_magelo_id.get(best, "")) or best
                    count_per_char[best] += 1
                    dkp_spent_per_char[best] += cost_val
                    item_count_per_char[(best, norm_item)] += 1

    # Resolve assigned_character_name from DKP characters or Magelo
    for idx in range(len(loot_rows)):
        if assigned_character_name[idx]:
            continue
        cid = assigned_char_id[idx]
        if cid:
            assigned_character_name[idx] = dkp_char_id_to_name.get(cid) or magelo_id_to_name.get(dkp_to_magelo_id.get(cid, "")) or magelo_id_to_name.get(cid)
            if not assigned_character_name[idx]:
                for name, c in name_to_char.items():
                    if c == cid and name and not name.isdigit():
                        assigned_character_name[idx] = name
                        break
            if not assigned_character_name[idx]:
                assigned_character_name[idx] = cid

    # Write updated raid_loot.csv (include id if present so we can UPDATE Supabase by id, not insert duplicates)
    fieldnames = ["raid_id", "event_id", "item_name", "char_id", "character_name", "cost",
                  "assigned_char_id", "assigned_character_name", "assigned_via_magelo"]
    if loot_rows and "id" in loot_rows[0]:
        fieldnames = ["id"] + [f for f in fieldnames if f != "id"]
    with open(out_raid_loot, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        for i, row in enumerate(loot_rows):
            row_out = dict(row)
            row_out["assigned_char_id"] = assigned_char_id[i] or ""
            row_out["assigned_character_name"] = assigned_character_name[i] or ""
            row_out["assigned_via_magelo"] = "1" if assigned_via_magelo[i] else "0"
            w.writerow(row_out)

    # Aggregate counts (all accounts)
    count_global: dict[str, int] = defaultdict(int)
    name_by_cid: dict[str, str] = {}
    for i in range(len(loot_rows)):
        cid = assigned_char_id[i]
        name = assigned_character_name[i]
        if cid:
            count_global[cid] += 1
            if name:
                name_by_cid[cid] = name
    for cid, name in dkp_char_id_to_name.items():
        name_by_cid.setdefault(cid, name)
    for name, cid in name_to_char.items():
        if name and not name.isdigit():
            name_by_cid.setdefault(cid, name)

    counts_rows = [
        {"char_id": cid, "character_name": name_by_cid.get(cid, cid), "items_assigned": count}
        for cid, count in sorted(count_global.items(), key=lambda x: -x[1])
    ]
    with open(out_counts, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["char_id", "character_name", "items_assigned"])
        w.writeheader()
        w.writerows(counts_rows)

    n_new = len(loot_rows) - n_preserved
    print(f"Wrote {out_raid_loot} with assigned_char_id, assigned_character_name")
    print(f"Preserved {n_preserved} existing assignments; assigned {n_new} new.")
    print(f"Wrote {out_counts} ({len(counts_rows)} characters with assigned loot)")


def main() -> int:
    ap = argparse.ArgumentParser(description="Assign raid loot to character that has the item (Magelo).")
    ap.add_argument("--data-dir", type=Path, default=DATA_DIR, help="DKP data directory")
    ap.add_argument("--magelo-dir", type=Path, default=MAGELO_DIR,
                    help="Magelo repo root (character/ and inventory/ inside)")
    ap.add_argument("--character-file", type=Path, default=None,
                    help="Override: path to TAKP_character.txt")
    ap.add_argument("--inventory-file", type=Path, default=None,
                    help="Override: path to TAKP_character_inventory.txt")
    ap.add_argument("--elemental-armor-json", type=Path, default=None,
                    help="Override: path to elemental_armor.json")
    ap.add_argument("--out-raid-loot", type=Path, default=DATA_DIR / "raid_loot.csv",
                    help="Output raid_loot CSV path")
    ap.add_argument("--out-counts", type=Path, default=DATA_DIR / "character_loot_assignment_counts.csv",
                    help="Output assignment counts CSV path")
    ap.add_argument("--elemental-source-name", action="append", dest="elemental_extra",
                    help="Extra item name to treat as elemental (if not seen in Magelo dump; can repeat)")
    ap.add_argument("--clear-assignments", action="store_true",
                    help="Ignore existing assignments and recompute all (for full redo)")
    args = ap.parse_args()

    magelo = args.magelo_dir
    char_file = args.character_file or magelo / "character" / "TAKP_character.txt"
    inv_file = args.inventory_file or magelo / "inventory" / "TAKP_character_inventory.txt"
    elem_json = args.elemental_armor_json or magelo / "elemental_armor.json"

    if not char_file.exists():
        print(f"Missing Magelo character file: {char_file}", file=sys.stderr)
        return 1
    if not inv_file.exists():
        print(f"Missing Magelo inventory file: {inv_file}", file=sys.stderr)
        return 1

    run(
        data_dir=args.data_dir,
        magelo_char_file=char_file,
        magelo_inv_file=inv_file,
        elemental_json=elem_json,
        out_raid_loot=args.out_raid_loot,
        out_counts=args.out_counts,
        elemental_extra_names=args.elemental_extra,
        clear_assignments=args.clear_assignments,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

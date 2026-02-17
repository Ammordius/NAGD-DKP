#!/usr/bin/env python3
"""
Assign raid_loot to the character that actually has the item (from Magelo inventory).

Rules:
- Only assign rows that do not already have assigned_char_id/assigned_character_name set
  (unless --clear-assignments: then recompute all). If unassigned (assigned_* empty), we run
  assignment. Rows with assigned_via_magelo=0 and an existing assignment are preserved when not
  --clear-assignments (manual in Loot tab); rows with assigned_via_magelo=0 but no assignment are
  treated as unassigned and get assigned. manual_assignment=1 rows are always preserved.
- For each loot row on an account: check all characters on that account for that item.
- Cap per toon per item: use the **number of that item on that toon in Magelo** (so if they have 2x on Magelo we can assign up to 2; if 1x then 1). No lore tag.
- Among toons that have the item and are under their Magelo cap: assign to the toon with the **most DKP spent**
  (aggregate cost of loot already assigned to that toon this run). Tie-break: most items assigned, then stable.
- If no toon has it -> leave unassigned (do not default to buyer/namesake).
- Elemental loot: use magelo/elemental_armor.json. Treated as elemental when item name
  matches that list. Assignment is class- and slot-specific: e.g. Elemental Silk Boot Pattern
  only matches toons who can wear silk and have silk elemental in the feet slot; Elemental Boot
  Mold only matches toons who have elemental in the feet slot for their class (plate/chain/leather/silk).
  Wrists->wrists, feet->feet, etc. Class armor: chain (rog/shm/rng), plate (brd/clr/war/pal/shd),
  leather (mnk/bst/dru), silk (nec/mag/wiz/enc).
- Rows with manual_assignment=1 (or manual=1) are never reassigned, even with --clear-assignments.

Inputs:
- DKP data: data/raid_loot.csv, data/raids.csv, data/character_account.csv, data/characters.csv, data/accounts.csv
  To preserve existing assignments (manual or from a previous run), raid_loot.csv must already
  contain assigned_char_id/assigned_character_name. For manual runs: fetch from Supabase first:
  python fetch_raid_loot_from_supabase.py --out data/raid_loot.csv --all-tables
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

# Elemental armor item_id -> armor type (class-specific). Only these IDs are filtered by class.
# chain: rog, shm, rng | plate: brd, clr, war, pal, shd | leather: mnk, bst, dru | silk: nec, mag, wiz, enc
ELEMENTAL_ARMOR_TYPE: dict[str, str] = {}
for i in range(16362, 16369):
    ELEMENTAL_ARMOR_TYPE[str(i)] = "chain"
for i in range(16369, 16376):
    ELEMENTAL_ARMOR_TYPE[str(i)] = "plate"
for i in range(16376, 16383):
    ELEMENTAL_ARMOR_TYPE[str(i)] = "leather"
for i in range(16383, 16390):
    ELEMENTAL_ARMOR_TYPE[str(i)] = "silk"
ELEMENTAL_ARMOR_TYPE["16693"] = "silk"

# Class (short name) -> armor type that class can use for elemental
CLASS_ARMOR_TYPE: dict[str, str] = {
    "rog": "chain", "shm": "chain", "rng": "chain",
    "brd": "plate", "clr": "plate", "war": "plate", "pal": "plate", "shd": "plate",
    "mnk": "leather", "bst": "leather", "dru": "leather",
    "nec": "silk", "mag": "silk", "wiz": "silk", "enc": "silk",
}

# Fallback: loot name slot keywords -> EQ slot_id(s) when dkp_elemental_to_magelo.json not used
ELEMENTAL_SLOT_KEYWORDS: dict[str, list[int]] = {
    "head": [2], "helm": [2], "turban": [2], "coif": [2],
    "neck": [5], "gorget": [5],
    "arms": [7], "sleeve": [7], "arm": [7],
    "back": [8], "cloak": [8],
    "bracer": [9, 10], "wrist": [9, 10], "bracelet": [9, 10],
    "hands": [12], "hand": [12], "glove": [12], "gauntlet": [12],
    "chest": [17], "tunic": [17], "breast": [17], "breastplate": [17],
    "legs": [18], "leg": [18], "greave": [18], "pant": [18],
    "feet": [19], "boot": [19],
    "waist": [20], "girdle": [20],
}

# Loot name (normalized) -> list of Magelo item names (normalized) that count as "having" this loot.
# Used when a DKP item is turned in / upgraded (e.g. Soul Essence -> Talisman of Vah Kerrath).
LOOT_TO_MAGELO_EQUIVALENTS: dict[str, list[str]] = {
    "soul essence of aten ha ra": ["talisman of vah kerrath"],
}


def normalize_item_name(s: str) -> str:
    """Lowercase, strip, collapse spaces for matching."""
    if not s:
        return ""
    return " ".join(re.split(r"\s+", s.strip().lower()))


def parse_elemental_loot_slot_and_armor(item_name: str) -> tuple[Optional[str], Optional[list[int]]]:
    """
    Parse an elemental loot item name to (armor_type, slot_ids).
    - armor_type: 'silk'|'chain'|'plate'|'leather', or None for molds (match toon's class).
    - slot_ids: EQ slot_id list (e.g. [19] for feet, [9,10] for bracer), or None if not determined.
    Returns (None, None) if the name doesn't look like elemental slot-specific loot.
    """
    norm = normalize_item_name(item_name)
    if "elemental" not in norm:
        return (None, None)
    armor_type: Optional[str] = None
    for at in ("silk", "chain", "plate", "leather"):
        if at in norm:
            armor_type = at
            break
    slot_ids: Optional[list[int]] = None
    for keyword, sids in ELEMENTAL_SLOT_KEYWORDS.items():
        if keyword in norm:
            slot_ids = sids
            break
    return (armor_type, slot_ids)


def class_to_short(cls: str) -> str:
    """Map class name (e.g. from characters.csv) to short form for CLASS_ARMOR_TYPE."""
    if not cls:
        return ""
    c = cls.strip().lower().replace(" ", "")
    # map full names / variants to 3-letter
    m = {
        "rogue": "rog", "shaman": "shm", "ranger": "rng",
        "bard": "brd", "cleric": "clr", "warrior": "war", "paladin": "pal", "shadowknight": "shd",
        "monk": "mnk", "beastlord": "bst", "druid": "dru",
        "necromancer": "nec", "magician": "mag", "wizard": "wiz", "enchanter": "enc",
    }
    return m.get(c, c[:3] if len(c) >= 3 else c)


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


def load_character_classes(data_dir: Path) -> dict[str, str]:
    """char_id -> class short (e.g. 'war', 'mag') for elemental class filtering."""
    path = data_dir / "characters.csv"
    out: dict[str, str] = {}
    if not path.exists():
        return out
    cls_col = "class_name"  # characters.csv uses class_name
    with open(path, "r", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            cid = (row.get("char_id") or "").strip()
            cls = (row.get(cls_col) or row.get("class") or "").strip()
            if cid and cls:
                out[cid] = class_to_short(cls)
    return out


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
    """(name -> char_id, char_id -> name) for all characters in the dump.
    Registers both raw and normalized name so DKP->Magelo mapping works when casing differs."""
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
                    name_to_id[normalize_item_name(name)] = cid
                    id_to_name[cid] = name
    return name_to_id, id_to_name


def load_magelo_inventory(inv_file: Path) -> dict[str, list[dict]]:
    """char_id -> [ {item_id, item_name, slot_id}, ... ] (all slots). slot_id is EQ equipment slot (e.g. 19=feet)."""
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
            slot_id = (parts[1] if len(parts) > 1 else "").strip()
            item_id = parts[2].strip()
            item_name = (parts[3] if len(parts) > 3 else "").strip()
            if cid:
                inv[cid].append({"item_id": item_id, "item_name": item_name, "slot_id": slot_id})
    return dict(inv)


def load_elemental_armor(json_path: Path) -> set[str]:
    """Set of item_id (str) that are elemental armor (from magelo/elemental_armor.json)."""
    if not json_path.exists():
        return set()
    data = json.loads(json_path.read_text(encoding="utf-8"))
    return set(str(k) for k in data) if isinstance(data, dict) else set()


def load_dkp_elemental_map(json_path: Path) -> tuple[dict[str, dict], frozenset[str]]:
    """
    Load dkp_elemental_to_magelo.json. Returns:
    - name_to_lookup: normalized loot name -> { "magelo_item_ids_by_class": { "brd": "19549", ... } }
    - elemental_names: frozenset of normalized names that are elemental (for elemental_source_names).
    Matching is by item ID only: toon has the Magelo item_id for their class.
    """
    out_map: dict[str, dict] = {}
    names_set: set[str] = set()
    if not json_path.exists():
        return (out_map, frozenset())
    data = json.loads(json_path.read_text(encoding="utf-8"))
    purchases = data.get("dkp_purchases") or {}
    for _id, entry in purchases.items():
        if not isinstance(entry, dict):
            continue
        name = (entry.get("name") or "").strip()
        if not name:
            continue
        norm = normalize_item_name(name)
        names_set.add(norm)
        magelo_by_class = entry.get("magelo_item_ids_by_class")
        if isinstance(magelo_by_class, dict):
            magelo_by_class = {str(k).lower(): str(v) for k, v in magelo_by_class.items()}
        else:
            magelo_by_class = {}
        out_map[norm] = {"magelo_item_ids_by_class": magelo_by_class}
    return (out_map, frozenset(names_set))


def build_elemental_item_names(
    magelo_inv: dict[str, list[dict]],
    elemental_item_ids: set[str],
    extra_names: Optional[list[str]] = None,
) -> frozenset[str]:
    """
    Set of normalized item names that count as elemental loot.
    Derived from Magelo inventory: any item whose item_id is in elemental_armor.json.
    The list can include both armor piece IDs and mold/pattern IDs (Elemental Boot Mold, etc.).
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
    elemental_id_to_armor: Optional[dict[str, str]] = None,
    char_id_to_class: Optional[dict[str, str]] = None,
    required_armor_type: Optional[str] = None,
    required_slot_ids: Optional[list[int]] = None,
    elemental_lookup: Optional[dict] = None,
) -> list[str]:
    """
    Return list of DKP char_ids on this account that have this item (by name or by elemental match).
    When elemental_lookup is set (from dkp_elemental_to_magelo.json): toon must have the exact
    magelo item_id for their class (item ID is all we need). Otherwise use required_armor_type +
    required_slot_ids (and elemental_item_ids / armor type).
    """
    norm_loot = normalize_item_name(item_name)
    magelo_names_to_match = {norm_loot} | set(LOOT_TO_MAGELO_EQUIVALENTS.get(norm_loot, []))
    is_elemental_source = norm_loot in elemental_source_names
    d2m = dkp_to_magelo_id or {}
    id_to_armor = elemental_id_to_armor or {}
    cid_to_cls = char_id_to_class or {}
    use_json_match = elemental_lookup is not None and is_elemental_source
    magelo_by_class = (elemental_lookup or {}).get("magelo_item_ids_by_class") or {}
    slot_filter = required_slot_ids is not None and len(required_slot_ids) > 0
    req_slots = required_slot_ids or []

    candidates = []
    for cid in account_char_ids:
        magelo_id = d2m.get(cid) or cid
        items = magelo_inv.get(magelo_id, [])
        class_short = (cid_to_cls.get(cid) or "").lower()
        allowed_armor = CLASS_ARMOR_TYPE.get(class_short) if cid_to_cls else None
        for it in items:
            inv_item_id = (it.get("item_id") or "").strip()
            inv_item_name = (it.get("item_name") or "").strip()
            if is_elemental_source:
                if use_json_match:
                    # Match by exact magelo item_id for this toon's class (item ID is all we need)
                    expected_id = magelo_by_class.get(class_short)
                    if expected_id and inv_item_id == expected_id:
                        candidates.append(cid)
                        break
                    continue
                else:
                    if inv_item_id not in elemental_item_ids:
                        continue
                    item_armor = id_to_armor.get(inv_item_id)
                    if slot_filter:
                        try:
                            inv_slot = int((it.get("slot_id") or "").strip() or 0)
                        except (ValueError, TypeError):
                            inv_slot = 0
                        if inv_slot not in req_slots:
                            continue
                    if required_armor_type is not None:
                        if item_armor != required_armor_type:
                            continue
                    else:
                        if item_armor is not None and allowed_armor is not None and item_armor != allowed_armor:
                            continue
                    candidates.append(cid)
                    break
            else:
                if normalize_item_name(inv_item_name) in magelo_names_to_match:
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
    elemental_id_to_armor: Optional[dict[str, str]] = None,
    char_id_to_class: Optional[dict[str, str]] = None,
    required_armor_type: Optional[str] = None,
    required_slot_ids: Optional[list[int]] = None,
    elemental_lookup: Optional[dict] = None,
) -> dict[str, int]:
    """
    Return for each DKP char_id on this account the number of this item they have on Magelo.
    When elemental_lookup is set: count how many times they have the magelo item_id for their class (e.g. 2 bracers = 2).
    """
    norm_loot = normalize_item_name(item_name)
    magelo_names_to_match = {norm_loot} | set(LOOT_TO_MAGELO_EQUIVALENTS.get(norm_loot, []))
    is_elemental_source = norm_loot in elemental_source_names
    d2m = dkp_to_magelo_id or {}
    id_to_armor = elemental_id_to_armor or {}
    cid_to_cls = char_id_to_class or {}
    use_json_match = elemental_lookup is not None and is_elemental_source
    magelo_by_class = (elemental_lookup or {}).get("magelo_item_ids_by_class") or {}
    slot_filter = required_slot_ids is not None and len(required_slot_ids) > 0
    req_slots = required_slot_ids or []
    out: dict[str, int] = {}
    for cid in account_char_ids:
        magelo_id = d2m.get(cid) or cid
        items = magelo_inv.get(magelo_id, [])
        if is_elemental_source:
            class_short = (cid_to_cls.get(cid) or "").lower()
            allowed_armor = CLASS_ARMOR_TYPE.get(class_short) if cid_to_cls else None
            count = 0
            for it in items:
                inv_item_id = (it.get("item_id") or "").strip()
                if use_json_match:
                    expected_id = magelo_by_class.get(class_short)
                    if expected_id and inv_item_id == expected_id:
                        count += 1
                    continue
                if inv_item_id not in elemental_item_ids:
                    continue
                if slot_filter:
                    try:
                        inv_slot = int((it.get("slot_id") or "").strip() or 0)
                    except (ValueError, TypeError):
                        inv_slot = 0
                    if inv_slot not in req_slots:
                        continue
                item_armor = id_to_armor.get(inv_item_id)
                if required_armor_type is not None:
                    if item_armor != required_armor_type:
                        continue
                else:
                    if item_armor is not None and allowed_armor is not None and item_armor != allowed_armor:
                        continue
                count = 1
                break
            out[cid] = count
        else:
            count = sum(1 for it in items if normalize_item_name((it.get("item_name") or "").strip()) in magelo_names_to_match)
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
    dkp_elemental_json: Optional[Path] = None,
) -> None:
    raids = load_raids(data_dir)
    char_to_account, account_to_chars = load_character_account(data_dir)
    name_to_char, dkp_char_id_to_name = load_characters(data_dir)
    char_id_to_class = load_character_classes(data_dir)
    loot_rows = load_raid_loot(data_dir)
    magelo_names_to_id, magelo_id_to_name = load_magelo_character_file(magelo_char_file)
    magelo_inv = load_magelo_inventory(magelo_inv_file)
    elemental_ids = load_elemental_armor(elemental_json)

    # Elemental loot: when dkp_elemental_to_magelo.json is present, use it (item IDs only). Else names from Magelo.
    dkp_elemental_map: dict[str, dict] = {}
    elemental_names_from_json: frozenset[str] = frozenset()
    if dkp_elemental_json and dkp_elemental_json.exists():
        dkp_elemental_map, elemental_names_from_json = load_dkp_elemental_map(dkp_elemental_json)
    elemental_source_norm = build_elemental_item_names(
        magelo_inv, elemental_ids, elemental_extra_names
    )
    if elemental_names_from_json:
        elemental_source_norm = elemental_source_norm | elemental_names_from_json

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

    # Rows explicitly marked manual_assignment=1 (or manual=1): never reassign, even with --clear-assignments.
    # Rows with assigned_via_magelo=0 and (ac or an) set: preserve when not --clear-assignments (manual in UI or legacy).
    # Rows with assigned_via_magelo=0 but no assigned char/name: treat as unassigned and run assignment below.
    manual_only_indices: set[int] = set()
    n_preserved = 0
    for idx, row in enumerate(loot_rows):
        ac = (row.get("assigned_char_id") or "").strip()
        an = (row.get("assigned_character_name") or "").strip()
        via_magelo_raw = (row.get("assigned_via_magelo") or "").strip()
        manual_col = (row.get("manual_assignment") or row.get("manual") or "").strip().lower()
        is_explicit_manual = manual_col in ("1", "true", "yes")
        has_existing_assignment = bool(ac or an)
        is_legacy_manual = via_magelo_raw == "0"
        if is_explicit_manual:
            # User honestly set this in UI; never overwrite
            assigned_char_id[idx] = ac or None
            assigned_character_name[idx] = an or None
            assigned_via_magelo[idx] = False
            manual_only_indices.add(idx)
            n_preserved += 1
        elif is_legacy_manual and has_existing_assignment and not clear_assignments:
            # Preserve only when there is an actual assignment (manual in UI or legacy); unassigned (ac/an empty) will be assigned below
            assigned_char_id[idx] = ac or None
            assigned_character_name[idx] = an or None
            assigned_via_magelo[idx] = via_magelo_raw == "1"
            manual_only_indices.add(idx)
            n_preserved += 1
        elif has_existing_assignment and not clear_assignments:
            assigned_char_id[idx] = ac or None
            assigned_character_name[idx] = an or None
            assigned_via_magelo[idx] = via_magelo_raw == "1"
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
            # Skip rows that already have an assignment or were manually set (Loot tab); do not overwrite
            if idx in manual_only_indices:
                continue
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
            # Elemental: use dkp_elemental_to_magelo.json (item ID per class) when available; else fallback slot/armor parse
            elemental_lookup = dkp_elemental_map.get(norm_item) if dkp_elemental_map else None
            if elemental_lookup is None and norm_item in elemental_source_norm:
                req_armor, req_slots = parse_elemental_loot_slot_and_armor(item_name)
            else:
                req_armor, req_slots = None, None
            magelo_count_per_toon = item_count_per_toon(
                item_name,
                account_toons,
                magelo_inv,
                elemental_ids,
                elemental_source_norm,
                dkp_to_magelo_id,
                elemental_id_to_armor=ELEMENTAL_ARMOR_TYPE,
                char_id_to_class=char_id_to_class,
                required_armor_type=req_armor,
                required_slot_ids=req_slots,
                elemental_lookup=elemental_lookup,
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
                elemental_id_to_armor=ELEMENTAL_ARMOR_TYPE,
                char_id_to_class=char_id_to_class,
                required_armor_type=req_armor,
                required_slot_ids=req_slots,
                elemental_lookup=elemental_lookup,
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

    # Write updated raid_loot.csv (include id, manual_assignment if present)
    fieldnames = ["raid_id", "event_id", "item_name", "char_id", "character_name", "cost",
                  "assigned_char_id", "assigned_character_name", "assigned_via_magelo"]
    if loot_rows and "id" in loot_rows[0]:
        fieldnames = ["id"] + [f for f in fieldnames if f != "id"]
    for opt in ("manual_assignment", "manual"):
        if loot_rows and opt in loot_rows[0] and opt not in fieldnames:
            fieldnames.append(opt)
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

    n_new = sum(
        1 for i in range(len(loot_rows))
        if i not in manual_only_indices and (assigned_char_id[i] or assigned_character_name[i])
    )
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
    ap.add_argument("--dkp-elemental-json", type=Path, default=SCRIPT_DIR / "dkp_elemental_to_magelo.json",
                    help="Map DKP elemental loot names to Magelo item IDs by class (item ID match only)")
    ap.add_argument("--out-raid-loot", type=Path, default=DATA_DIR / "raid_loot.csv",
                    help="Output raid_loot CSV path")
    ap.add_argument("--out-counts", type=Path, default=DATA_DIR / "character_loot_assignment_counts.csv",
                    help="Output assignment counts CSV path")
    ap.add_argument("--elemental-source-name", action="append", dest="elemental_extra",
                    help="Extra item name to treat as elemental (if not seen in Magelo dump; can repeat)")
    ap.add_argument("--clear-assignments", action="store_true",
                    help="Recompute all assignments from Magelo (manual Loot-tab rows, assigned_via_magelo=0, are always preserved)")
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
        dkp_elemental_json=args.dkp_elemental_json,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

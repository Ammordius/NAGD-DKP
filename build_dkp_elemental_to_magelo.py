#!/usr/bin/env python3
"""
Build canonical JSON mapping DKP elemental armor purchases (molds/patterns) to
Magelo wearable item IDs. Uses pop_ele_armor.txt (class/slot -> item layout) and
ele dkp armor molds.csv (mold/pattern id -> slot, armor_type).

Output: dkp_elemental_to_magelo.json for use in assign_loot_to_characters and
any tool that needs "which Magelo item does this DKP purchase correspond to?"
"""

import csv
import json
import re
from pathlib import Path

# Table layout: row1 = head, row2 = chest|arms, row3 = legs|wrists, row4 = feet|hands
SLOT_ORDER = ["head", "chest", "arms", "legs", "wrists", "feet", "hands"]

# Class long name (from pop_ele_armor) -> short (for assign script)
CLASS_TO_SHORT = {
    "Warrior": "war",
    "Rogue": "rog",
    "Monk": "mnk",
    "Cleric": "clr",
    "Shaman": "shm",
    "Druid": "dru",
    "Shadow Knight": "shd",
    "Bard": "brd",
    "Paladin": "pal",
    "Ranger": "rng",
    "Beast Lord": "bst",
    "Wizard": "wiz",
    "Magician": "mag",
    "Necromancer": "nec",
    "Enchanter": "enc",
}

# Class short -> armor type (must match assign_loot_to_characters.CLASS_ARMOR_TYPE)
CLASS_ARMOR_TYPE = {
    "rog": "chain", "shm": "chain", "rng": "chain",
    "brd": "plate", "clr": "plate", "war": "plate", "pal": "plate", "shd": "plate",
    "mnk": "leather", "bst": "leather", "dru": "leather",
    "nec": "silk", "mag": "silk", "wiz": "silk", "enc": "silk",
}


def parse_pop_ele_armor(html_path: Path) -> list[dict]:
    """Parse pop_ele_armor.txt: list of { class_short, set_name, slot -> item_id }."""
    text = html_path.read_text(encoding="utf-8")
    # Split by class blocks: <td>ClassName then <p>Set Name</p> then table with item ids
    # Pattern: <td>CLASS_NAME\n<p>SET_NAME</p> then later item.php?id=ID
    block_pattern = re.compile(
        r"<td>([^<]+?)\s*\n\s*<p>([^<]+?)</p>.*?<table[^>]*>.*?</table>",
        re.DOTALL,
    )
    id_pattern = re.compile(r"item\.php\?id=(\d+)")
    results = []
    for m in block_pattern.finditer(text):
        class_name = m.group(1).strip()
        set_name = m.group(2).strip()
        block = m.group(0)
        ids = id_pattern.findall(block)
        if class_name not in CLASS_TO_SHORT:
            continue
        class_short = CLASS_TO_SHORT[class_name]
        if len(ids) != len(SLOT_ORDER):
            raise ValueError(
                f"Class {class_name}: expected {len(SLOT_ORDER)} item ids, got {len(ids)}"
            )
        slots = dict(zip(SLOT_ORDER, ids))
        results.append({
            "class_short": class_short,
            "set_name": set_name,
            "slots": slots,
        })
    return results


def load_molds_csv(csv_path: Path) -> list[dict]:
    """Load ele dkp armor molds.csv: item_id, name, slot, armor_type."""
    rows = []
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        for row in csv.reader(f):
            if len(row) < 4:
                continue
            try:
                item_id = str(int(row[0].strip()))
            except (ValueError, TypeError):
                continue
            rows.append({
                "item_id": item_id,
                "name": row[1].strip(),
                "slot": row[2].strip().lower(),
                "armor_type": row[3].strip().lower(),
            })
    return rows


def build_canonical(
    pop_path: Path,
    molds_path: Path,
) -> dict:
    by_class_list = parse_pop_ele_armor(pop_path)
    molds = load_molds_csv(molds_path)

    # Normalize slot: CSV has "wrists", we use "wrists" in SLOT_ORDER
    def norm_slot(s: str) -> str:
        return "wrists" if s == "wrists" else s

    # by_class: class_short -> { armor_type, set_name, slots: { slot: item_id } }
    by_class = {}
    for entry in by_class_list:
        c = entry["class_short"]
        by_class[c] = {
            "armor_type": CLASS_ARMOR_TYPE[c],
            "set_name": entry["set_name"],
            "slots": entry["slots"],
        }

    # dkp_purchases: mold/pattern item_id -> slot, armor_type, and for each class that uses that armor type, magelo item_id
    dkp_purchases = {}
    for m in molds:
        slot = norm_slot(m["slot"])
        armor_type = m["armor_type"]
        magelo_by_class = {}
        for c, info in by_class.items():
            if info["armor_type"] == armor_type and slot in info["slots"]:
                magelo_by_class[c] = info["slots"][slot]
        dkp_purchases[m["item_id"]] = {
            "name": m["name"],
            "slot": slot,
            "armor_type": armor_type,
            "magelo_item_ids_by_class": magelo_by_class,
        }

    # magelo_item_to_dkp: wearable item_id -> which DKP purchase (mold) and class/slot/set
    magelo_item_to_dkp = {}
    for c, info in by_class.items():
        for slot, item_id in info["slots"].items():
            # Find the mold/pattern for this (armor_type, slot)
            mold_id = None
            for mid, pinfo in dkp_purchases.items():
                if pinfo["armor_type"] == info["armor_type"] and pinfo["slot"] == slot:
                    mold_id = mid
                    break
            magelo_item_to_dkp[item_id] = {
                "class": c,
                "slot": slot,
                "armor_type": info["armor_type"],
                "set_name": info["set_name"],
                "dkp_purchase_id": mold_id,
            }

    return {
        "slot_order": SLOT_ORDER,
        "dkp_purchases": dkp_purchases,
        "by_class": by_class,
        "magelo_item_to_dkp": magelo_item_to_dkp,
    }


def main() -> None:
    dkp_dir = Path(__file__).resolve().parent
    pop_path = dkp_dir / "pop_ele_armor.txt"
    molds_path = dkp_dir / "ele dkp armor molds.csv"
    out_path = dkp_dir / "dkp_elemental_to_magelo.json"

    data = build_canonical(pop_path, molds_path)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Strip Magelo character sheet stats into a tiny Expedition combat-profiles JSON.

Reads TAKP_character.txt (and optional inventory) OR a class_rankings.json export.
Writes web/public/expedition/combat-profiles.json

Does NOT use DKP purchase history. Equipped inventory is Magelo-only.

Transforms (game values, not literal EQ):
  armor = clamp(ac/20, 0, 25)
  physicalPower = clamp(atk_item/4, 0, 30)
  magicalPower = clamp(mana/20 + INT/10, 0, 30)
  manaReserve = clamp(mana/25, 0, 40)
  resists = each/4 capped 15
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import date
from pathlib import Path


def clamp(n: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, n))


def num(value, default: float = 0.0) -> float:
    """Parse Magelo stats that may be ints, floats, or strings like '260 / 250'."""
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return default
    # Prefer the first number in ratios / ranges.
    match = re.search(r"-?\d+(?:\.\d+)?", text.replace(",", ""))
    if not match:
        return default
    try:
        return float(match.group(0))
    except ValueError:
        return default


def transform_stats(raw: dict) -> dict:
    ac = num(raw.get("ac") or raw.get("ac_total"))
    atk = num(raw.get("atk_item") or raw.get("atk"))
    mana = num(raw.get("mana") or raw.get("mana_max"))
    hp = num(raw.get("hp") or raw.get("hp_max_total"))
    haste = num(raw.get("haste") or raw.get("haste_item"))
    intel = num(raw.get("INT") or raw.get("int"))
    resists = raw.get("resists") or raw.get("individual_resists") or {}
    if not isinstance(resists, dict):
        resists = {}
    return {
        "armor": round(clamp(ac / 20, 0, 25), 2),
        "physicalPower": round(clamp(atk / 4, 0, 30), 2),
        "magicalPower": round(clamp(mana / 20 + intel / 10, 0, 30), 2),
        "manaReserve": round(clamp(mana / 25, 0, 40), 2),
        "hpBonus": round(clamp(hp / 80, 0, 40), 2),
        "haste": round(clamp(haste / 100 if haste > 1 else haste, 0, 0.2), 3),
        "resistances": {
            "fire": round(clamp(num(resists.get("fire")) / 4, 0, 15), 2),
            "cold": round(clamp(num(resists.get("cold")) / 4, 0, 15), 2),
            "magic": round(clamp(num(resists.get("magic")) / 4, 0, 15), 2),
        },
    }


def traits_from(stats: dict, slots: dict | None) -> list[str]:
    traits: list[str] = []
    if slots and str(slots.get("8") or slots.get(8) or ""):
        traits.append("shield_equipped")
    if stats.get("haste", 0) >= 0.08:
        traits.append("haste_equipment")
    if stats.get("magicalPower", 0) >= 15:
        traits.append("focus_healing")
    if stats.get("manaReserve", 0) >= 20:
        traits.append("mana_gear")
    return traits


def from_rankings(path: Path, guild_filter: str | None) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    chars = data if isinstance(data, list) else data.get("characters") or data.get("rankings") or []
    out = {}
    for ch in chars:
        name = ch.get("name")
        if not name:
            continue
        guild = (ch.get("guild") or "").strip()
        if guild_filter and guild.lower() != guild_filter.lower():
            continue
        stats_raw = dict(ch.get("stats") or {})
        if ch.get("individual_resists") and not stats_raw.get("resists"):
            stats_raw["resists"] = ch.get("individual_resists")
        combat = transform_stats(stats_raw)
        inv = ch.get("inventory") or []
        slots = {}
        for item in inv:
            sid = item.get("slot_id")
            if sid is None:
                continue
            if 1 <= int(sid) <= 22:
                slots[str(sid)] = item.get("item_id")
        profile = {
            "source": "magelo",
            "snapshotDate": str(date.today()),
            "equipmentKnown": True,
            "class": ch.get("class") or ch.get("class_name"),
            "combatStats": combat,
            "traits": traits_from(combat, slots),
            "slots": slots,
        }
        out[name.lower()] = profile
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rankings", type=Path, help="Path to class_rankings.json")
    ap.add_argument("--guild", default="NAGD", help="Guild name filter (empty = all)")
    ap.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "web" / "public" / "expedition" / "combat-profiles.json",
    )
    args = ap.parse_args()
    guild = args.guild or None
    if not args.rankings or not args.rankings.exists():
        # Emit empty shell so the client fallback path works in CI without Magelo dumps.
        payload = {
            "version": 1,
            "snapshotDate": str(date.today()),
            "guild": guild,
            "profiles": {},
            "note": "No rankings input; client uses class+level fallback.",
        }
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
        print(f"Wrote empty profiles shell to {args.out}")
        return

    profiles = from_rankings(args.rankings, guild)
    payload = {
        "version": 1,
        "snapshotDate": str(date.today()),
        "guild": guild,
        "profiles": profiles,
        "transforms": "See scripts/expedition_combat_profiles.py header.",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(profiles)} profiles to {args.out} ({args.out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

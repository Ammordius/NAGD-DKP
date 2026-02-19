#!/usr/bin/env python3
"""
Build item_stats.json from TAKP AllaClone for all items in dkp_mob_loot.
Fetches each item page with a rate limit and parses stats into the DKP item card schema.
Saves progress after each item so you can stop and resume (re-run skips ids already in --out).
Prints progress for every item.

Usage:
  python scripts/build_item_stats.py [--delay 1.5] [--limit N] [--out path] [--no-resume]
  Use --out web/public/item_stats.json to write where the app loads it.

Requires: requests, beautifulsoup4 (see requirements.txt).
"""
import argparse
import csv
import json
import re
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

TAKP_ITEM_URL = "https://www.takproject.net/allaclone/item.php?id={id}"
DELAY_DEFAULT = 1.5
USER_AGENT = "NAGD-DKP-ItemStats/1.0 (guild DKP site; item card data)"


def collect_item_ids_from_mob_loot(mob_loot_path: Path) -> dict[int, str]:
    """Return { item_id: name } from dkp_mob_loot.json."""
    data = json.loads(mob_loot_path.read_text(encoding="utf-8"))
    seen = {}
    for entry in data.values() if isinstance(data, dict) else []:
        for item in entry.get("loot") or []:
            iid = item.get("item_id")
            name = (item.get("name") or "").strip()
            if iid is not None and name and iid not in seen:
                seen[iid] = name
    return seen


def collect_item_ids_from_raid_sources(raid_sources_path: Path) -> dict[int, str]:
    """Return { item_id: name } from raid_item_sources.json (id -> { name })."""
    if not raid_sources_path.exists():
        return {}
    data = json.loads(raid_sources_path.read_text(encoding="utf-8"))
    seen = {}
    for sid, entry in (data.items() if isinstance(data, dict) else []):
        try:
            iid = int(sid)
        except (ValueError, TypeError):
            continue
        name = (entry.get("name") or "").strip()
        if name and iid not in seen:
            seen[iid] = name
    return seen


def collect_item_ids(mob_loot_path: Path, raid_sources_path: Path | None = None) -> tuple[list[tuple[int, str]], int, int]:
    """Return (unique (item_id, name), count_from_mob_loot, count_added_from_raid_sources)."""
    seen = collect_item_ids_from_mob_loot(mob_loot_path)
    n_mob = len(seen)
    n_raid_added = 0
    if raid_sources_path:
        for iid, name in collect_item_ids_from_raid_sources(raid_sources_path).items():
            if iid not in seen:
                seen[iid] = name
                n_raid_added += 1
    return [(iid, seen[iid]) for iid in sorted(seen)], n_mob, n_raid_added


def parse_item_page(html: str, item_id: int, name: str) -> dict | None:
    """Parse AllaClone item page HTML into our item-stats schema. Returns None on parse failure."""
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text(separator=" ", strip=True)

    # Spell links: extract spell.php?id=XXX and link text for Effect / Focus Effect
    spell_links = []
    for a in soup.find_all("a", href=True):
        m = re.search(r"spell\.php\?id=(\d+)", a.get("href", ""))
        if m:
            spell_links.append((int(m.group(1)), (a.get_text() or "").strip()))

    out = {}

    # Flags (MAGIC ITEM LORE ITEM NO DROP / NO TRADE)
    flags = []
    for token in ["MAGIC ITEM", "LORE ITEM", "NO DROP", "NO TRADE"]:
        if token in text:
            flags.append(token)
    if flags:
        out["flags"] = flags

    # Slot
    m = re.search(r"Slot:\s*([A-Za-z0-9\s]+?)(?=\s+Skill:|\s+AC:|\s+STR:|\s+STA:|\s+AGI:|\s+DEX:|\s+WIS:|\s+INT:|\s+CHA:|\s+Required|\s+Recommended|\s+Effect:|\s+Focus|\s+WT:|\s+Class:|\s+Singing|\s+Wind|\s+Brass|\s+Percussion|$)", text, re.IGNORECASE)
    if m:
        out["slot"] = m.group(1).strip()

    # Weapon: Skill, Atk Delay, DMG, Dmg Bonus, AC
    m = re.search(r"Skill:\s*([^A]+?)\s+Atk Delay:\s*(\d+)", text)
    if m:
        out["skill"] = m.group(1).strip()
        out["atkDelay"] = int(m.group(2))
    m = re.search(r"DMG:\s*(\d+)", text)
    if m:
        out["dmg"] = int(m.group(1))
    m = re.search(r"Dmg Bonus:\s*(\d+)", text)
    if m:
        out["dmgBonus"] = int(m.group(1))
        out["dmgBonusNote"] = "(lvl 65)"
    m = re.search(r"AC:\s*(\d+)", text)
    if m:
        out["ac"] = int(m.group(1))

    # Stat mods: STR/STA/AGI/DEX/WIS/INT/CHA/HP/MANA
    mod_map = {}
    for stat in ["STR", "STA", "AGI", "DEX", "WIS", "INT", "CHA"]:
        m = re.search(rf"\b{stat}:\s*([+]?\d+)\b", text)
        if m:
            v = m.group(1)
            mod_map[stat] = int(v.replace("+", "")) if v.lstrip("+").isdigit() else v
    for stat in ["HP", "MANA"]:
        m = re.search(rf"\b{stat}:\s*([+]?\d+)\b", text)
        if m:
            v = m.group(1)
            mod_map[stat] = int(v.replace("+", "")) if v.lstrip("+").isdigit() else v
    if mod_map:
        out["mods"] = [{"label": k, "value": v} for k, v in mod_map.items()]

    # Resists: SV FIRE: +18 or Fire: 18
    resists = []
    for r in ["FIRE", "COLD", "MAGIC", "POISON", "DISEASE"]:
        m = re.search(rf"(?:SV\s+)?{r}:\s*([+]?\d+)", text, re.IGNORECASE)
        if m:
            resists.append({"label": r.capitalize() if r != "DISEASE" else "Disease", "value": int(m.group(1).replace("+", ""))})
    if resists:
        out["resists"] = resists

    # Instrument mods: "Wind Instruments: 22 (+120%)" or "Singing: 20 (+100%)" or "Singing (+100%)"
    instrument_mods = []
    for m in re.finditer(r"(Wind|Brass|Percussion|String)\s+Instruments:\s*(\d+)\s*\(([^)]+)\)", text, re.IGNORECASE):
        instrument_mods.append({"label": f"{m.group(1).capitalize()} Instruments", "value": int(m.group(2)), "pct": m.group(3).strip()})
    for m in re.finditer(r"Singing:\s*(\d+)\s*\(([^)]+)\)", text, re.IGNORECASE):
        instrument_mods.append({"label": "Singing", "value": int(m.group(1)), "pct": m.group(2).strip()})
    for m in re.finditer(r"Singing\s*\(([^)]+)\)", text):
        instrument_mods.append({"label": "Singing", "value": 0, "pct": m.group(1).strip()})
    if instrument_mods:
        out["instrumentMods"] = instrument_mods

    # Required / Recommended level
    m = re.search(r"Required level of (\d+)", text, re.IGNORECASE)
    if m:
        out["requiredLevel"] = int(m.group(1))
        out["levelType"] = "required"
    else:
        m = re.search(r"Recommended level of (\d+)", text, re.IGNORECASE)
        if m:
            out["requiredLevel"] = int(m.group(1))
            out["levelType"] = "recommended"

    # Effect + Focus: first spell link = effect, second = focus (when both labels present)
    if spell_links:
        if "Effect:" in text and len(spell_links) >= 1:
            sid, sname = spell_links[0]
            out["effectSpellId"] = sid
            out["effectSpellName"] = sname
            out["effectNote"] = ""  # optional: parse (Worn) (Level 0) from text
        if ("Focus Effect:" in text or "Focus:" in text):
            if len(spell_links) >= 2:
                sid, sname = spell_links[1]
                out["focusSpellId"] = sid
                out["focusSpellName"] = sname
            elif len(spell_links) == 1:
                sid, sname = spell_links[0]
                out["focusSpellId"] = sid
                out["focusSpellName"] = sname

    # Skill Mod: e.g. "Skill Mod: Riposte +8%"
    m = re.search(r"Skill Mod:\s*([^\n]+?)(?=\s+[A-Z][a-z]+:|\s+Required|\s+Effect:|\s+WT:)", text)
    if m:
        out["skillMod"] = m.group(1).strip()

    # WT and Size
    m = re.search(r"WT:\s*([\d.]+)", text)
    if m:
        try:
            out["weight"] = float(m.group(1))
        except ValueError:
            pass
    m = re.search(r"Size:\s*(TINY|SMALL|MEDIUM|LARGE)", text, re.IGNORECASE)
    if m:
        out["size"] = m.group(1).upper()

    # Class / Race
    m = re.search(r"Class:\s*([A-Za-z\s]+?)(?=\s*Race:)", text)
    if m:
        out["classes"] = m.group(1).strip()
    m = re.search(r"Race:\s*([A-Za-z\s]+?)(?=\s+Light:|\s+Tint:|\s*$)", text)
    if m:
        out["races"] = m.group(1).strip()

    # Light / Tint
    m = re.search(r"Light:\s*(\d+)", text, re.IGNORECASE)
    if m:
        out["light"] = int(m.group(1))
    m = re.search(r"Tint:\s*\(([^)]+)\)", text)
    if m:
        out["tint"] = "(" + m.group(1).strip() + ")"

    # Gear score: total saves + AC + HP/3 (for filtering/sorting by item power)
    total_saves = sum((r.get("value") or 0) for r in out.get("resists") or [])
    ac = out.get("ac") or 0
    hp = 0
    for m in out.get("mods") or []:
        if (m.get("label") or "").strip().upper() == "HP":
            hp = int(m.get("value") or 0)
            break
    out["gearScore"] = total_saves + ac + (hp // 3)

    return out if out else None


def stats_to_csv_row(item_id: int, name: str, stats: dict) -> dict:
    """Flatten one item's stats for CSV (slot, ac, flags, mods, resists, effect, focus, level, classes)."""
    row = {"item_id": item_id, "name": name or ""}
    if not stats:
        return row
    row["slot"] = stats.get("slot") or ""
    row["ac"] = stats.get("ac") if stats.get("ac") is not None else ""
    row["flags"] = " | ".join(stats.get("flags") or [])
    mods = stats.get("mods") or []
    row["mods"] = ", ".join(f"{m.get('label', '')}: {m.get('value', '')}" for m in mods)
    resists = stats.get("resists") or []
    row["resists"] = ", ".join(f"{r.get('label', '')}: {r.get('value', '')}" for r in resists)
    row["effect"] = stats.get("effectSpellName") or stats.get("effectSpellId") or ""
    row["focus"] = stats.get("focusSpellName") or stats.get("focusSpellId") or ""
    row["required_level"] = stats.get("requiredLevel") if stats.get("requiredLevel") is not None else ""
    row["classes"] = stats.get("classes") or ""
    row["weight"] = stats.get("weight") if stats.get("weight") is not None else ""
    row["size"] = stats.get("size") or ""
    return row


def main():
    parser = argparse.ArgumentParser(description="Build item_stats.json from TAKP AllaClone")
    parser.add_argument("--delay", type=float, default=DELAY_DEFAULT, help=f"Seconds between requests (default {DELAY_DEFAULT})")
    parser.add_argument("--limit", type=int, default=0, help="Max items to fetch (0 = all)")
    parser.add_argument("--out", type=str, default="", help="Output path (default: data/item_stats.json)")
    parser.add_argument("--mob-loot", type=str, default="", help="Path to dkp_mob_loot.json (default: data/dkp_mob_loot.json or web/public/dkp_mob_loot.json)")
    parser.add_argument("--raid-sources", type=str, default="", help="Path to raid_item_sources.json (default: raid_item_sources.json or web/public/raid_item_sources.json)")
    parser.add_argument("--no-resume", action="store_true", help="Ignore existing output file; refetch all (default: resume by skipping ids already in file)")
    parser.add_argument("--from-cache", type=str, default="", help="Build from local HTML cache (e.g. data/item_pages from fetch_item_pages.py); no network")
    parser.add_argument("--csv", type=str, default="", help="Also write a flattened CSV to this path (e.g. data/item_stats.csv)")
    args = parser.parse_args()

    base = Path(__file__).resolve().parent.parent.parent  # repo root (script in scripts/takp_jsons/)
    mob_loot_path = Path(args.mob_loot) if args.mob_loot else None
    if not mob_loot_path or not mob_loot_path.is_absolute():
        for candidate in [base / "data" / "dkp_mob_loot.json", base / "web" / "public" / "dkp_mob_loot.json"]:
            if candidate.exists():
                mob_loot_path = candidate
                break
    if not mob_loot_path or not mob_loot_path.exists():
        print("dkp_mob_loot.json not found in data/ or web/public/")
        return 1

    raid_sources_path = Path(args.raid_sources) if args.raid_sources else None
    if not raid_sources_path or not raid_sources_path.is_absolute():
        for candidate in [base / "raid_item_sources.json", base / "web" / "public" / "raid_item_sources.json"]:
            if candidate.exists():
                raid_sources_path = candidate
                break
    if not raid_sources_path or not raid_sources_path.exists():
        raid_sources_path = None  # optional
    if raid_sources_path:
        print(f"Using raid_item_sources: {raid_sources_path}")
    else:
        print("raid_item_sources.json not found; only dkp_mob_loot items will be included (inline stats may be missing for raid-only items).")

    out_path = Path(args.out) if args.out else base / "data" / "item_stats.json"
    if not out_path.is_absolute():
        out_path = base / out_path

    items, n_mob, n_raid_added = collect_item_ids(mob_loot_path, raid_sources_path)
    id_to_name = {iid: name for iid, name in items}
    n_elemental = 0
    for elem_path in [base / "data" / "elemental_mold_armor.json", base / "web" / "public" / "elemental_mold_armor.json"]:
        if elem_path.exists():
            elem_data = json.loads(elem_path.read_text(encoding="utf-8"))
            for mold_id, info in (elem_data.items() if isinstance(elem_data, dict) else []):
                for cls, armor_id in (info.get("by_class") or {}).items():
                    try:
                        aid = int(armor_id)
                        if aid not in id_to_name:
                            id_to_name[aid] = f"Item {armor_id}"
                            n_elemental += 1
                    except (ValueError, TypeError):
                        pass
            break
    if n_elemental:
        print(f"Item IDs: +{n_elemental} from elemental_mold_armor (class-specific armor for mold display)")
    items = [(iid, id_to_name[iid]) for iid in sorted(id_to_name)]
    print(f"Item IDs: {n_mob} from dkp_mob_loot, +{n_raid_added} from raid_item_sources = {len(items)} total")

    result = {}
    from_cache = (args.from_cache or "").strip()
    if from_cache:
        cache_dir = Path(from_cache)
        if not cache_dir.is_absolute():
            cache_dir = base / cache_dir
        if not cache_dir.exists():
            print(f"Cache dir not found: {cache_dir}")
            return 1
        html_files = sorted(cache_dir.glob("*.html"), key=lambda p: int(p.stem) if p.stem.isdigit() else 0)
        print(f"Building from cache: {cache_dir} ({len(html_files)} HTML files)")
        for i, path in enumerate(html_files):
            try:
                item_id = int(path.stem)
            except ValueError:
                continue
            name = id_to_name.get(item_id, f"Item {item_id}")
            html = path.read_text(encoding="utf-8")
            parsed = parse_item_page(html, item_id, name)
            result[str(item_id)] = parsed if parsed else {}
            if (i + 1) % 100 == 0 or i + 1 == len(html_files):
                print(f"  Parsed {i + 1}/{len(html_files)}")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
        print(f"Wrote {len(result)} entries to {out_path}")
    else:
        total = len(items)
        if args.limit:
            items = items[: args.limit]
        n_items = len(items)
        if out_path.exists() and not args.no_resume:
            try:
                result = json.loads(out_path.read_text(encoding="utf-8"))
                print(f"Resuming: {len(result)} entries already in {out_path}")
            except Exception as e:
                print(f"Could not load existing output: {e}")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        session = requests.Session()
        session.headers["User-Agent"] = USER_AGENT

        def save():
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(result, f, indent=2)
                f.flush()

        print(f"Fetching up to {n_items} items from TAKP AllaClone, delay={args.delay}s (saving after each)...")
        done = 0
        skipped = 0
        for i, (item_id, name) in enumerate(items, 1):
            if str(item_id) in result and not args.no_resume:
                skipped += 1
                if i % 25 == 0 or i == n_items:
                    print(f"  [{i}/{n_items}] (skipped {skipped} already done)")
                continue
            try:
                r = session.get(TAKP_ITEM_URL.format(id=item_id), timeout=15)
                r.raise_for_status()
                parsed = parse_item_page(r.text, item_id, name)
                result[str(item_id)] = parsed if parsed else {}
                done += 1
                print(f"  [{i}/{n_items}] id={item_id} {name[:40]}{'...' if len(name) > 40 else ''} OK")
            except Exception as e:
                result[str(item_id)] = {}
                print(f"  [{i}/{n_items}] id={item_id} ERROR: {e}")
            save()
            if i < n_items:
                time.sleep(args.delay)
        print(f"Done. {len(result)} entries in {out_path} (wrote after each item).")

    if args.csv:
        csv_path = Path(args.csv)
        if not csv_path.is_absolute():
            csv_path = base / csv_path
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        fieldnames = ["item_id", "name", "slot", "ac", "flags", "mods", "resists", "effect", "focus", "required_level", "classes", "weight", "size"]
        with open(csv_path, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
            w.writeheader()
            for iid_str, stats in sorted(result.items(), key=lambda x: int(x[0])):
                name = id_to_name.get(int(iid_str), f"Item {iid_str}")
                w.writerow(stats_to_csv_row(int(iid_str), name, stats or {}))
        print(f"Wrote CSV: {csv_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

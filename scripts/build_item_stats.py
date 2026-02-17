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
import json
import re
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

TAKP_ITEM_URL = "https://www.takproject.net/allaclone/item.php?id={id}"
DELAY_DEFAULT = 1.5
USER_AGENT = "NAGD-DKP-ItemStats/1.0 (guild DKP site; item card data)"


def collect_item_ids(mob_loot_path: Path) -> list[tuple[int, str]]:
    """Return unique (item_id, name) from dkp_mob_loot.json."""
    data = json.loads(mob_loot_path.read_text(encoding="utf-8"))
    seen = {}
    for entry in data.values() if isinstance(data, dict) else []:
        for item in entry.get("loot") or []:
            iid = item.get("item_id")
            name = (item.get("name") or "").strip()
            if iid is not None and name and iid not in seen:
                seen[iid] = name
    return [(iid, seen[iid]) for iid in sorted(seen)]


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

    return out if out else None


def main():
    parser = argparse.ArgumentParser(description="Build item_stats.json from TAKP AllaClone")
    parser.add_argument("--delay", type=float, default=DELAY_DEFAULT, help=f"Seconds between requests (default {DELAY_DEFAULT})")
    parser.add_argument("--limit", type=int, default=0, help="Max items to fetch (0 = all)")
    parser.add_argument("--out", type=str, default="", help="Output path (default: data/item_stats.json)")
    parser.add_argument("--mob-loot", type=str, default="", help="Path to dkp_mob_loot.json (default: data/dkp_mob_loot.json or web/public/dkp_mob_loot.json)")
    parser.add_argument("--no-resume", action="store_true", help="Ignore existing output file; refetch all (default: resume by skipping ids already in file)")
    args = parser.parse_args()

    base = Path(__file__).resolve().parent.parent
    mob_loot_path = Path(args.mob_loot) if args.mob_loot else None
    if not mob_loot_path or not mob_loot_path.is_absolute():
        for candidate in [base / "data" / "dkp_mob_loot.json", base / "web" / "public" / "dkp_mob_loot.json"]:
            if candidate.exists():
                mob_loot_path = candidate
                break
    if not mob_loot_path or not mob_loot_path.exists():
        print("dkp_mob_loot.json not found in data/ or web/public/")
        return 1

    out_path = Path(args.out) if args.out else base / "data" / "item_stats.json"
    if not out_path.is_absolute():
        out_path = base / out_path

    items = collect_item_ids(mob_loot_path)
    total = len(items)
    if args.limit:
        items = items[: args.limit]
    n_items = len(items)

    # Resume: load existing output so we can skip already-fetched ids and save as we go
    result = {}
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

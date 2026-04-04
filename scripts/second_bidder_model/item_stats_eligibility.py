"""Derive (account_id, char_id) eligibility from characters.csv + item_stats.json."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Set, Tuple

from bid_portfolio_local.load_csv import BackupSnapshot

# Align with web/src/lib/mageloUpgradeEngine.js CLASS_TO_ABBREV
_CLASS_FULL_TO_ABBREV: Dict[str, str] = {
    "warrior": "WAR",
    "cleric": "CLR",
    "paladin": "PAL",
    "ranger": "RNG",
    "shadow knight": "SHD",
    "druid": "DRU",
    "monk": "MNK",
    "bard": "BRD",
    "rogue": "ROG",
    "shaman": "SHM",
    "necromancer": "NEC",
    "wizard": "WIZ",
    "magician": "MAG",
    "enchanter": "ENC",
    "beastlord": "BST",
}

_KNOWN_ABBREVS = frozenset(_CLASS_FULL_TO_ABBREV.values())


def normalize_item_name_for_lookup(name: str) -> str:
    """Match web/src/lib/itemNameNormalize.js and SQL normalize_item_name_for_lookup."""
    if not name or not isinstance(name, str):
        return ""
    s = name.strip()
    for c in ("'", "'", "`", "\u2019", "\u2018"):
        s = "".join(s.split(c))
    s = s.replace("-", " ")
    s = s.lower()
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^[,.;:!?]+|[,.;:!?]+$", "", s)
    return s


def item_usable_by_class(item_classes: Optional[str], class_abbrev: str) -> bool:
    """Port of itemUsableByClass (mageloUpgradeEngine.js)."""
    ca = (class_abbrev or "").strip().upper()
    if not ca:
        return True
    if not item_classes or not isinstance(item_classes, str):
        return True
    c = item_classes.strip().upper()
    if c == "ALL":
        return True
    return ca in c.split()


def class_name_to_abbrev(raw: str) -> Optional[str]:
    """Map characters.class_name (full name or abbrev) to TAKP 3-letter code."""
    if not raw or not str(raw).strip():
        return None
    s = str(raw).strip()
    u = s.upper()
    if u in _KNOWN_ABBREVS:
        return u
    key = s.lower().strip()
    return _CLASS_FULL_TO_ABBREV.get(key)


def char_meets_item_stats(
    snap: BackupSnapshot,
    char_id: str,
    stats: Optional[Dict[str, Any]],
) -> bool:
    """True if we cannot prove the character cannot use the item (permissive on missing data)."""
    if not stats:
        return True
    cls_raw = snap.character_class_name.get(char_id, "")
    abbrev = class_name_to_abbrev(cls_raw)
    if abbrev:
        ic = stats.get("classes")
        if ic and isinstance(ic, str) and not item_usable_by_class(ic, abbrev):
            return False
    req = stats.get("requiredLevel")
    if req is not None:
        try:
            req_i = int(req)
        except (TypeError, ValueError):
            req_i = None
        if req_i is not None:
            lvl = snap.character_level.get(char_id)
            if lvl is not None and lvl < req_i:
                return False
    return True


def _iter_mob_loot_items(mob_loot: Any) -> Iterable[Tuple[str, Any]]:
    if not isinstance(mob_loot, dict):
        return
    for entry in mob_loot.values():
        if not isinstance(entry, dict):
            continue
        for item in entry.get("loot") or []:
            if isinstance(item, dict):
                yield entry, item


def build_normalized_name_to_item_id(
    mob_loot_path: Path,
    raid_sources_path: Optional[Path] = None,
) -> Dict[str, int]:
    """First occurrence wins per normalized name (aligned with lootMobSubgroups buildItemNameToIdMap)."""
    out: Dict[str, int] = {}
    if mob_loot_path.is_file():
        data = json.loads(mob_loot_path.read_text(encoding="utf-8"))
        for _entry, item in _iter_mob_loot_items(data):
            name = item.get("name")
            iid = item.get("item_id")
            if name is None or iid is None:
                continue
            key = normalize_item_name_for_lookup(str(name))
            if not key or key in out:
                continue
            try:
                out[key] = int(iid)
            except (TypeError, ValueError):
                continue
    if raid_sources_path and raid_sources_path.is_file():
        rs = json.loads(raid_sources_path.read_text(encoding="utf-8"))
        if isinstance(rs, dict):
            for sid, row in rs.items():
                try:
                    iid = int(sid)
                except (TypeError, ValueError):
                    continue
                if not isinstance(row, dict):
                    continue
                name = (row.get("name") or "").strip()
                if not name:
                    continue
                key = normalize_item_name_for_lookup(name)
                if not key or key in out:
                    continue
                out[key] = iid
    return out


def load_item_stats_by_id(path: Path) -> Dict[str, Dict[str, Any]]:
    if not path.is_file():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for k, v in raw.items():
        if isinstance(v, dict):
            out[str(k)] = v
    return out


@dataclass(frozen=True)
class ItemStatsEligibilityBundle:
    """Precomputed lookups for class/level gating from item_stats.json + mob loot name map."""

    item_stats_by_id: Dict[str, Dict[str, Any]]
    normalized_name_to_item_id: Dict[str, int]

    def stats_for_item_name(self, item_name: str) -> Optional[Dict[str, Any]]:
        key = normalize_item_name_for_lookup(item_name)
        if not key:
            return None
        iid = self.normalized_name_to_item_id.get(key)
        if iid is None:
            return None
        return self.item_stats_by_id.get(str(iid))

    def resolved_stats_for_item_name(self, item_name: str) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """(resolved, stats). resolved False => permissive (no derived gate). True + stats => apply rules."""
        key = normalize_item_name_for_lookup(item_name)
        if not key:
            return False, None
        iid = self.normalized_name_to_item_id.get(key)
        if iid is None:
            return False, None
        st = self.item_stats_by_id.get(str(iid))
        if st is None:
            return False, None
        return True, st


def load_item_stats_eligibility_bundle(
    *,
    item_stats_path: Path,
    mob_loot_path: Path,
    raid_sources_path: Optional[Path] = None,
) -> ItemStatsEligibilityBundle:
    stats = load_item_stats_by_id(item_stats_path)
    name_map = build_normalized_name_to_item_id(mob_loot_path, raid_sources_path)
    return ItemStatsEligibilityBundle(item_stats_by_id=stats, normalized_name_to_item_id=name_map)


def eligible_char_pairs_for_item_name(
    snap: BackupSnapshot,
    bundle: ItemStatsEligibilityBundle,
    item_name: str,
) -> Optional[Set[Tuple[str, str]]]:
    """Eligible pairs for this item; None if item not resolved to stats (permissive); empty if resolved but nobody qualifies."""
    resolved, stats = bundle.resolved_stats_for_item_name(item_name)
    if not resolved or stats is None:
        return None
    pairs: Set[Tuple[str, str]] = set()
    for char_id, account_ids in snap.char_to_accounts.items():
        if not char_id or not char_meets_item_stats(snap, char_id, stats):
            continue
        for aid in account_ids:
            a = (aid or "").strip()
            if a:
                pairs.add((a, str(char_id).strip()))
    return pairs


def merge_eligible_char_pairs(
    derived: Optional[Set[Tuple[str, str]]],
    from_json: Optional[Set[Tuple[str, str]]],
) -> Optional[Set[Tuple[str, str]]]:
    """Intersection when both present; else whichever is set."""
    if derived is not None and from_json is not None:
        return derived & from_json
    if from_json is not None:
        return from_json
    if derived is not None:
        return derived
    return None


def default_repo_paths(repo_root: Path) -> Tuple[Path, Path, Path]:
    return (
        repo_root / "data" / "item_stats.json",
        repo_root / "data" / "dkp_mob_loot.json",
        repo_root / "raid_item_sources.json",
    )


def try_load_item_eligibility_bundle(
    repo_root: Path,
    *,
    item_stats_path: Optional[Path] = None,
    mob_loot_path: Optional[Path] = None,
    raid_sources_path: Optional[Path] = None,
) -> Optional[ItemStatsEligibilityBundle]:
    """Load bundle if ``item_stats.json`` exists; otherwise return None (permissive mode)."""
    dflt_stats, dflt_mob, dflt_rs = default_repo_paths(repo_root)
    stats_p = item_stats_path or dflt_stats
    mob_p = mob_loot_path or dflt_mob
    rs_p = raid_sources_path if raid_sources_path is not None else dflt_rs
    if not stats_p.is_file():
        return None
    if not mob_p.is_file():
        return None
    rs = rs_p if rs_p.is_file() else None
    return load_item_stats_eligibility_bundle(
        item_stats_path=stats_p,
        mob_loot_path=mob_p,
        raid_sources_path=rs,
    )

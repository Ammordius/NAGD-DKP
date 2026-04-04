"""Port account_balance_before_loot (raid_level, per_event, orphan pass)."""

from __future__ import annotations

from collections import defaultdict
from typing import Dict, List, Optional, Set, Tuple

from .attendees import _norm_event_id
from .load_csv import BackupSnapshot, parse_float
from .resolve import account_id_from_attendance_row, buyer_account_id_for_loot_row, parse_cost_num


BIG = 2147483647

# (loot_id, cost_num, buyer_account_id, event_order, norm_event_id)
LootTuple = Tuple[int, float, Optional[str], int, Optional[str]]


def _event_order_for(snap: BackupSnapshot, raid_id: str, event_id: Optional[str]) -> int:
    want = _norm_event_id(event_id)
    best = BIG
    for ev in snap.raid_events.get(raid_id, []):
        if _norm_event_id(ev.get("event_id")) != want:
            continue
        raw = (ev.get("event_order") or "").strip()
        try:
            o = int(float(raw)) if raw else BIG
        except ValueError:
            o = BIG
        best = min(best, o)
    return best


def _dkp_value_for_event(snap: BackupSnapshot, raid_id: str, event_id: Optional[str]) -> float:
    want = _norm_event_id(event_id)
    for ev in snap.raid_events.get(raid_id, []):
        if _norm_event_id(ev.get("event_id")) == want:
            return parse_cost_num(ev.get("dkp_value"))
    return 0.0


def _raid_events_ordered(snap: BackupSnapshot, raid_id: str) -> List[Tuple[Optional[str], int]]:
    """One entry per distinct event_id (min event_order), matching stable SQL iteration."""
    best: Dict[Optional[str], int] = {}
    for ev in snap.raid_events.get(raid_id, []):
        eid = _norm_event_id(ev.get("event_id"))
        raw = (ev.get("event_order") or "").strip()
        try:
            o = int(float(raw)) if raw else BIG
        except ValueError:
            o = BIG
        if eid not in best or o < best[eid]:
            best[eid] = o
    rows = [(eid, o) for eid, o in best.items()]
    rows.sort(key=lambda x: (x[1], x[0] or ""))
    return rows


def _event_keys_set(snap: BackupSnapshot, raid_id: str) -> Set[Optional[str]]:
    return {_norm_event_id(e.get("event_id")) for e in snap.raid_events.get(raid_id, [])}


def _spent_in_raid(snap: BackupSnapshot, raid_id: str, account_id: str) -> float:
    total = 0.0
    for rl in snap.raid_loot:
        if (rl.get("raid_id") or "").strip() != raid_id:
            continue
        buyer = buyer_account_id_for_loot_row(
            rl.get("char_id"),
            rl.get("character_name"),
            name_to_char_ids=snap.name_to_char_ids,
            char_to_accounts=snap.char_to_accounts,
        )
        if buyer != account_id:
            continue
        c = parse_cost_num(rl.get("cost"))
        if c:
            total += c
    return total


def _sum_per_event_earn(
    snap: BackupSnapshot,
    raid_id: str,
    event_id: Optional[str],
    account_id: str,
) -> float:
    want = _norm_event_id(event_id)
    total = 0.0
    dkp = _dkp_value_for_event(snap, raid_id, want)
    for rea in snap.raid_event_attendance.get(raid_id, []):
        if _norm_event_id(rea.get("event_id")) != want:
            continue
        aid = account_id_from_attendance_row(
            rea.get("char_id"),
            rea.get("character_name"),
            name_to_char_ids=snap.name_to_char_ids,
            char_to_accounts=snap.char_to_accounts,
        )
        if aid == account_id:
            total += dkp
    return total


def _loot_tuple(snap: BackupSnapshot, raid_id: str, rl: Dict[str, str]) -> LootTuple:
    lid = int(rl["id"])
    cost = parse_cost_num(rl.get("cost"))
    buyer = buyer_account_id_for_loot_row(
        rl.get("char_id"),
        rl.get("character_name"),
        name_to_char_ids=snap.name_to_char_ids,
        char_to_accounts=snap.char_to_accounts,
    )
    eid = _norm_event_id(rl.get("event_id"))
    eo = _event_order_for(snap, raid_id, eid)
    return lid, cost, buyer, eo, eid


class _RaidWalkIndex:
    def __init__(self, snap: BackupSnapshot, raid_id: str, rows: List[Dict[str, str]]):
        self.raid_id = raid_id
        tuples = [_loot_tuple(snap, raid_id, x) for x in rows]
        self.raid_level = sorted(tuples, key=lambda t: (t[3], t[0]))
        valid = _event_keys_set(snap, raid_id)
        self.events_ordered = _raid_events_ordered(snap, raid_id)
        self.event_keys = valid
        by_event: Dict[Optional[str], List[LootTuple]] = defaultdict(list)
        orphans: List[LootTuple] = []
        for t in tuples:
            eid = t[4]
            if eid not in valid:
                orphans.append(t)
            else:
                by_event[eid].append(t)
        self.by_event = {
            k: sorted(v, key=lambda x: x[0]) for k, v in by_event.items()
        }
        self.orphans = sorted(orphans, key=lambda t: (t[3], t[0]))


class BalanceCalculator:
    """Memoized account_balance_before_loot(loot_id, account_id)."""

    def __init__(self, snap: BackupSnapshot):
        self.snap = snap
        self._loot_by_id: Dict[int, Dict[str, str]] = {}
        self._raid_rows: Dict[str, List[Dict[str, str]]] = defaultdict(list)
        for rl in snap.raid_loot:
            lid = int(rl["id"])
            self._loot_by_id[lid] = rl
            rid = (rl.get("raid_id") or "").strip()
            if rid:
                self._raid_rows[rid].append(rl)
        self._walk: Dict[str, _RaidWalkIndex] = {}
        self._cache: Dict[Tuple[int, str], Optional[float]] = {}
        self._spent_cache: Dict[Tuple[str, str], float] = {}
        self._earn_cache: Dict[Tuple[str, Optional[str], str], float] = {}

    def _spent(self, raid_id: str, aid: str) -> float:
        k = (raid_id, aid)
        if k not in self._spent_cache:
            self._spent_cache[k] = _spent_in_raid(self.snap, raid_id, aid)
        return self._spent_cache[k]

    def _per_event_earn(self, raid_id: str, ev_id: Optional[str], aid: str) -> float:
        k = (raid_id, ev_id, aid)
        if k not in self._earn_cache:
            self._earn_cache[k] = _sum_per_event_earn(self.snap, raid_id, ev_id, aid)
        return self._earn_cache[k]

    def balance_before(self, loot_id: int, account_id: str) -> Optional[float]:
        aid = account_id.strip()
        if not aid:
            return None
        key = (loot_id, aid)
        if key in self._cache:
            return self._cache[key]
        rl = self._loot_by_id.get(loot_id)
        if not rl:
            self._cache[key] = None
            return None
        raid_id = (rl.get("raid_id") or "").strip()
        if not raid_id:
            self._cache[key] = None
            return None

        use_per_event = bool(self.snap.raid_event_attendance.get(raid_id))
        row = self.snap.account_dkp_summary.get(aid, {})
        earned = parse_float(str(row.get("earned", "0") or "0"))
        spent = parse_float(str(row.get("spent", "0") or "0"))
        v_bal = earned - spent
        v_earned_raid = self.snap.raid_dkp_by_account.get((raid_id, aid), 0.0)
        v_spent_raid = self._spent(raid_id, aid)
        v_opening = v_bal + v_spent_raid - v_earned_raid

        if raid_id not in self._walk:
            self._walk[raid_id] = _RaidWalkIndex(
                self.snap, raid_id, self._raid_rows.get(raid_id, [])
            )
        w = self._walk[raid_id]

        if not use_per_event:
            v_opening += v_earned_raid
            for lid, cost_num, buyer_account_id, _eo, _eid in w.raid_level:
                if lid == loot_id:
                    self._cache[key] = v_opening
                    return v_opening
                if buyer_account_id == aid and cost_num != 0:
                    v_opening -= cost_num
            self._cache[key] = v_opening
            return v_opening

        for ev_id, _eo in w.events_ordered:
            v_opening += self._per_event_earn(raid_id, ev_id, aid)
            for lid, cost_num, buyer_account_id, _, _e in w.by_event.get(ev_id, []):
                if lid == loot_id:
                    self._cache[key] = v_opening
                    return v_opening
                if buyer_account_id == aid and cost_num != 0:
                    v_opening -= cost_num

        for lid, cost_num, buyer_account_id, _eo, _eid in w.orphans:
            if lid == loot_id:
                self._cache[key] = v_opening
                return v_opening
            if buyer_account_id == aid and cost_num != 0:
                v_opening -= cost_num

        self._cache[key] = v_opening
        return v_opening

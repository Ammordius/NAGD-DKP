#!/usr/bin/env python3
"""
Compute DKP totals from local CSVs (no Supabase).

- Earned = sum of (raid event DKP) for each raid the character attended.
- Spent = sum of loot cost for that character.
- Balance = earned - spent.

Comparison with official DKP (e.g. ground_truth_sum.txt):
- Spent matches: we use the same raid_loot costs.
- Earned is often HIGHER here: we use raid-level attendance (everyone on the raid
  gets the sum of all events' DKP). The official site likely uses per-event attendance
  (you only get an event's DKP if you were on that event's attendee list). We only
  scrape the single raid attendee list, so we over-credit when someone missed some
  events. Use --since-date to restrict to raids on/after a date if the pool has
  a start date.

Outputs: console table, data/dkp_totals.csv (by character), data/dkp_by_account.csv (by account).
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd


def safe_float(x, default: float = 0.0) -> float:
    try:
        return float(x) if x is not None and str(x).strip() != "" else default
    except (ValueError, TypeError):
        return default


def safe_int(x, default: int = 0) -> int:
    try:
        return int(float(x)) if x is not None and str(x).strip() != "" else default
    except (ValueError, TypeError):
        return default


def main() -> None:
    ap = argparse.ArgumentParser(description="Compute DKP totals from CSVs")
    ap.add_argument("--data-dir", type=str, default="data", help="Directory containing CSVs")
    ap.add_argument("--top", type=int, default=50, help="Show top N by balance on console (0 = all)")
    ap.add_argument("--since-date", type=str, default="", help="Only count raids on or after this date (YYYY-MM-DD); uses data/raids.csv date_iso")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    if not data_dir.is_dir():
        print(f"Missing directory: {data_dir}", file=__import__("sys").stderr)
        raise SystemExit(2)

    # 1) DKP per raid (sum of event dkp_value per raid_id)
    events_path = data_dir / "raid_events.csv"
    if not events_path.exists():
        print(f"Missing {events_path}", file=__import__("sys").stderr)
        raise SystemExit(2)
    events = pd.read_csv(events_path)
    # Per (raid_id, event_id) -> dkp_value for that event
    event_dkp: dict[tuple, float] = {}
    for _, r in events.iterrows():
        rid = r.get("raid_id")
        eid = r.get("event_id")
        if pd.notna(rid) and pd.notna(eid):
            event_dkp[(int(rid), int(eid))] = safe_float(r.get("dkp_value"), 0.0)

    # Optional: only count raids on or after --since-date (uses data/raids.csv date_iso)
    raid_date_ok: dict[int, bool] = {}
    if args.since_date:
        raids_path = data_dir / "raids.csv"
        if raids_path.exists():
            raids_df = pd.read_csv(raids_path)
            raids_df["date_iso"] = pd.to_datetime(raids_df.get("date_iso"), errors="coerce")
            since = pd.Timestamp(args.since_date)
            for _, r in raids_df.iterrows():
                rid = r.get("raid_id")
                if pd.isna(rid):
                    continue
                try:
                    raid_date_ok[int(rid)] = pd.notna(r.get("date_iso")) and pd.Timestamp(r["date_iso"]) >= since
                except Exception:
                    raid_date_ok[int(rid)] = False
        else:
            print("Warning: --since-date set but data/raids.csv not found; ignoring.", file=__import__("sys").stderr)

    # 2) Earned per character: prefer per-event attendance (raid_event_attendance.csv), else raid-level (raid_attendance.csv)
    earned: dict[str, dict] = {}
    # Build name -> char_id from raid_attendance so we can merge when event_attendance has empty char_id
    name_to_cid: dict[str, str] = {}
    att_path = data_dir / "raid_attendance.csv"
    if att_path.exists():
        att_df = pd.read_csv(att_path)
        for _, r in att_df.iterrows():
            cid = r.get("char_id")
            name = (r.get("character_name") or "").strip()
            if name and pd.notna(cid) and str(cid).strip() and str(cid).replace(".", "").isdigit():
                if name not in name_to_cid:
                    name_to_cid[name] = str(int(float(cid)))

    event_att_path = data_dir / "raid_event_attendance.csv"
    if event_att_path.exists():
        ev_att = pd.read_csv(event_att_path)
        for _, row in ev_att.iterrows():
            raid_id = int(row.get("raid_id", 0))
            event_id = int(row.get("event_id", 0))
            if args.since_date and raid_date_ok and not raid_date_ok.get(raid_id, False):
                continue
            dkp = event_dkp.get((raid_id, event_id), 0.0)
            raw_id = row.get("char_id")
            name = (row.get("character_name") or "").strip()
            if pd.notna(raw_id) and str(raw_id).strip() and str(raw_id).replace(".", "").isdigit():
                key = str(int(float(raw_id)))
            elif name:
                key = name_to_cid.get(name, name)
            else:
                continue
            if key not in earned:
                earned[key] = {"name": name or key, "earned": 0.0}
            earned[key]["earned"] += dkp
            if name:
                earned[key]["name"] = name
        print("Using per-event attendance (raid_event_attendance.csv) for earned.")
    else:
        att_path = data_dir / "raid_attendance.csv"
        if not att_path.exists():
            print(f"Missing {att_path} (and no raid_event_attendance.csv)", file=__import__("sys").stderr)
            raise SystemExit(2)
        att = pd.read_csv(att_path)
        ev_by_raid = events.groupby("raid_id")["dkp_value"].apply(lambda s: s.map(safe_float).sum()).to_dict()
        for _, row in att.iterrows():
            raid_id = row.get("raid_id")
            if args.since_date and raid_date_ok and not raid_date_ok.get(int(raid_id), False):
                continue
            dkp = ev_by_raid.get(raid_id, 0.0)
            raw_id = row.get("char_id")
            key = str(int(raw_id)) if pd.notna(raw_id) and str(raw_id).strip() and str(raw_id).replace(".", "").isdigit() else (str(row.get("character_name") or "").strip() or "unknown")
            if key == "unknown":
                continue
            if key not in earned:
                earned[key] = {"name": row.get("character_name") or key, "earned": 0.0}
            earned[key]["earned"] += dkp
            if pd.notna(row.get("character_name")) and str(row.get("character_name")).strip():
                earned[key]["name"] = str(row["character_name"]).strip()
        print("Using raid-level attendance (raid_attendance.csv) for earned.")

    # 3) Spent per character (from raid_loot)
    loot_path = data_dir / "raid_loot.csv"
    spent: dict[str, float] = {}
    if loot_path.exists():
        loot = pd.read_csv(loot_path)
        for _, row in loot.iterrows():
            raw_id = row.get("char_id")
            key = str(int(raw_id)) if pd.notna(raw_id) and str(raw_id).strip() and str(raw_id).replace(".", "").isdigit() else (str(row.get("character_name") or "").strip())
            if not key:
                continue
            cost = safe_int(row.get("cost"), 0)
            spent[key] = spent.get(key, 0) + cost

    # 4) By-character list
    char_keys = set(earned.keys()) | set(spent.keys())
    rows = []
    for key in char_keys:
        e = earned.get(key, {"name": key, "earned": 0.0})
        name = e.get("name", key) if isinstance(e, dict) else key
        e_val = e.get("earned", 0.0) if isinstance(e, dict) else 0.0
        s_val = spent.get(key, 0)
        rows.append({
            "char_id": key,
            "character_name": name,
            "earned": round(e_val, 2),
            "spent": s_val,
            "balance": round(e_val - s_val, 2),
        })
    by_char = pd.DataFrame(rows)
    by_char = by_char.sort_values("balance", ascending=False).reset_index(drop=True)

    # 5) By-account rollup (if we have character_account and accounts)
    ca_path = data_dir / "character_account.csv"
    acc_path = data_dir / "accounts.csv"
    by_account = None
    if ca_path.exists() and acc_path.exists():
        ca = pd.read_csv(ca_path)
        acc = pd.read_csv(acc_path)
        char_to_account = dict(zip(ca["char_id"].astype(str), ca["account_id"].astype(str)))
        account_names = {}
        for _, r in acc.iterrows():
            aid = str(r.get("account_id", ""))
            toons = (r.get("toon_names") or "").split(",")
            account_names[aid] = toons[0].strip() if toons else aid

        by_acc: dict[str, dict] = {}
        for _, r in by_char.iterrows():
            cid = str(r["char_id"])
            aid = char_to_account.get(cid, "_no_account_")
            if aid not in by_acc:
                by_acc[aid] = {
                    "account_id": aid,
                    "name": account_names.get(aid, "(no account)" if aid == "_no_account_" else aid),
                    "earned": 0.0,
                    "spent": 0,
                }
            by_acc[aid]["earned"] += r["earned"]
            by_acc[aid]["spent"] += r["spent"]

        by_account = pd.DataFrame([
            {
                "account_id": v["account_id"],
                "name": v["name"],
                "earned": round(v["earned"], 2),
                "spent": v["spent"],
                "balance": round(v["earned"] - v["spent"], 2),
            }
            for v in by_acc.values()
        ])
        by_account = by_account.sort_values("balance", ascending=False).reset_index(drop=True)

    # 6) Write CSVs
    out_char = data_dir / "dkp_totals.csv"
    by_char.to_csv(out_char, index=False)
    print(f"Wrote {out_char} ({len(by_char)} characters)")

    if by_account is not None:
        out_acc = data_dir / "dkp_by_account.csv"
        by_account.to_csv(out_acc, index=False)
        print(f"Wrote {out_acc} ({len(by_account)} accounts)")

    # 7) Console table (by character)
    top_n = args.top if args.top > 0 else len(by_char)
    show = by_char.head(top_n)
    print("\n--- DKP by character (top {} by balance) ---".format(top_n))
    print(show.to_string(index=False))

    if by_account is not None:
        top_acc = min(args.top or 30, len(by_account))
        print("\n--- DKP by account (top {} by balance) ---".format(top_acc))
        print(by_account.head(top_acc).to_string(index=False))


if __name__ == "__main__":
    main()

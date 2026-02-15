# Anmordius (typo) – raid source

**Anmordius** (char_id `22036483`) is a separate character row from **Ammordius** (char_id `22036509`). Same account (see `data/accounts.csv`: toon list includes both). Almost certainly a roster/typo: one “n” vs two “m”s.

## Where the 1 DKP came from

- **raid_event_attendance.csv:** `1598436,2498790,22036483,Anmordius`
- **raid_attendance.csv:** `1598436,22036483,Anmordius`
- **raid_loot.csv:** no rows for Anmordius (the 1 is earned DKP only, not spent)

## Raid details (from `data/raids.csv`)

| raid_id | raid_name | date_iso   | date (raw)                    |
|---------|-----------|------------|--------------------------------|
| 1598436 | Vex Thal  | 2025-12-04 | Thu Dec 04, 2025 2:00 am       |

**Within last 120 days?** Yes. Raid date **2025-12-04** is **72 days** before 2026-02-14, so it falls inside the 120-day window. If you want Anmordius to disappear from the “active” leaderboard, you could either fix the typo in the source data (merge into Ammordius) or treat 120-day filtering as already hiding them if they have no other activity (they only have this one raid).

## Fix applied (typo merged)

**Data (CSVs):** Already updated in this repo:
- **raid_event_attendance.csv:** The row `1598436,2498790,22036483,Anmordius` was changed to `1598436,2498790,22036509,Ammordius`.
- **raid_attendance.csv:** The duplicate row `1598436,22036483,Anmordius` was removed (Ammordius 22036509 already has a row for that raid).
- **characters.csv:** The row for char_id `22036483` (Anmordius) was removed.
- **character_account.csv:** The row `22036483,22036510` was removed.

After re-importing from these CSVs, run `refresh_dkp_summary()`. Ammordius base earned becomes 820 (= GT), so the one-off adjustment for Ammordius has been removed from `data/dkp_adjustments.csv` and from the Supabase merge script.

**Supabase (already-imported DB):** Run the SQL in **docs/supabase-merge-anmordius-into-ammordius.sql** (see below).

## Optional fix (typo) – reference

To merge the typo into Ammordius:

1. In **characters.csv** and roster sources: correct the name `Anmordius` → `Ammordius` for char_id `22036483`, or remove the duplicate row and map that char_id to the same character as `22036509` in your pipeline.
2. In **raid_event_attendance.csv** and **raid_attendance.csv**: change `Anmordius` to `Ammordius` for raid_id `1598436` (and char_id `22036483` if you keep it), then re-run `compute_dkp.py` and re-import / refresh Supabase so that the single “Ammordius” gets both the main DKP and the 1 from that raid.

## CSV row references for raid 1598436

**raid_event_attendance.csv** (one row):
```text
1598436,2498790,22036483,Anmordius
```

**raid_attendance.csv** (one row):
```text
1598436,22036483,Anmordius
```

**raids.csv** (one row):
```text
1598436,562569,Vex Thal,"Thu Dec 04, 2025 2:00 am",2025-12-04,33.0,https://azureguardtakp.gamerlaunch.com/rapid_raid/raid_details.php?raid_pool=562569&raidId=1598436&gid=547766
```

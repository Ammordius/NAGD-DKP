# Raid type classification (prototype)

Classify raids by **type** (PoTime, Vex Thal, Elemental, Kael, God, etc.) so we can analyze DKP earned/spent by raid type over time. This prototype uses the **2-28 Supabase backup** (or `data/` CSVs) and does **not** modify the database.

## Data sources

- **Primary:** `raid_name` — keyword/regex rules (e.g. "Time", "VT", "Fire minis", "Doze").
- **Secondary:** `raid_loot` item names — used only to suggest a type when the name did not match (many elemental loots drop in multiple places, so loot is **not** definitive).

## Getting the data

The 2-28 backup is a zip containing a tar.gz:

1. Extract the zip: `Expand-Archive -Path supabase-backup-2026-02-28.zip -DestinationPath backup_2_28`
2. Extract the tar: `tar -xzf backup_2_28/backup-2026-02-28.tar.gz -C backup_2_28`
3. You get `backup_2_28/backup/raids.csv`, `raid_loot.csv`, `raid_dkp_totals.csv`, etc.

Alternatively use existing `data/raids.csv` and `data/raid_loot.csv` if you have them.

## Running the classifier

From repo root:

```bash
# Using existing data/
python scripts/classify_raid_types.py

# Using 2-28 backup
python scripts/classify_raid_types.py \
  --raids backup_2_28/backup/raids.csv \
  --loot backup_2_28/backup/raid_loot.csv \
  --dkp-totals backup_2_28/backup/raid_dkp_totals.csv \
  --out-dir data \
  --show-unclassified 50
```

## Outputs

| File | Description |
|------|-------------|
| `data/raid_type_assignments.csv` | One row per raid: `raid_id`, `raid_type`, `raid_name`, `date_iso`, `source` (name \| loot) |
| `data/raid_type_summary.json` | Counts by type (all time + recent), DKP by type (recent), and **DKP by month and type** for the last 24 months |

The script prints a summary and a sample of unclassified raid names so you can add rules.

## Raid types (current rules)

- **PoTime** — Plane of Time (Time Day, P1–P5, Quarm, etc.)
- **Vex Thal** — VT
- **Elemental** — Fire/Water/Earth/Air minis, Fennin, Coirnav, Cursed/Emperor
- **ToV** — Temple of Veeshan, Vulak, Zlandicar, NToV, WToV
- **Kael** — Dozekar, AOW, Statue, KT, Tormax, Dain
- **God** — TVX, Tunare, Sol Ro, Nagafen, Vox, Bertox, Saryrn, etc.
- **Sleeper** — Sleeper's Tomb, Trakanon, UDB
- **Rathe Council**, **Praesertum**, **Burrower**, **Ssra**, **Akheva**
- **Unclassified** — no rule matched (tune rules using sample output)

## Tuning

Edit `scripts/classify_raid_types.py`: list `RAID_TYPE_RULES` (order matters; first match wins). Add regex patterns for abbreviations your guild uses (e.g. "SolRo", "P1 - P3", "SLEEPERS TOMB"). Re-run and check "Sample unclassified" to reduce Unclassified.

## What this enables

- **DKP by raid type over time** — use `raid_type_summary.json` → `dkp_by_type_recent` and `dkp_by_month_and_type` to see how much DKP is earned per type in the last 3 years and per month.
- **Spent by type** — once you have `raid_type` on raids (or a join table), you can sum loot cost per raid_type from `raid_loot` + `raid_type_assignments`.

## Next steps (if prototype looks good)

1. **DB:** Add a `raid_type` column to `raids` (or a `raid_raid_type` table). Backfill from `raid_type_assignments.csv` or run the classifier in CI after backup/import.
2. **Website:** Expose raid type in raid list/detail; add a view or filter for "DKP by raid type" (earned/spent over time).
3. **Refresh:** When new raids are added, either re-run the classifier and upsert `raid_type`, or have officers set type manually with a dropdown.

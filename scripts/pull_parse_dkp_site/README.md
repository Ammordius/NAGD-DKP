# Pull & parse: existing DKP site

Scripts that **pull data from the legacy DKP site** (e.g. GamerLaunch Rapid Raid) and **parse** it into CSVs and Supabase.

**Scope:** One-time or periodic migration/import. Not used by the live website at runtime.

- **Pull:** `pull_raids.py`, `pull_raid_attendees.py`, `pull_roster_full.py`, `pull_linked_toons.py`, `pull_site.py`, `fetch_one_char.py`, `fetch_raid_samples.py`
- **Parse:** `extract_structured_data.py`, `parse_raid_attendees.py`, `refresh_raid_index.py`
- **Upload to Supabase:** `upload_saved_raids_supabase.py`, `upload_raid_detail_to_supabase.py`, `update_raid_name_supabase.py`, `upload_zerodkp_rolls_supabase.py`, `dedupe_raid_event_attendance_by_account.py`
- **Ground truth / verification:** `build_ground_truth_csv.py`, `build_account_display_names_from_ground_truth.py`, `compare_dkp_ground_truth.py`, `compare_active_vs_ground_truth.py`, `verify_dkp_adjustments.py`, `verify_website_vs_ground_truth.py`
- **Log audit (0 DKP rolls):** `audit_log_zerodkp_rolls.py`, `dkp_log_extract_gui.py`, `run_audit_zerodkp_takpv22.ps1`
- **Other:** `backfill_event_times.py`, `update_supabase_event_times.py`, `import_character_main_list.py`

Run from **repo root** so paths like `data/`, `raids/` resolve:

```bash
python scripts/pull_parse_dkp_site/extract_structured_data.py
python scripts/pull_parse_dkp_site/pull_raids.py
# etc.
```

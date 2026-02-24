# Investigation: Frinop 2/39 and 2/72 Despite Two Recent Raids

## What you see

- **Display:** Frinop — Balance 14, Earned 1897, Spent 1883, **2/39 (5%)**, **2/72 (3%)**
- **Expected:** He was on **Water Minis + Coirnav** (2026-02-24, Earned 2/2 DKP) and **PoTime Day 2** (2026-02-20, Earned 2/3 DKP), so 30d and 60d activity should be higher than 2.

The **30d** and **60d** columns are **DKP earned in the last 30 and 60 days** (numerator) over **total DKP available in that period** (denominator). So "2/39" means Frinop’s `earned_30d = 2` and the period total is 39.

## Likely causes

1. **Two keys, only one has recent DKP**  
   Frinop can appear in `dkp_summary` under two `character_key`s: **char_id `21990375`** and **name `Frinop`**.  
   - The app merges them by character name and sums `earned_30d` / `earned_60d`.  
   - If the **recent raids** (Water Minis, PoTime) were imported only under one key (e.g. name `Frinop`) and that row was **removed or zeroed** (e.g. by a name-only dedupe or by `frinop_remove_name_only_row.sql`), then only the other key’s 30d/60d (e.g. 2 and 2) would show.

2. **Recent raids not in `raid_event_attendance` for Frinop**  
   `refresh_dkp_summary_internal()` computes `earned_30d` / `earned_60d` **only from `raid_event_attendance`** (plus `raid_events` and `raids`).  
   - If Water Minis and PoTime have no rows for Frinop (by `char_id = '21990375'` or `character_name = 'Frinop'`), his 30d/60d will not include that DKP.  
   - Possible reasons: raids not imported, attendee list not parsed for those raids, or Frinop listed under a different key (e.g. typo, extra space).

3. **Raid dates outside the window**  
   The 30d/60d window uses `raids.date_iso` via `raid_date_parsed(r.date_iso) >= (current_date - 30)` (and 60).  
   - If `date_iso` for those two raids is wrong or null, they won’t count in 30d/60d.

4. **Past fix removed char_id attendance**  
   `docs/frinop_remove_name_only_row.sql` **deletes all `raid_event_attendance` and `raid_attendance` where `char_id = '21990375'`** to force everything onto the name key.  
   - If that was run and the **new** raids were later added with **char_id 21990375** (not name-only), you’d have a char_id row again.  
   - If instead the new raids were never re-imported or were only on the name key and something else removed them, you’d end up with only the old name-key DKP (e.g. 2 in 30d/60d).

## How to confirm

Run **`docs/diagnose_frinop_30d_60d_attendance.sql`** in the Supabase SQL Editor. It:

1. Shows **dkp_summary** for Frinop (both keys) and their `earned_30d` / `earned_60d`.
2. Lists **recent raids** (Water Minis, PoTime, etc.) and their `date_iso` and whether they fall in 30d/60d.
3. Lists **raid_event_attendance** for Frinop in the last 60 days (this is what drives 30d/60d).
4. Shows **raid_attendance_dkp** for Frinop in the last 60 days.
5. Shows **expected 30d/60d** from `raid_attendance_dkp` by key.
6. Shows the **per-key sum** from `raid_event_attendance` (same logic as `refresh_dkp_summary`).

Interpretation:

- If **step 3** has **no rows** for Water Minis and PoTime for Frinop → cause is **missing attendance** for those raids (re-import or fix parse/upload).
- If **step 2** shows those raids with **wrong or null `date_iso`** → fix **raids.date_iso** and run `refresh_dkp_summary()`.
- If **step 1** shows two rows and one has **0** for `earned_30d`/`earned_60d` and the other has **2/2** → recent DKP is only on one key; ensure both keys’ attendance is present and consistent, then run **`docs/fix_duplicate_tic_attendance_and_prevent.sql`** (to remove true duplicates only) and **`refresh_dkp_summary()`**.

## Recommended fix (after running the diagnostic)

1. **If attendance is missing for the two raids:**  
   Re-import or re-parse those raids so Frinop appears in `raid_event_attendance` (prefer **char_id = 21990375** and `character_name = 'Frinop'` so he has one key). Then run:

   ```sql
   SELECT refresh_all_raid_attendance_totals();
   SELECT refresh_dkp_summary();
   ```

2. **If `date_iso` is wrong for those raids:**  
   Update `raids.date_iso` for the affected `raid_id`s, then:

   ```sql
   SELECT refresh_dkp_summary();
   ```

3. **If Frinop has two keys and the “name” key has the recent raids but was partially removed:**  
   Do **not** re-run `frinop_remove_name_only_row.sql` (it wipes char_id 21990375). Ensure **raid_event_attendance** has one row per (raid, event, character): use **char_id 21990375** where possible and remove only true duplicates with **`fix_duplicate_tic_attendance_and_prevent.sql`**, then refresh.

4. **If you want a single key for Frinop:**  
   Prefer **char_id 21990375** (linked via `character_account`). Add missing tics with `char_id = '21990375'` and `character_name = 'Frinop'`; remove name-only duplicates for the same (raid_id, event_id) or same raid with **fix_duplicate_tic_attendance_and_prevent.sql**, then refresh.

After any fix, run the diagnostic again and confirm step 6 shows the expected 30d/60d sums and the UI shows the correct 30d/60d fractions.

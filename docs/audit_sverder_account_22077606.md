# Audit: Sverder account 22077606

**Purpose:** Verify that account 22077606 (sverder) does not have DKP for raids he did not attend. No DB changes—audit only.

**Suspect raids (should NOT have account 22077606):**

| Raid (approx) | Date |
|---------------|------|
| SSra-Again! | 2024-01-31 |
| 12/7/18 PRAES/SERU | 2018-12-07 |
| 12/4/18 A SUMMONED BURROWER | 2018-12-04 |
| 1Dec - AC Burrower + Emp Ssra | 2018-12-02 |
| XTC & HIGH PRIEST | 2018-11-25 |
| RHAGS 1,2, ARCH LICH & CURSED CYCLE | 2018-11-23 |
| 11/19/18 RHAGS & ARCH LICH | 2018-11-19 |
| 15Nov - AL and Cursed | 2018-11-16 |
| 11Nov - KT, Statue, AOW | 2018-11-12 |

## How to run

1. Open Supabase SQL Editor.
2. Run the queries in **`audit_sverder_account_22077606.sql`** in order (sections 1–7).
3. Paste or summarize the result sets below (or in a separate doc).

## Result sets (fill after run)

- **Section 1:** Account 22077606 and its character(s) (char_id, name).
- **Section 2:** Raids on the suspect dates; `has_tic_attendance` = true if that raid uses per-event (tic) attendance.
- **Section 3:** Per-raid audit: for each suspect-date raid, counts for account 22077606:
  - `in_raid_attendance` (1 = in `raid_attendance`)
  - `tic_attendance_rows` (rows in `raid_event_attendance`)
  - `dkp_earned_for_raid` (from `raid_attendance_dkp`)
- **Section 4:** Any `raid_event_attendance` (tic) rows for sverder on these raids — includes **char_id** and **character_name** (which toon was on the tic). **If user is correct, this should be empty.**
- **Section 5:** Any `raid_attendance` rows for sverder on these raids — includes **char_id** and **character_name** (which toon was given raid-level credit).
- **Section 6:** All `raid_attendance_dkp` rows for sverder on these raids — includes **character_key** and **character_name** (which toon got credited). DKP that would be removed.
- **Section 6b:** Same as 6 but labeled as “which character got credited per raid” (credited_as_key, credited_character_name).
- **Section 6c:** **WHY he got credited** — one row per raid: credited_character_name, dkp_earned, tic_rows_for_this_char, on_raid_attendance_list, and **why_credited** (e.g. "raid_event_attendance (listed on tics)" or "raid_attendance (raid-level list)"). Run 6c alone if your editor only shows the last result.
- **Section 7:** Summary: number of raids affected and total DKP to remove.

## How to interpret

- **DKP source:** If a raid has **tic attendance** (`raid_event_attendance`), earned DKP comes only from tics. If it has **no** tic attendance, DKP comes from `raid_attendance` (full raid credit).
- **Wrong credit:** If section 3 shows `dkp_earned_for_raid > 0` but section 4 is empty (no tic rows) for that raid, then either:
  - The raid has no tics and he’s in `raid_attendance` (section 5); or
  - There is data inconsistency (e.g. `raid_attendance_dkp` not refreshed from tics).
- **User’s claim:** “Not on tics” → we expect section 4 to be empty. If section 4 has rows, either the claim is wrong or the tic data is wrong (separate check).

## Recommendation (after reviewing results)

1. **If section 4 has rows** (sverder on tics for these raids): Decide whether to remove those **`raid_event_attendance`** rows (and then run `refresh_raid_attendance_totals(raid_id)` per raid and `refresh_dkp_summary()`).
2. **If section 5 has rows and section 4 is empty** (sverder only in legacy `raid_attendance`): Remove those **`raid_attendance`** rows for the suspect raids, then for each affected raid run `refresh_raid_attendance_totals(raid_id)`, then run `refresh_dkp_summary()`.
3. **After any removals:** Re-run section 7 to confirm total DKP removed; optionally run the Barndog-style account total query for 22077606 to confirm new earned/balance.

Do **not** run any DELETE or refresh until officers confirm the audit and approve the fix.

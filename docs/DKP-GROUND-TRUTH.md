# DKP totals vs official (ground truth)

## Ground truth files

- **ground_truth_sum.txt** or **ground_truth.txt** – Official DKP export from GamerLaunch (paste/save as-is).
- **data/ground_truth_dkp.csv** – Parsed canonical list: `character_name`, `earned`, `spent`, `balance`. Regenerate with:
  ```bash
  python build_ground_truth_csv.py
  ```
  Or from `ground_truth.txt`: `python verify_website_vs_ground_truth.py ground_truth.txt --csv data/ground_truth_dkp.csv` (and use the printed table to verify).

### Verify the website matches ground truth

Run the expected-values table and optionally export CSV, then compare to the DKP page (Earned, Spent, Balance per character):

```bash
python verify_website_vs_ground_truth.py ground_truth.txt
python verify_website_vs_ground_truth.py ground_truth.txt --csv data/expected_for_website.csv
```

Open your DKP site and check that the leaderboard matches the printed table (or the CSV).

Local computed totals (`python compute_dkp.py` → `data/dkp_totals.csv`) match this ground truth when you use **per-event attendance** (see below). Run `python compare_dkp_ground_truth.py` to verify; you should see ~90+ matches with Diff +0.0 and a few small −1 to −2 differences.

---

When we compare `data/dkp_totals.csv` (from `python compute_dkp.py`) to the official DKP export (e.g. **ground_truth_sum.txt**):

- **Spent** matches: we use the same loot and costs from `raid_loot.csv`.
- **Earned** is usually **higher** in our computation.

## Why earned is higher

We use **raid-level attendance**: everyone on the raid’s attendee list gets the **sum of all that raid’s event DKP**. The official GamerLaunch Rapid Raid system likely uses **per-event attendance**: you only get an event’s DKP if you were on **that event’s** attendee list (e.g. “On-Time attendance” has its own list; “1 Hour Single/Double Boxing” has another).

- Our scrape only has the **single raid attendee list** (from `<a name='attendees'>` on each raid details page).
- We do **not** scrape per-event attendee lists (they may be on “by Event” views like `raid_details_attendees.php`).
- So we credit everyone on the raid for every event’s DKP, and we **over-credit** when someone was on the raid but not on every event’s list.

To match the official numbers: run `pull_raid_attendees.py` to fetch the "by Event" pages into `raids/raid_{id}_attendees.html`; then parse those and use in `compute_dkp.py`. Alternatively we would need to scrape or infer **per-event attendance** and only add an event’s DKP for characters who attended that event.

## Optional: restrict by date

If the official pool has a start date (e.g. “NAGD Pool commenced 1 Jan 2018”), you can reduce earned to raids on or after that date:

```bash
python compute_dkp.py --since-date 2018-01-01
```

This uses `data/raids.csv` `date_iso`; only attendance at raids with `date_iso >= 2018-01-01` is counted. It can bring totals closer but will not fix the per-event vs raid-level difference.

## After per-event attendance (current pipeline)

1. Run `pull_raid_attendees.py` to fetch the "by Event" page for each raid → `raids/raid_{id}_attendees.html`.
2. Run `parse_raid_attendees.py` to parse those files → `data/raid_event_attendance.csv`.
3. Run `compute_dkp.py`; it uses `raid_event_attendance.csv` when present for earned.
4. Run `python compare_dkp_ground_truth.py` to compare to `ground_truth_sum.txt`.

With this, earned/spent/balance match ground truth for almost all characters (a few small differences, e.g. −1 to −2 DKP on a handful of names, likely from rounding or a single event missing in the attendee HTML).

## Example comparison (before per-event fix)

| Character       | Official earned | Our earned | Diff (ours − official) |
|----------------|-----------------|------------|-------------------------|
| Inacht         | 4,990           | 5,091      | +101                    |
| Baily          | 2,686           | 2,929      | +243                    |
| Dula Allazaward| 2,037           | 2,590      | +553                    |

After per-event attendance: Inacht, Baily, Radda, Dula Allazaward, etc. all show **Diff +0.0**.

---

## Redo Supabase backend (so the website matches ground truth)

### Option A: Full reset (truncate all tables, then re-import)

1. **Run the reset script in Supabase SQL Editor**
   - Open **docs/supabase-reset-and-import.sql** and run the whole file.
   - This truncates all DKP data tables and inserts the **one-off DKP adjustments** (so the few characters that were off by 1–2 DKP match ground truth exactly).

2. **Import these CSVs** in Table Editor, in this order:

   | Table | CSV |
   |-------|-----|
   | characters | data/characters.csv |
   | accounts | data/accounts.csv |
   | character_account | data/character_account.csv |
   | raids | data/raids.csv |
   | raid_events | data/raid_events.csv |
   | **raid_loot** | **data/raid_loot.csv** |
   | raid_attendance | data/raid_attendance.csv |
   | **raid_event_attendance** | **data/raid_event_attendance.csv** |
   | raid_classifications | data/raid_classifications_import.csv (or data/raid_classifications.csv) |
   | dkp_adjustments | (already filled by the reset script; or import data/dkp_adjustments.csv) |

3. **Redeploy or refresh** the frontend. The DKP page applies **dkp_adjustments** (earned_delta, spent_delta) so displayed totals match ground truth.

### Option B: First-time or schema change

1. Run **docs/supabase-schema.sql** in SQL Editor (creates tables including **dkp_adjustments**).
2. Import the CSVs in the same order as above. Then run the INSERT block from **docs/supabase-reset-and-import.sql** (dkp_adjustments rows), or import **data/dkp_adjustments.csv**.

### How adjustments work

- **Formula:** `displayed = base + adjustment` (we add `earned_delta` to earned, `spent_delta` to spent). So the value in the table is “what to add” to match GT: `(earned_delta, spent_delta) = (GT_earned - base_earned, GT_spent - base_spent)`.
- If base later equals GT (e.g. after a re-import or pipeline fix), **remove** that character’s row from `dkp_adjustments` or the app will over-correct (e.g. Elrontaur: base was already 310, so +21 spent pushed displayed to 331).
- **Verify:** Run `python verify_dkp_adjustments.py` after `python compute_dkp.py` to see recommended vs current adjustments and which rows to remove or update.
- **Anmordius vs Ammordius:** “Anmordius” (1 DKP at bottom of roster) is a different character row (likely typo/alt); the adjustment `(Ammordius, 1, 0)` applies only to the character named “Ammordius” and is correct.

### One-off adjustments (7 characters)

| character_name | earned_delta | spent_delta |
|----------------|-------------|-------------|
| Bhodi | 2 | 2 |
| Gheff | 10 | 10 |
| Pursuit | 2 | 2 |
| Pugnacious | 1 | 0 |
| Barndog | 2 | 0 |
| Handolur | 2 | 0 |
| Hamorf | 1 | 0 |
(Ammordius removed: after merging typo Anmordius into Ammordius, base earned = 820 = GT.)

### Check row counts

- **raid_loot**: thousands of rows (or Spent = 0 on the site).
- **raid_event_attendance**: many rows (or Earned won’t match ground truth).

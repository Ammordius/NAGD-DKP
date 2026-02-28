# DKP triggers and storage audit

Audit of triggers, where DKP data is stored, and the workflow for adding DKP from the website or upload backend. Goal: **fast, correct** updates without full-table refreshes when only one raid changes.

---

## 1. Source-of-truth tables (canonical data)

| Table | Purpose |
|-------|---------|
| **raids** | One row per raid (raid_id, raid_name, date_iso, …). |
| **raid_events** | Tics per raid (event_id, dkp_value, event_order, …). |
| **raid_event_attendance** | Who earned DKP for which tic (raid_id, event_id, char_id, character_name, account_id). |
| **raid_attendance** | Raid-level attendee list (raid_id, char_id, character_name). |
| **raid_loot** | Loot assignments and cost (raid_id, event_id, item_name, char_id, character_name, cost). |
| **character_account** | Links character → account (char_id, account_id). |
| **characters** | Character names and ids. |
| **accounts** | Account display names. |

All “add DKP” flows write to these. No DKP totals are stored here; they are derived.

---

## 2. Derived / cache tables (refreshed from source)

| Table | Source | Who updates it |
|-------|--------|-----------------|
| **dkp_summary** | raid_event_attendance + raid_loot (character_key = char_id or name) | Triggers (delta + full) + RPC `refresh_dkp_summary()` |
| **account_dkp_summary** | raid_event_attendance + raid_loot, aggregated by account | RPC only: `refresh_account_dkp_summary_internal()` or `refresh_account_dkp_summary_for_raid(raid_id, extra_account_ids)` |
| **raid_dkp_totals** | raid_events (sum dkp_value per raid_id) | Trigger: `refresh_raid_attendance_totals(raid_id)` |
| **raid_attendance_dkp** | raid_event_attendance + raid_events, per character per raid | Same trigger |
| **raid_attendance_dkp_by_account** | Same, per account per raid | Same trigger (account-dkp-schema version of `refresh_raid_attendance_totals`) |
| **dkp_period_totals** | raid_events in last 30d / 60d | `refresh_dkp_summary_internal()` and `refresh_account_dkp_summary_internal()` |

The **leaderboard** reads **account_dkp_summary** when present (account-scoped DKP). So that table must be updated whenever attendance or loot for a raid changes.

---

## 3. Triggers (supabase-schema.sql)

All DKP triggers check **restore_load_in_progress()** and no-op when true (bulk restore path).

### 3.1 Raid totals (per raid only — fast)

| Event | Trigger | Action |
|-------|---------|--------|
| **raid_events** INSERT/UPDATE/DELETE | `refresh_raid_totals_after_events_*` | `refresh_raid_attendance_totals(NEW/OLD.raid_id)` |
| **raid_event_attendance** INSERT/UPDATE/DELETE | `refresh_raid_totals_after_event_attendance_*` | `refresh_raid_attendance_totals(NEW/OLD.raid_id)` |

So: **raid_dkp_totals**, **raid_attendance_dkp**, and (with account-dkp-schema) **raid_attendance_dkp_by_account** are updated **only for the affected raid**. No full scan.

### 3.2 Character DKP summary (dkp_summary)

| Event | Trigger | Action |
|-------|---------|--------|
| **raid_event_attendance** INSERT | `delta_dkp_after_event_attendance` | Incremental: add earned to dkp_summary by character_key (ON CONFLICT DO UPDATE). Does **not** set earned_30d/earned_60d. |
| **raid_event_attendance** UPDATE/DELETE | `full_refresh_dkp_after_event_attendance_change` | `refresh_dkp_summary_internal()` — full TRUNCATE + rebuild. |
| **raid_attendance** INSERT | `delta_dkp_after_attendance` | Incremental add (no 30d/60d). |
| **raid_attendance** UPDATE/DELETE | `full_refresh_dkp_after_attendance_change` | Full refresh. |
| **raid_loot** INSERT | `delta_dkp_after_loot` | Incremental add spent. |
| **raid_loot** UPDATE/DELETE | `full_refresh_dkp_after_loot_change` | Full refresh. |

So: **account_dkp_summary is never updated by any trigger.** Only RPCs update it.

---

## 4. Restore-load mode (bulk import)

- **begin_restore_load()** sets `restore_in_progress.in_progress = true` → all DKP triggers no-op.
- **end_restore_load()** (in account-dkp-schema) clears the flag, then runs:
  - `fix_serial_sequences_for_restore()`
  - `refresh_dkp_summary()` → character dkp_summary
  - `refresh_all_raid_attendance_totals()` → every raid’s raid_dkp_totals / raid_attendance_dkp / raid_attendance_dkp_by_account
  - `refresh_account_dkp_summary_internal()` → account_dkp_summary

Used by **restore_supabase_from_backup.py** and **diff_inactive_tic_loot_dry_run.py --apply** (with begin/end around tic inserts). Full refresh after bulk load is correct.

---

## 5. Website flow (Officer / RaidDetail)

When an officer adds a tic, adds an attendee to a tic, or removes an attendee:

1. **INSERT/UPDATE/DELETE** on **raid_events**, **raid_event_attendance**, or **raid_attendance** → triggers run (see above).
2. **App then calls:**
   - `refresh_dkp_summary()` — full rebuild of **dkp_summary** (so earned_30d/earned_60d are correct; delta trigger does not set them).
   - `refresh_account_dkp_summary_for_raid(raid_id [, extra_account_ids])` — updates **account_dkp_summary** only for accounts with attendance in that raid (and, on remove, the removed account).

Result:

- **account_dkp_summary**: only that raid’s accounts are updated → **fast**.
- **dkp_summary**: full rebuild every time → correct but **heavier**. Acceptable for single-raid edits; if we ever want to avoid it we’d need delta triggers to maintain earned_30d/earned_60d or a per-character refresh.

---

## 6. Upload backend (upload_raid_detail_to_supabase.py)

- Deletes existing data for the raid (via **delete_raid_for_reupload** RPC or table deletes).
- Inserts **raid_events**, **raid_loot**, **raid_attendance**, **raid_event_attendance**.
- Then calls **refresh_dkp_summary()** and **refresh_account_dkp_summary()**.

**Issue:** **refresh_account_dkp_summary()** does a full TRUNCATE + rebuild of account_dkp_summary. For a single-raid upload that’s slow and unnecessary.

**Fix:** After uploading one raid, call **refresh_account_dkp_summary_for_raid(raid_id)** instead of **refresh_account_dkp_summary()**. That updates only accounts that have attendance in that raid. Same correctness, much faster.

---

## 7. delete_raid_for_reupload RPC

After deleting one raid’s rows it runs:

- `refresh_dkp_summary_internal()`
- `refresh_raid_attendance_totals(raid_id)` (no-op for that raid once data is gone; keeps other state consistent)
- `refresh_account_dkp_summary_internal()` (if present)

So after a delete we do a **full** account summary refresh. That is correct (every account that had that raid loses that DKP). It is heavier; we could in theory compute affected account_ids before delete and call `refresh_account_dkp_summary_for_raid(raid_id, affected_account_ids)` after, but the RPC doesn’t have that today. Acceptable for “delete one raid” frequency.

---

## 8. Correctness checklist

| Scenario | raid_* source tables | raid_dkp_totals / raid_attendance_dkp(_by_account) | dkp_summary | account_dkp_summary |
|----------|----------------------|----------------------------------------------------|-------------|----------------------|
| Add tic (website) | INSERT by app | Trigger per raid ✓ | App: full refresh ✓ | App: per-raid refresh ✓ |
| Add attendee (website) | INSERT by app | Trigger per raid ✓ | App: full refresh ✓ | App: per-raid refresh ✓ |
| Remove attendee (website) | DELETE by app | Trigger per raid ✓ | Trigger full + app full ✓ | App: per-raid + extra_account_ids ✓ |
| Upload one raid (script) | INSERT by script | Triggers fire ✓ | App: full refresh ✓ | **Should use per-raid** (see fix below) |
| Bulk restore | INSERT with begin_restore_load | end_restore_load ✓ | end_restore_load ✓ | end_restore_load ✓ |
| Delete raid for reupload | RPC DELETE | RPC refresh_raid_attendance_totals ✓ | RPC full ✓ | RPC full ✓ |

---

## 9. Recommendation: upload script

In **scripts/pull_parse_dkp_site/upload_raid_detail_to_supabase.py**, after inserting the raid’s data, replace:

```python
client.rpc("refresh_account_dkp_summary").execute()
```

with:

```python
client.rpc("refresh_account_dkp_summary_for_raid", {"p_raid_id": raid_id}).execute()
```

(and keep `refresh_dkp_summary()` so character summary and 30d/60d stay correct). If **refresh_account_dkp_summary_for_raid** is not present (old DB), fall back to **refresh_account_dkp_summary** so the script still works.

---

## 10. Summary

- **Triggers** keep **raid_dkp_totals**, **raid_attendance_dkp**, and **raid_attendance_dkp_by_account** in sync per raid; they do **not** update **account_dkp_summary**.
- **account_dkp_summary** is updated only by RPCs: full refresh (restore, delete-raid) or **refresh_account_dkp_summary_for_raid** (website and, after fix, upload script).
- Website flow is **fast and correct** for the edited raid; upload script should use the same per-raid account refresh for a **fast, correct** single-raid upload.

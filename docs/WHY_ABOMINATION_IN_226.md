# Why is Abomination in the "would be added" list (226)?

## Two different ways of matching

| Script | What it checks | Result for Abomination |
|--------|----------------|------------------------|
| **Upload (message (8).txt)** | Character **name** in `characters` table and in `character_account` | "Abomination" (name) exists and is linked → 0 to create |
| **Diff (inactive raiders)** | **char_id** from the CSV in `character_account` | CSV uses char_id **21973208**; that id is not in `character_account` → **unlinked** → in 226 |

So:

- The **CSV** (raid_event_attendance.csv from the DKP site) has rows like `...,21973208,Abomination`. The diff script only cares: *is char_id 21973208 in `character_account`?* If not → unlinked.
- The **DB** already has "Abomination" linked under account Abomination via a **different** char_id (e.g. the account’s own id or another id). So by **name**, Abomination is in the DB and linked (upload script is correct).
- The **numeric char_id from the DKP site** (21973208) is either missing from `character_account` or not linked to account Abomination. So by **char_id**, the CSV’s Abomination is unlinked (diff is correct).

So Abomination appears in the 226 because the **CSV’s char_id** (21973208) is not linked to any account, even though the **name** "Abomination" is already linked under account Abomination with some other char_id.

## Fix

Link the **CSV’s char_id** to the existing account:

1. Ensure `characters` has a row for char_id `21973208` with name `Abomination` (if missing, insert it).
2. Insert into `character_account`: `(char_id = '21973208', account_id = '<existing Abomination account_id>')`.

Then the diff script will see 21973208 in `character_account` and will **not** put Abomination in the 226.

The script `scripts/pull_parse_dkp_site/link_csv_char_ids_to_existing_accounts.py` does this for all names that match an existing account (the 84 from the dry run): it links each CSV char_id for that name to the existing account so they drop out of the 226.

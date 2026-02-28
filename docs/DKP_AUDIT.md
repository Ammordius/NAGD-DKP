# DKP audit: Gamer Launch vs Supabase

Automated audit of the **Current Member DKP** page from Gamer Launch against Supabase account-level DKP totals.

## Web app: account migration (add-to-tic and tic paste)

When officers add characters to a DKP tic (either via **Add attendee to tic** or by pasting a channel list in **Add DKP tic**), DKP is credited to the **linked account** (not just the character). The backend uses `character_account` and `raid_attendance_dkp_by_account` / `account_dkp_summary`, so:

- Adding a character to a tic gives DKP to that character's account (if linked in `character_account`).
- The DKP leaderboard and account detail pages show account-level totals; the "Credited" and "Added to tic" messages in the Officer UI refer to the character, but the balance that updates is the account's.

**Refresh:** After each tic/attendee change, the app calls `refresh_dkp_summary()` and **`refresh_account_dkp_summary_for_raid(raid_id)`**, which updates `account_dkp_summary` only for accounts that have attendance in that raid (plus the removed account when removing an attendee). No full refresh over all raids. If you deployed before this change, run **docs/fix_refresh_dkp_summary_includes_account_summary.sql** in Supabase to create `refresh_account_dkp_summary_for_raid`.

So when we add characters to a tic, we are using account migration and the messages are still meaningful (character name for clarity; DKP applies to the account).

## Why it works in the browser / pull-raids but not “direct” to members

- **Browser:** You’ve already opened another rapid_raid page (e.g. Raids or Lists). The server then treats the next request (e.g. DKP) as part of the same “rapid_raid” session and may rely on cookies/state set on that first page.
- **pull_raids:** The first request is to `raids.php?mode=past&gid=547766&ts=3:1`. That establishes the session; later requests (e.g. `raid_details.php`) use the same session and work.
- **pull_members_dkp (without warmup):** The first (and only) request is straight to `members.php`. The server may not treat that as part of an established rapid_raid session and can respond with the login page even with valid cookies.

So the script does a **warmup** request to the same raids list URL that pull_raids uses, then requests `members.php`. That matches the browser flow (open raids/list first, then DKP) and uses the same session.

## Source

- **URL:** https://azureguardtakp.gamerlaunch.com/rapid_raid/members.php?gid=547766
- **Auth:** Requires a logged-in session (Cookie header in `cookies.txt`).

## One-command audit (recommended)

From repo root:

- **PowerShell:** `.\raids.ps1 audit-dkp`
- **Make:** `make audit-dkp`

This will:

1. Download the members DKP page to `data/members_dkp.html` (using `cookies.txt`).
2. Parse it to `data/members_dkp_snapshot.json`.
3. Emit `docs/audit_dkp_snapshot_vs_db.sql` (run in Supabase SQL Editor for an instant account-level diff).
4. Run the Python audit against Supabase and write `data/audit_dkp_result.json`.

**Exit code:** `0` = all accounts match; `1` = mismatches or missing accounts.

## Step-by-step

1. **Save the page** (while logged in): use the browser’s default name  
   `Current Member DKP - Rapid Raid _ Nephilim, Azure Guard and Destiny - Custom Server - Everquest - Guild Hosting - Gamer Launch.html`  
   and save it in the repo root or in `data/`.

2. Parse and audit (from repo root):

```bash
# If you saved as the long name in repo root or data/:
python scripts/pull_parse_dkp_site/parse_members_dkp_html.py parse data/members_dkp.html -o data/members_dkp_snapshot.json --emit-sql docs/audit_dkp_snapshot_vs_db.sql
python scripts/pull_parse_dkp_site/parse_members_dkp_html.py audit data/members_dkp_snapshot.json --json-out data/audit_dkp_result.json
```

The script will find `Current Member DKP*.html` in the repo root or `data/` if `data/members_dkp.html` is missing.

## Instrumentation

- **Timestamped log lines:** Audit prints lines like `[2026-02-28T12:00:00Z] audit_start`, `audit_complete snapshot=... matched=... missing=... mismatches=... ok=true|false`, and `wrote_json path=...` for automation.
- **Machine-readable result:** Use `--json-out path` to write an audit result JSON:
  - `ok`: true if no missing accounts and no mismatches
  - `snapshot_accounts`, `matched`, `missing_in_db`, `mismatches_count`
  - `missing`: list of snapshot accounts not matched to any DB account
  - `mismatches`: list of accounts where HTML earned/spent ≠ DB totals (with deltas)
- **Exit codes:** `pull_members_dkp.py` returns 2 (missing cookies), 3 (HTTP error), 4 (page looks like login/challenge). Parse/audit returns 1 when there are mismatches or missing accounts.

## Prereqs

- `cookies.txt`: One line with your Gamer Launch Cookie header (e.g. from Chrome DevTools → Network → request → copy Cookie).
- `.env` or `web/.env`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_ANON_KEY`) for the audit step.
- Python deps: `requests`, `beautifulsoup4`, `lxml`, `supabase` (and `python-dotenv` optional).

# CI database backup (legacy CSV export)

Retired. The scheduled CSV export and its GitHub Action are gone. Portable recovery is [CI-DB-SQL-BACKUP.md](CI-DB-SQL-BACKUP.md). Restore that artifact with [CI-DB-SQL-RESTORE.md](CI-DB-SQL-RESTORE.md).

Historical `supabase-backup-*` artifacts already stored in GitHub Actions are not deleted. A `supabase-backup-*` file is not an SQL backup. An `sql-backup-*` file is not a CSV tree.

The public ledger still diffs unexpired CSV artifacts. It does not receive new ones. See [SQL-LEDGER.md](SQL-LEDGER.md).

A downloaded CSV tree can still be loaded locally with [scripts/restore_supabase_from_backup.py](../scripts/restore_supabase_from_backup.py). See [RESTORE-BACKUP.md](RESTORE-BACKUP.md) and [CI-DB-RESTORE.md](CI-DB-RESTORE.md).

# Legacy CSV restore

The manual GitHub Action that reloaded a `supabase-backup-*` artifact is retired. Portable recovery is [CI-DB-SQL-RESTORE.md](CI-DB-SQL-RESTORE.md).

Historical `supabase-backup-*` artifacts are not deleted. This procedure does not accept an `sql-backup-*` artifact.

To reload a CSV tree you already have, use [RESTORE-BACKUP.md](RESTORE-BACKUP.md) and [scripts/restore_supabase_from_backup.py](../scripts/restore_supabase_from_backup.py). Authentication and accounts are never touched.

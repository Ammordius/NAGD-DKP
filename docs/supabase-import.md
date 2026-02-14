# Importing data into Supabase

After running `docs/supabase-schema.sql` in the SQL Editor:

1. **Import CSVs**  
   In Supabase: Table Editor → select table → click "Import data from CSV".  
   Use the files in `data/` (from project root):
   - `characters.csv` → **characters**
   - `accounts.csv` → **accounts**
   - `character_account.csv` → **character_account**
   - `raids.csv` → **raids**
   - `raid_events.csv` → **raid_events**
   - `raid_loot.csv` → **raid_loot**
   - `raid_attendance.csv` → **raid_attendance**

2. **Column mapping**  
   Map CSV columns to the table columns (names should match).  
   If Supabase complains about types (e.g. empty string vs number), you can:
   - Edit the CSV to use `\N` or leave numeric columns empty instead of blank string for numbers, or
   - Temporarily allow nullable text for numeric columns, import, then fix in SQL.

3. **First officer**  
   Create your user in Authentication → Users (sign up once in the app or add via dashboard).  
   Copy the user UUID, then in SQL Editor run:
   ```sql
   UPDATE profiles SET role = 'officer' WHERE id = 'paste-your-user-uuid-here';
   ```

4. **Optional: disable email confirm**  
   For a private guild site you can turn off "Confirm email" in Authentication → Providers → Email so sign-ups can log in immediately.

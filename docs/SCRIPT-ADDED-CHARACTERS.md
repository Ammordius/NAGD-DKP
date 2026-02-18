# Script-added characters and why they might not be recognized

If you added characters to accounts with a **local script** instead of the in-app "Add character to account" (RPC), they can fail to show in DKP tick tracker, loot, and Add attendee for two reasons.

## 1. Officer page only loaded the first 5,000 characters (fixed)

The Officer page used to load characters with `.limit(5000)`. With 5,000+ characters in the DB, newly added ones could be outside that set and never appear in tick/loot/attendee. **This is now fixed:** Officer loads all characters via pagination.

## 2. Script didn’t match what the RPC does

The RPC `add_character_to_my_account` does **both** of these:

1. **Ensure the character exists in `characters`**  
   - If not found by name or `char_id`, it inserts:  
     `INSERT INTO characters (char_id, name) VALUES (v_char_id_use, v_name_trim)`  
   - `v_char_id_use` = optional server char_id override, or the character **name** if no override.

2. **Link to the account**  
   - `INSERT INTO character_account (char_id, account_id)` with the same `char_id`.

So for the app to “recognize” a character everywhere (account list, Officer tick/loot/add attendee), you need:

- A row in **`characters`** with `char_id` and `name` (and `char_id` used consistently).
- A row in **`character_account`** with that same `char_id` and the account’s `account_id`.

If your script only wrote **`character_account`** (e.g. because the RPC “didn’t work” and you used a client that can’t insert into `characters` due to RLS), then the account page might still show the link (by char_id), but Officer tick/loot/attendee rely on the **`characters`** table for names; if the character isn’t there, it won’t be recognized.

**RLS note:** The `characters` table has only **SELECT** policies for the app. The only way to **insert** into `characters` from the app is via the RPC (SECURITY DEFINER). So a script using the normal Supabase anon/authenticated key cannot insert into `characters`; it can only insert into `character_account` (for your own claimed account). To create new characters from a script you need either the RPC, Supabase SQL Editor, or service role.

## Repair: ensure every linked character has a `characters` row

Run this in the Supabase SQL Editor to add any missing `characters` rows for `character_account` links (e.g. from a script that only wrote links). It uses the same convention as the RPC: `char_id` = character name when creating a new row.

```sql
-- Add missing characters rows for any character_account link that has no characters row.
-- Uses char_id as name when inserting (same as RPC when creating new).
INSERT INTO characters (char_id, name)
SELECT ca.char_id, COALESCE(NULLIF(TRIM(ca.char_id), ''), 'Unknown')
FROM character_account ca
LEFT JOIN characters c ON c.char_id = ca.char_id
WHERE c.char_id IS NULL
ON CONFLICT (char_id) DO NOTHING;
```

After running this, reload the Officer page; those characters should then appear in tick tracker, loot parsing, and Add attendee.

## Mirroring the RPC in your own script

If you want your script to behave like the RPC:

1. **Resolve or create the character**
   - If you have a server `char_id`: use it as `characters.char_id` and set `name` to the display name.
   - If you don’t: use the character **name** as both `char_id` and `name` (same as RPC for new chars).

2. **Insert into `characters` first** (if the row doesn’t exist):  
   `INSERT INTO characters (char_id, name) VALUES (...)`  
   Use `ON CONFLICT (char_id) DO NOTHING` or `DO UPDATE SET name = EXCLUDED.name` if you want to support re-runs.

3. **Then insert the link**:  
   `INSERT INTO character_account (char_id, account_id) VALUES (...)`  
   `ON CONFLICT (char_id, account_id) DO NOTHING`.

4. Run your script with a client that can insert into `characters` (e.g. SQL Editor or service role). The normal app key cannot insert into `characters` due to RLS.

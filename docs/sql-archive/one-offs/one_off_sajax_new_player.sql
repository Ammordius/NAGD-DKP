-- One-off: new player Sajax (earned=1, spent=0)
-- Root cause: raid attendance/loot had character_name='Sajax' with no accounts,
-- characters, or character_account rows, so refresh never credited the 1 DKP.
--
-- Convention matches import_character_main_list (single-toon main):
--   account_id = display_name = char_id = 'Sajax'
--
-- Re-run safe (ON CONFLICT / idempotent updates). Run in Supabase SQL Editor
-- with service role.

-- 1) Create account
INSERT INTO public.accounts (account_id, display_name, toon_count, char_ids, toon_names)
VALUES ('Sajax', 'Sajax', 1, 'Sajax', 'Sajax')
ON CONFLICT (account_id) DO UPDATE SET
  display_name = EXCLUDED.display_name;

-- 2) Create character + link
INSERT INTO public.characters (char_id, name)
VALUES ('Sajax', 'Sajax')
ON CONFLICT (char_id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO public.character_account (char_id, account_id)
VALUES ('Sajax', 'Sajax')
ON CONFLICT (char_id, account_id) DO NOTHING;

-- 3) Stamp attendance / loot that matched by name only
UPDATE public.raid_event_attendance
SET char_id = 'Sajax',
    account_id = 'Sajax'
WHERE trim(COALESCE(character_name, '')) ILIKE 'sajax'
  AND (char_id IS NULL OR trim(char_id::text) = '' OR trim(char_id::text) ILIKE 'sajax');

UPDATE public.raid_attendance
SET char_id = 'Sajax',
    character_name = COALESCE(NULLIF(trim(character_name), ''), 'Sajax')
WHERE trim(COALESCE(character_name, '')) ILIKE 'sajax'
   OR (char_id IS NOT NULL AND trim(char_id::text) ILIKE 'sajax');

UPDATE public.raid_loot
SET char_id = 'Sajax',
    character_name = COALESCE(NULLIF(trim(character_name), ''), 'Sajax')
WHERE trim(COALESCE(character_name, '')) ILIKE 'sajax'
  AND (char_id IS NULL OR trim(char_id::text) = '' OR trim(char_id::text) ILIKE 'sajax');

-- 4) Sync denormalized account toon fields
UPDATE public.accounts a
SET toon_count = COALESCE((
      SELECT COUNT(DISTINCT ca.char_id)::integer
      FROM public.character_account ca
      WHERE ca.account_id = a.account_id
    ), 0),
    toon_names = (
      SELECT string_agg(DISTINCT COALESCE(c.name, ca.char_id), ', ' ORDER BY COALESCE(c.name, ca.char_id))
      FROM public.character_account ca
      LEFT JOIN public.characters c ON c.char_id = ca.char_id
      WHERE ca.account_id = a.account_id
    ),
    char_ids = (
      SELECT string_agg(DISTINCT ca.char_id, ',' ORDER BY ca.char_id)
      FROM public.character_account ca
      WHERE ca.account_id = a.account_id
    )
WHERE a.account_id = 'Sajax';

-- 5) Refresh account DKP cache
SELECT public.refresh_account_dkp_summary_internal();

-- 6) Verify (expect earned=1, spent=0)
SELECT account_id, display_name, earned, spent
FROM public.account_dkp_summary
WHERE account_id = 'Sajax';

-- One-off: account 6185d321-af04-4ecf-a34d-f80af7fdf864 (Bugglegup)
-- Root cause: create_account left an empty UUID account; raid attendance had
-- character_name='Bugglegup' with char_id/account_id null. No characters or
-- character_account rows, so refresh never credited the 3 DKP.
--
-- Applied 2026-07-27 via service SQL. Re-run safe (ON CONFLICT / idempotent updates).

-- 1) Confirm account
SELECT account_id, display_name, toon_count
FROM public.accounts
WHERE account_id = '6185d321-af04-4ecf-a34d-f80af7fdf864';

-- 2) Create character + link
INSERT INTO public.characters (char_id, name)
VALUES ('Bugglegup', 'Bugglegup')
ON CONFLICT (char_id) DO UPDATE SET name = EXCLUDED.name;

INSERT INTO public.character_account (char_id, account_id)
VALUES ('Bugglegup', '6185d321-af04-4ecf-a34d-f80af7fdf864')
ON CONFLICT (char_id, account_id) DO NOTHING;

-- 3) Stamp attendance (raid 1599220 had 3 tics @ 1 DKP)
UPDATE public.raid_event_attendance
SET char_id = 'Bugglegup',
    account_id = '6185d321-af04-4ecf-a34d-f80af7fdf864'
WHERE trim(COALESCE(character_name, '')) ILIKE 'bugglegup'
  AND (char_id IS NULL OR trim(char_id::text) = '' OR trim(char_id::text) ILIKE 'bugglegup');

UPDATE public.raid_attendance
SET char_id = 'Bugglegup',
    character_name = COALESCE(NULLIF(trim(character_name), ''), 'Bugglegup')
WHERE trim(COALESCE(character_name, '')) ILIKE 'bugglegup'
   OR (char_id IS NOT NULL AND trim(char_id::text) ILIKE 'bugglegup');

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
WHERE a.account_id = '6185d321-af04-4ecf-a34d-f80af7fdf864';

-- 5) Refresh account DKP cache
SELECT public.refresh_account_dkp_summary_internal();

-- 6) Verify (expect earned=3, spent=0)
SELECT account_id, display_name, earned, spent
FROM public.account_dkp_summary
WHERE account_id = '6185d321-af04-4ecf-a34d-f80af7fdf864';

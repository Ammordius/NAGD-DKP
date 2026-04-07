-- Optional one-off: detect multiple characters rows for the same display name (e.g. upload vs manual).
-- Run in Supabase SQL Editor. Replace 'Kalmic' if checking another name.

SELECT char_id, name, class_name, level
FROM public.characters
WHERE trim(name) ILIKE 'kalmic'
ORDER BY char_id;

-- character_account links for those char_ids
SELECT ca.char_id, ca.account_id, a.display_name
FROM public.character_account ca
JOIN public.accounts a ON a.account_id = ca.account_id
WHERE ca.char_id IN (
  SELECT char_id FROM public.characters WHERE trim(name) ILIKE 'kalmic'
);

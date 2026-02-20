-- Abomination DKP total check
-- Run in Supabase SQL Editor. character_key can be name 'Abomination' or char_id '21973208'.

-- 1) dkp_summary (cached totals: earned, spent, 30d/60d)
SELECT
  character_key,
  character_name,
  earned,
  spent,
  (dkp_summary.earned - dkp_summary.spent) AS net_dkp,
  earned_30d,
  earned_60d,
  last_activity_date,
  updated_at
FROM dkp_summary
WHERE character_key IN ('Abomination', '21973208')
   OR character_name ILIKE 'Abomination';

-- 2) Account linkage (which account(s) Abomination is under)
SELECT a.account_id, a.display_name, c.char_id, c.name AS character_name
FROM character_account ca
JOIN accounts a ON a.account_id = ca.account_id
JOIN characters c ON c.char_id = ca.char_id
WHERE c.name ILIKE 'Abomination'
   OR ca.char_id = '21973208';

-- 3) Raid attendance row count (ground truth for earned)
SELECT
  COALESCE(rea.char_id::text, '(empty)') AS char_id,
  rea.character_name,
  COUNT(*) AS tic_count
FROM raid_event_attendance rea
WHERE rea.character_name ILIKE 'Abomination'
   OR rea.char_id = '21973208'
GROUP BY rea.char_id, rea.character_name;

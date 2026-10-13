-- Recompute accounts.toon_count from live character_account links.
-- Safe to re-run.

BEGIN;

-- Update existing accounts using actual linked character counts.
UPDATE accounts a
SET toon_count = COALESCE(src.cnt, 0)
FROM (
  SELECT ca.account_id, COUNT(DISTINCT ca.char_id)::integer AS cnt
  FROM character_account ca
  GROUP BY ca.account_id
) src
WHERE a.account_id = src.account_id;

-- Ensure accounts with no linked characters are set to 0.
UPDATE accounts a
SET toon_count = 0
WHERE NOT EXISTS (
  SELECT 1
  FROM character_account ca
  WHERE ca.account_id = a.account_id
)
AND COALESCE(a.toon_count, -1) <> 0;

COMMIT;

-- Verification: compare persisted toon_count with live link count.
SELECT
  a.account_id,
  a.toon_count AS stored_toon_count,
  COALESCE(live.live_toon_count, 0) AS live_toon_count,
  (a.toon_count IS DISTINCT FROM COALESCE(live.live_toon_count, 0)) AS mismatch
FROM accounts a
LEFT JOIN (
  SELECT ca.account_id, COUNT(DISTINCT ca.char_id)::integer AS live_toon_count
  FROM character_account ca
  GROUP BY ca.account_id
) live ON live.account_id = a.account_id
ORDER BY mismatch DESC, a.account_id;

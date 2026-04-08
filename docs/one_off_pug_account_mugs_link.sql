-- One-off: pug account 8e2bf572-6e04-480f-8b1e-09ed772a04b3 — Mugs loot not on account
-- Run in Supabase SQL Editor (officer session or service role). Run SELECT sections first; then link; then refresh.
-- Root cause: account-level spent requires character_account; create_account does not attach toons. Link Mugs, then refresh.

-- -----------------------------------------------------------------------------
-- 1) Confirm account and list linked toons
-- -----------------------------------------------------------------------------
SELECT account_id, display_name FROM public.accounts
WHERE account_id = '8e2bf572-6e04-480f-8b1e-09ed772a04b3';

SELECT ca.char_id, c.name
FROM public.character_account ca
LEFT JOIN public.characters c ON c.char_id = ca.char_id
WHERE ca.account_id = '8e2bf572-6e04-480f-8b1e-09ed772a04b3';

-- -----------------------------------------------------------------------------
-- 2) Resolve Mugs char_id and check for conflicting character_account rows
-- -----------------------------------------------------------------------------
SELECT char_id, name FROM public.characters
WHERE trim(name) ILIKE 'mugs';

SELECT ca.account_id, ca.char_id, a.display_name
FROM public.character_account ca
LEFT JOIN public.accounts a ON a.account_id = ca.account_id
WHERE ca.char_id IN (SELECT char_id FROM public.characters WHERE trim(name) ILIKE 'mugs');

-- If Mugs is linked to a different account, remove or fix that row before linking to the pug account (officer decision).

-- -----------------------------------------------------------------------------
-- 3) Loot rows involving Mugs (verify buyer / assignment)
-- -----------------------------------------------------------------------------
SELECT rl.id, rl.raid_id, rl.item_name, rl.char_id, rl.character_name, rl.cost,
       la.assigned_char_id, la.assigned_character_name
FROM public.raid_loot rl
LEFT JOIN public.loot_assignment la ON la.loot_id = rl.id
WHERE trim(COALESCE(la.assigned_character_name, rl.character_name, '')) ILIKE '%mugs%'
   OR trim(COALESCE(la.assigned_char_id, rl.char_id, '')) IN (
        SELECT char_id FROM public.characters WHERE trim(name) ILIKE 'mugs'
      );

-- -----------------------------------------------------------------------------
-- 4) Link Mugs to the pug account (replace <Mugs_char_id> with value from step 2)
-- -----------------------------------------------------------------------------
-- INSERT INTO public.character_account (char_id, account_id)
-- VALUES ('<Mugs_char_id>', '8e2bf572-6e04-480f-8b1e-09ed772a04b3')
-- ON CONFLICT (char_id, account_id) DO NOTHING;

-- Prefer in-app: Officer opens /accounts/8e2bf572-6e04-480f-8b1e-09ed772a04b3 → Characters → add Mugs (RPC add_character_to_my_account).

-- -----------------------------------------------------------------------------
-- 5) Refresh materialized DKP caches
-- -----------------------------------------------------------------------------
-- SELECT public.refresh_dkp_summary();
-- SELECT public.refresh_account_dkp_summary();

-- Targeted (optional): if you only want to recompute accounts tied to one raid plus this account id:
-- SELECT public.refresh_account_dkp_summary_for_raid(
--   '<raid_id_from_step_3>',
--   ARRAY['8e2bf572-6e04-480f-8b1e-09ed772a04b3']::text[]
-- );

-- -----------------------------------------------------------------------------
-- 6) Verify account totals
-- -----------------------------------------------------------------------------
-- SELECT account_id, display_name, earned, spent, earned_30d, earned_60d, last_activity_date
-- FROM public.account_dkp_summary
-- WHERE account_id = '8e2bf572-6e04-480f-8b1e-09ed772a04b3';

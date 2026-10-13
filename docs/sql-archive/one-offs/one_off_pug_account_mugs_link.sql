-- One-off: pug account 8e2bf572-6e04-480f-8b1e-09ed772a04b3 — Mugs / Pugs loot on account
-- Run in Supabase SQL Editor (officer session or service role). Run SELECT sections first; then link; then refresh.
-- Root cause: account-level spent requires character_account; create_account does not attach toons. Link each toon, then refresh.
--
-- IMPORTANT: public.characters.char_id is often the character NAME string (e.g. 'Pugs', 'Mugs'), not a Magelo numeric id.
-- character_account.char_id REFERENCES characters(char_id). If raid_loot has char_id = '22082884' but characters only has
-- char_id = 'Pugs', you get FK error 23503 on insert, AND spent DKP never resolves (join does not match). Fix both:
--   1) INSERT character_account using the canonical char_id from characters (e.g. 'Pugs').
--   2) UPDATE raid_loot SET char_id = 'Pugs', character_name = 'Pugs' WHERE id = <loot_id>.
--
-- Re-upload: scripts/pull_parse_dkp_site/upload_raid_detail_to_supabase.py --apply resolves DKP-site numeric char=
-- to canonical public.characters.char_id using character_name (so manual UPDATE raid_loot is usually unnecessary
-- after reupload). Re-upload deletes and re-inserts raid_loot for that raid_id, so raid_loot.id values change;
-- dependent rows keyed by old loot ids (e.g. loot_assignment, officer_bid_portfolio_for_loot) may need backfill.

-- -----------------------------------------------------------------------------
-- 0) Pugs — Blade of War (example loot id 15500, raid 1598854) — numeric char_id mismatch
-- -----------------------------------------------------------------------------
-- Uncomment and run after confirming the row still matches (adjust id if needed):
--
 SELECT id, raid_id, char_id, character_name, item_name, cost FROM public.raid_loot WHERE id = 15500;
 INSERT INTO public.character_account (char_id, account_id)
 VALUES ('Pugs', '8e2bf572-6e04-480f-8b1e-09ed772a04b3')
 ON CONFLICT (char_id, account_id) DO NOTHING;

 UPDATE public.raid_loot
 SET char_id = 'Pugs', character_name = 'Pugs'
 WHERE id = 15500;
 SELECT public.refresh_dkp_summary();
 SELECT public.refresh_account_dkp_summary();

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
-- 4) Link Mugs to the pug account (char_id must match public.characters — usually 'Mugs')
-- -----------------------------------------------------------------------------
-- INSERT INTO public.character_account (char_id, account_id)
-- VALUES ('Mugs', '8e2bf572-6e04-480f-8b1e-09ed772a04b3')
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

-- Fixture + SQL-side checks for account_character_spent().
-- Node companion compares the same snapshot to buildSpentByAccountFromLoot (exact equality).
-- Prefixed ids/names avoid collisions with other disposable PG fixtures (e.g. Buyer).

INSERT INTO public.accounts (account_id, display_name) VALUES
  ('parity-acct-1', 'ParityMain1'),
  ('parity-acct-2', 'ParityMain2')
ON CONFLICT (account_id) DO NOTHING;

INSERT INTO public.characters (char_id, name) VALUES
  ('parity-100', 'ParityBuyer'),
  ('parity-101', 'ParityAlt'),
  ('parity-200', 'ParityTwin'),
  ('parity-201', 'paritybuyer'),
  ('parity-300', 'ParityAmbiguous'),
  ('parity-301', 'ParityAmbiguous')
ON CONFLICT (char_id) DO NOTHING;

INSERT INTO public.character_account (char_id, account_id) VALUES
  ('parity-100', 'parity-acct-1'),
  ('parity-101', 'parity-acct-1'),
  ('parity-200', 'parity-acct-2'),
  ('parity-201', 'parity-acct-2'),
  ('parity-300', 'parity-acct-1'),
  ('parity-301', 'parity-acct-2')
ON CONFLICT DO NOTHING;

INSERT INTO public.raids (raid_id, raid_name, date_iso, date)
VALUES ('raid-spent-parity', 'Spent Fixture', '2025-06-01', '2025-06-01')
ON CONFLICT (raid_id) DO NOTHING;

SET session_replication_role = replica;

INSERT INTO public.raid_loot (id, raid_id, item_name, char_id, character_name, cost) VALUES
  (900001, 'raid-spent-parity', 'Item A', 'parity-100', 'ParityBuyer', '12'),
  (900002, 'raid-spent-parity', 'Item B', 'parity-100', 'ParityBuyer', '40'),
  (900003, 'raid-spent-parity', 'Item C', NULL, 'ParityBuyer', '5'),
  (900004, 'raid-spent-parity', 'Item D', 'parity-100', NULL, '7'),
  (900005, 'raid-spent-parity', 'Item E', 'parity-200', 'ParityTwin', '3'),
  (900006, 'raid-spent-parity', 'Item F', 'parity-200', 'ParityTwin', 'not-a-number'),
  (900007, 'raid-spent-parity', 'Item G', NULL, 'ParityAmbiguous', '11'),
  (900008, 'raid-spent-parity', 'Item H', NULL, 'PARITYBUYER', '2.5'),
  (900009, 'raid-spent-parity', 'Item I', 'parity-999', 'ParityStranger', '9'),
  (900010, 'raid-spent-parity', 'Item J', 'parity-100', 'ParityBuyer', '10.25')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.loot_assignment (loot_id, assigned_char_id, assigned_character_name) VALUES
  (900001, NULL, 'ParityAlt'),
  (900005, 'parity-200', NULL)
ON CONFLICT (loot_id) DO NOTHING;

SET session_replication_role = DEFAULT;

DO $$
DECLARE
  v_got numeric;
BEGIN
  SELECT total_spent INTO v_got FROM public.account_character_spent()
  WHERE account_id = 'parity-acct-1' AND character_key = 'ParityAlt';
  IF v_got IS DISTINCT FROM 12 THEN
    RAISE EXCEPTION 'parity-acct-1/ParityAlt got %, want 12', v_got;
  END IF;

  -- 40 + 5 + 10.25 (PARITYBUYER does not match ParityBuyer case-sensitively)
  SELECT total_spent INTO v_got FROM public.account_character_spent()
  WHERE account_id = 'parity-acct-1' AND character_key = 'ParityBuyer';
  IF v_got IS DISTINCT FROM 55.25 THEN
    RAISE EXCEPTION 'parity-acct-1/ParityBuyer got %, want 55.25', v_got;
  END IF;

  SELECT total_spent INTO v_got FROM public.account_character_spent()
  WHERE account_id = 'parity-acct-1' AND character_key = 'parity-100';
  IF v_got IS DISTINCT FROM 7 THEN
    RAISE EXCEPTION 'parity-acct-1/parity-100 got %, want 7', v_got;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_character_spent() WHERE character_key = 'PARITYBUYER'
  ) THEN
    RAISE EXCEPTION 'PARITYBUYER must not match ParityBuyer (case-sensitive name fallback)';
  END IF;

  SELECT total_spent INTO v_got FROM public.account_character_spent()
  WHERE account_id = 'parity-acct-2' AND character_key = 'ParityAmbiguous';
  IF v_got IS DISTINCT FROM 11 THEN
    RAISE EXCEPTION 'parity-acct-2/ParityAmbiguous got %, want 11', v_got;
  END IF;

  SELECT total_spent INTO v_got FROM public.account_character_spent()
  WHERE account_id = 'parity-acct-2' AND character_key = 'parity-200';
  IF v_got IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'parity-acct-2/parity-200 got %, want 3', v_got;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.account_character_spent() WHERE character_key = 'ParityStranger'
  ) THEN
    RAISE EXCEPTION 'ParityStranger should not appear';
  END IF;

  IF (
    SELECT CASE
      WHEN btrim(coalesce('12.5', '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN btrim('12.5')::numeric
      ELSE NULL
    END
  ) IS DISTINCT FROM 12.5 THEN
    RAISE EXCEPTION 'numeric cost parse failed';
  END IF;
  IF (
    SELECT CASE
      WHEN btrim(coalesce('not-a-number', '')) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN btrim('not-a-number')::numeric
      ELSE NULL
    END
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'nonnumeric cost must be rejected';
  END IF;

END $$;

-- Row 900006 is skipped by account_character_spent (nonnumeric). Remove under
-- replica role so delete triggers do not cast cost::numeric.
SET session_replication_role = replica;
DELETE FROM public.raid_loot WHERE id = 900006;
SET session_replication_role = DEFAULT;

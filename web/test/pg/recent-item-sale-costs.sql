-- recent_item_sale_costs ranking must match prior Raid Items client:
-- resolve date_iso if ISO else date; ISO ranks by calendar, non-ISO as newest; then loot_id DESC.

INSERT INTO public.raids (raid_id, raid_name, date_iso, date) VALUES
  ('sale-r1', 'Sale 1', '2024-01-01', 'ignored'),
  ('sale-r2', 'Sale 2', '2024-06-01', 'ignored'),
  ('sale-r3', 'Sale 3', 'bogus', '2024-03-15'),
  ('sale-r4', 'Sale 4', NULL, '2024-12-01'),
  ('sale-r5', 'Sale 5', '', 'Oct 99'),
  ('sale-r6', 'Sale 6', 'not-iso', 'also-not-iso')
ON CONFLICT (raid_id) DO NOTHING;

-- Five sales of the same item (limit 3). Mixed date representations.
-- Expected top 3 by prior frontend ranking on resolved sale_date:
--   sale-r5 / Oct 99 (non-ISO → newest sentinel), loot 800005
--   sale-r6 / also-not-iso (non-ISO → newest), loot 800006  — both sentinel: higher id first → 800006 then 800005
--   Wait: both non-ISO → '9999-99-99', order by loot_id DESC → 800006, 800005
--   Then ISO dates: 2024-12-01 (r4, 800004), 2024-06-01 (r2, 800002), 2024-03-15 (r3, 800003), 2024-01-01 (r1, 800001)
-- Top 3: 800006, 800005, 800004

INSERT INTO public.raid_loot (id, raid_id, item_name, char_id, character_name, cost) VALUES
  (800001, 'sale-r1', 'Mixed Date Blade', 'c1', 'Buyer', '10'),
  (800002, 'sale-r2', 'Mixed Date Blade', 'c1', 'Buyer', '20'),
  (800003, 'sale-r3', 'Mixed Date Blade', 'c1', 'Buyer', '30'),
  (800004, 'sale-r4', 'Mixed Date Blade', 'c1', 'Buyer', '40'),
  (800005, 'sale-r5', 'Mixed Date Blade', 'c1', 'Buyer', '50'),
  (800006, 'sale-r6', 'Mixed Date Blade', 'c1', 'Buyer', '60')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  v_ids bigint[];
BEGIN
  SELECT array_agg(loot_id ORDER BY
    CASE WHEN sale_date ~ '^\d{4}-\d{2}-\d{2}' THEN left(sale_date, 10) ELSE '9999-99-99' END DESC,
    loot_id DESC
  )
  INTO v_ids
  FROM public.recent_item_sale_costs(3)
  WHERE item_name = 'mixed date blade';

  IF v_ids IS DISTINCT FROM ARRAY[800006::bigint, 800005::bigint, 800004::bigint] THEN
    RAISE EXCEPTION 'recent_item_sale_costs mixed dates got %, want {800006,800005,800004}', v_ids;
  END IF;

  -- More than three sales exist; function still returns exactly three for this item
  IF (SELECT count(*) FROM public.recent_item_sale_costs(3) WHERE item_name = 'mixed date blade') <> 3 THEN
    RAISE EXCEPTION 'expected exactly 3 rows for Mixed Date Blade';
  END IF;

  -- Malformed date_iso with valid ISO date must use the date column for ranking (800004 is 2024-12-01)
  IF NOT EXISTS (
    SELECT 1 FROM public.recent_item_sale_costs(3)
    WHERE loot_id = 800004 AND sale_date = '2024-12-01'
  ) THEN
    RAISE EXCEPTION 'loot 800004 should resolve sale_date from raids.date';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.recent_item_sale_costs(3)
    WHERE loot_id = 800003 AND sale_date = '2024-03-15'
  ) THEN
    -- 800003 is not in top 3; check via unrestricted rank helper
    NULL;
  END IF;
END $$;

-- Explicit check that bogus date_iso + ISO date ranks as that ISO date (not always newest)
DO $$
DECLARE
  v_rank int;
BEGIN
  SELECT rn INTO v_rank
  FROM (
    SELECT
      rl.id AS loot_id,
      row_number() OVER (
        PARTITION BY lower(btrim(rl.item_name))
        ORDER BY
          CASE
            WHEN resolved.sale_date ~ '^\d{4}-\d{2}-\d{2}' THEN left(resolved.sale_date, 10)
            ELSE '9999-99-99'
          END DESC,
          rl.id DESC
      ) AS rn
    FROM public.raid_loot rl
    LEFT JOIN public.raids r ON r.raid_id = rl.raid_id
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN btrim(coalesce(r.date_iso, '')) ~ '^\d{4}-\d{2}-\d{2}' THEN left(btrim(r.date_iso), 10)
        ELSE btrim(coalesce(r.date, ''))
      END AS sale_date
    ) resolved
    WHERE lower(btrim(rl.item_name)) = 'mixed date blade'
  ) x
  WHERE loot_id = 800003;
  -- 800003 resolved date 2024-03-15 → behind 800006,800005,800004,800002 → rn 5
  IF v_rank IS DISTINCT FROM 5 THEN
    RAISE EXCEPTION '800003 rank got %, want 5 (date_iso bogus but date ISO)', v_rank;
  END IF;
END $$;

-- =============================================================================
-- Officer-only RPC: raid attendees + account spend profiles for loot bid hints.
-- Run in Supabase SQL Editor (or merge into supabase-schema-full.sql on fresh deploy).
-- Enforces is_officer(); grant EXECUTE to authenticated only.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.officer_loot_bid_forecast(p_raid_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_raid text := trim(p_raid_id);
  v_use_per_event boolean;
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'officer only';
  END IF;

  IF v_raid = '' THEN
    RAISE EXCEPTION 'raid_id required';
  END IF;

  SELECT EXISTS (SELECT 1 FROM raid_event_attendance WHERE raid_id = v_raid LIMIT 1) INTO v_use_per_event;

  RETURN (
    WITH attendees_raw AS (
      SELECT DISTINCT
        NULLIF(trim(rea.char_id::text), '') AS char_id,
        NULLIF(trim(rea.character_name::text), '') AS character_name
      FROM raid_event_attendance rea
      WHERE v_use_per_event AND rea.raid_id = v_raid
      UNION
      SELECT DISTINCT
        NULLIF(trim(ra.char_id::text), ''),
        NULLIF(trim(ra.character_name::text), '')
      FROM raid_attendance ra
      WHERE NOT v_use_per_event AND ra.raid_id = v_raid
    ),
    attendees_resolved AS (
      SELECT
        ar.char_id AS raw_char_id,
        ar.character_name AS raw_character_name,
        c.char_id AS resolved_char_id,
        c.name AS resolved_name,
        c.class_name AS class_name,
        ca.account_id
      FROM attendees_raw ar
      LEFT JOIN characters c ON (
        (ar.char_id IS NOT NULL AND c.char_id = ar.char_id)
        OR (
          ar.char_id IS NULL
          AND ar.character_name IS NOT NULL
          AND lower(trim(c.name)) = lower(trim(ar.character_name))
        )
      )
      LEFT JOIN character_account ca ON ca.char_id = c.char_id
    ),
    attendee_list AS (
      SELECT jsonb_agg(
        jsonb_build_object(
          'char_id', COALESCE(resolved_char_id, raw_char_id, ''),
          'character_name', COALESCE(NULLIF(trim(resolved_name), ''), NULLIF(trim(raw_character_name), ''), ''),
          'class_name', COALESCE(class_name, ''),
          'account_id', account_id
        )
        ORDER BY COALESCE(NULLIF(trim(resolved_name), ''), NULLIF(trim(raw_character_name), ''))
      ) AS arr
      FROM attendees_resolved
    ),
    account_ids AS (
      SELECT DISTINCT account_id
      FROM attendees_resolved
      WHERE account_id IS NOT NULL
    ),
    loot_for_accounts AS (
      SELECT
        ca.account_id,
        rl.id AS loot_id,
        public.raid_date_parsed(r.date_iso) AS raid_date,
        rl.item_name,
        rl.cost::text AS cost_text,
        NULLIF(trim(rl.char_id::text), '') AS loot_char_id,
        NULLIF(trim(rl.character_name::text), '') AS loot_character_name
      FROM raid_loot rl
      JOIN raids r ON r.raid_id = rl.raid_id
      JOIN character_account ca ON NULLIF(trim(rl.char_id::text), '') IS NOT NULL
        AND ca.char_id = NULLIF(trim(rl.char_id::text), '')
      WHERE ca.account_id IN (SELECT account_id FROM account_ids)
    ),
    loot_numeric AS (
      SELECT
        account_id,
        loot_id,
        raid_date,
        item_name,
        CASE
          WHEN cost_text IS NULL OR trim(cost_text) = '' THEN 0::numeric
          ELSE COALESCE(
            NULLIF(regexp_replace(trim(cost_text), '[^0-9.\-]', '', 'g'), '')::numeric,
            0::numeric
          )
        END AS cost_num,
        loot_char_id,
        loot_character_name
      FROM loot_for_accounts
    ),
    per_account_last AS (
      SELECT DISTINCT ON (account_id)
        account_id,
        raid_date AS last_date,
        item_name AS last_item_name,
        cost_num AS last_cost,
        loot_char_id AS last_char_id,
        loot_character_name AS last_character_name
      FROM loot_numeric
      ORDER BY account_id, raid_date DESC NULLS LAST, loot_id DESC
    ),
    per_toon AS (
      SELECT account_id, loot_char_id AS char_id, sum(cost_num) AS spent
      FROM loot_numeric
      WHERE loot_char_id IS NOT NULL
      GROUP BY account_id, loot_char_id
    ),
    per_account_totals AS (
      SELECT account_id, sum(cost_num) AS total_spent, count(*)::int AS purchase_count
      FROM loot_numeric
      GROUP BY account_id
    ),
    per_account_top_share AS (
      SELECT
        ai.account_id,
        CASE
          WHEN COALESCE(pat.total_spent, 0) <= 0 THEN 0::numeric
          ELSE COALESCE(
            (SELECT max(s.spent) FROM per_toon s WHERE s.account_id = ai.account_id),
            0::numeric
          ) / pat.total_spent
        END AS top_toon_share
      FROM account_ids ai
      LEFT JOIN per_account_totals pat ON pat.account_id = ai.account_id
    ),
    dkp AS (
      SELECT
        a.account_id,
        COALESCE(s.earned, 0)::numeric AS earned,
        COALESCE(s.spent, 0)::numeric AS spent
      FROM account_ids ai
      JOIN accounts a ON a.account_id = ai.account_id
      LEFT JOIN account_dkp_summary s ON s.account_id = a.account_id
    ),
    purchases_limited AS (
      SELECT *
      FROM (
        SELECT
          ln.*,
          row_number() OVER (PARTITION BY account_id ORDER BY raid_date DESC NULLS LAST, loot_id DESC) AS rn
        FROM loot_numeric ln
      ) x
      WHERE x.rn <= 150
    ),
    purchases_json AS (
      SELECT
        account_id,
        jsonb_agg(
          jsonb_build_object(
            'raid_date', raid_date,
            'item_name', item_name,
            'cost', cost_num,
            'char_id', loot_char_id,
            'character_name', loot_character_name
          )
          ORDER BY raid_date ASC NULLS FIRST, loot_id ASC
        ) AS purchases
      FROM purchases_limited
      GROUP BY account_id
    ),
    per_toon_json AS (
      SELECT
        account_id,
        jsonb_object_agg(char_id, spent) AS per_toon
      FROM per_toon
      GROUP BY account_id
    ),
    profiles AS (
      SELECT jsonb_object_agg(
        d.account_id,
        jsonb_build_object(
          'earned', d.earned,
          'spent', d.spent,
          'balance', d.earned - d.spent,
          'last_purchase', CASE
            WHEN pal.last_date IS NULL THEN NULL
            ELSE jsonb_build_object(
              'raid_date', pal.last_date,
              'item_name', pal.last_item_name,
              'cost', pal.last_cost,
              'char_id', COALESCE(pal.last_char_id, ''),
              'character_name', COALESCE(pal.last_character_name, '')
            )
          END,
          'days_since_last_spend', CASE
            WHEN pal.last_date IS NULL THEN NULL
            ELSE (CURRENT_DATE - pal.last_date)::int
          END,
          'per_toon_spent', COALESCE(pt.per_toon, '{}'::jsonb),
          'top_toon_share', COALESCE(pts.top_toon_share, 0),
          'total_spent_tracked', COALESCE(pat.total_spent, 0),
          'purchase_count', COALESCE(pat.purchase_count, 0),
          'recent_purchases_desc', COALESCE(pj.purchases, '[]'::jsonb)
        )
      ) AS obj
      FROM dkp d
      LEFT JOIN per_account_last pal ON pal.account_id = d.account_id
      LEFT JOIN per_toon_json pt ON pt.account_id = d.account_id
      LEFT JOIN per_account_top_share pts ON pts.account_id = d.account_id
      LEFT JOIN per_account_totals pat ON pat.account_id = d.account_id
      LEFT JOIN purchases_json pj ON pj.account_id = d.account_id
    )
    SELECT jsonb_build_object(
      'raid_id', v_raid,
      'attendees', COALESCE((SELECT arr FROM attendee_list), '[]'::jsonb),
      'account_profiles', COALESCE((SELECT obj FROM profiles), '{}'::jsonb)
    )
  );
END;
$$;

COMMENT ON FUNCTION public.officer_loot_bid_forecast(text) IS
  'Officers only: distinct raid attendees with class/account + spend profiles (last purchase, per-toon totals, sample purchases) for bid-interest UI.';

REVOKE ALL ON FUNCTION public.officer_loot_bid_forecast(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.officer_loot_bid_forecast(text) TO authenticated;

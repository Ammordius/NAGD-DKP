-- =============================================================================
-- Officer-only RPC: active roster + account spend profiles for global item bid hints.
-- Run in Supabase SQL Editor after officer_loot_bid_forecast and raid_date_parsed exist.
-- Requires public.is_officer(); GRANT EXECUTE to authenticated only.
--
-- normalize_item_name_for_lookup: keep behavior aligned with web/src/lib/itemNameNormalize.js
-- Optional performance: if LATERAL ref-price lookups are slow, consider a denormalized
-- raid_sale_date on raid_loot plus an index on (normalize_item_name_for_lookup(item_name), raid_sale_date DESC, id DESC).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.normalize_item_name_for_lookup(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $fn$
  SELECT regexp_replace(
    regexp_replace(
      trim(
        regexp_replace(
          lower(
            trim(
              regexp_replace(
                regexp_replace(COALESCE(p_name, ''), E'[\u2019\u2018''`]', '', 'g'),
                '-',
                ' ',
                'g'
              )
            )
          ),
          '\s+',
          ' ',
          'g'
        )
      ),
      '^[,.;:!?]+',
      '',
      'g'
    ),
    '[,.;:!?]+$',
    '',
    'g'
  );
$fn$;

COMMENT ON FUNCTION public.normalize_item_name_for_lookup(text) IS
  'Normalized item name for cross-table matching; keep in sync with web/src/lib/itemNameNormalize.js.';

CREATE OR REPLACE FUNCTION public.officer_global_bid_forecast(p_activity_days integer DEFAULT 120)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days int := COALESCE(p_activity_days, 120);
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'officer only';
  END IF;

  IF v_days < 1 OR v_days > 730 THEN
    RAISE EXCEPTION 'p_activity_days must be between 1 and 730';
  END IF;

  RETURN (
    WITH active_by_date AS (
      SELECT DISTINCT s.account_id
      FROM account_dkp_summary s
      JOIN accounts a ON a.account_id = s.account_id
      WHERE NOT COALESCE(a.inactive, false)
        AND s.last_activity_date IS NOT NULL
        AND s.last_activity_date >= (CURRENT_DATE - v_days)
    ),
    pinned AS (
      SELECT DISTINCT aa.account_id
      FROM active_accounts aa
      JOIN accounts a ON a.account_id = aa.account_id
      WHERE NOT COALESCE(a.inactive, false)
    ),
    active_account_ids AS (
      SELECT account_id FROM active_by_date
      UNION
      SELECT account_id FROM pinned
    ),
    guild_loot_base AS (
      SELECT
        rl.id AS loot_id,
        public.normalize_item_name_for_lookup(rl.item_name) AS norm_name,
        public.raid_date_parsed(r.date_iso) AS raid_date,
        CASE
          WHEN rl.cost IS NULL OR trim(rl.cost::text) = '' THEN 0::numeric
          ELSE COALESCE(
            NULLIF(regexp_replace(trim(rl.cost::text), '[^0-9.\-]', '', 'g'), '')::numeric,
            0::numeric
          )
        END AS cost_num
      FROM raid_loot rl
      JOIN raids r ON r.raid_id = rl.raid_id
      WHERE rl.item_name IS NOT NULL AND trim(rl.item_name) <> ''
    ),
    roster_by_account AS (
      SELECT
        aai.account_id,
        COALESCE(
          jsonb_agg(
            jsonb_build_object(
              'char_id', NULLIF(trim(c.char_id::text), ''),
              'name', COALESCE(NULLIF(trim(c.name), ''), ''),
              'class_name', COALESCE(NULLIF(trim(c.class_name), ''), '')
            )
            ORDER BY lower(trim(COALESCE(c.name, '')))
          ) FILTER (WHERE c.char_id IS NOT NULL),
          '[]'::jsonb
        ) AS characters
      FROM active_account_ids aai
      LEFT JOIN character_account ca ON ca.account_id = aai.account_id
      LEFT JOIN characters c ON c.char_id = ca.char_id
      GROUP BY aai.account_id
    ),
    roster_json AS (
      SELECT jsonb_agg(
        jsonb_build_object(
          'account_id', rba.account_id,
          'characters', rba.characters
        )
        ORDER BY rba.account_id
      ) AS arr
      FROM roster_by_account rba
    ),
    loot_for_accounts AS (
      SELECT
        ca.account_id,
        rl.id AS loot_id,
        public.raid_date_parsed(r.date_iso) AS raid_date,
        rl.item_name,
        public.normalize_item_name_for_lookup(rl.item_name) AS norm_name,
        rl.cost::text AS cost_text,
        NULLIF(trim(rl.char_id::text), '') AS loot_char_id,
        NULLIF(trim(rl.character_name::text), '') AS loot_character_name
      FROM raid_loot rl
      JOIN raids r ON r.raid_id = rl.raid_id
      JOIN character_account ca ON NULLIF(trim(rl.char_id::text), '') IS NOT NULL
        AND ca.char_id = NULLIF(trim(rl.char_id::text), '')
      WHERE ca.account_id IN (SELECT account_id FROM active_account_ids)
    ),
    loot_numeric AS (
      SELECT
        account_id,
        loot_id,
        raid_date,
        item_name,
        norm_name,
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
        aai.account_id,
        CASE
          WHEN COALESCE(pat.total_spent, 0) <= 0 THEN 0::numeric
          ELSE COALESCE(
            (SELECT max(s.spent) FROM per_toon s WHERE s.account_id = aai.account_id),
            0::numeric
          ) / pat.total_spent
        END AS top_toon_share
      FROM active_account_ids aai
      LEFT JOIN per_account_totals pat ON pat.account_id = aai.account_id
    ),
    dkp AS (
      SELECT
        a.account_id,
        COALESCE(s.earned, 0)::numeric AS earned,
        COALESCE(s.spent, 0)::numeric AS spent
      FROM active_account_ids aai
      JOIN accounts a ON a.account_id = aai.account_id
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
    purchases_with_ref AS (
      SELECT
        pl.account_id,
        pl.loot_id,
        pl.raid_date,
        pl.item_name,
        pl.norm_name,
        pl.cost_num,
        pl.loot_char_id,
        pl.loot_character_name,
        ref.ref_price_at_sale,
        CASE
          WHEN ref.ref_price_at_sale IS NOT NULL AND ref.ref_price_at_sale > 0 AND pl.cost_num > 0
          THEN (pl.cost_num / ref.ref_price_at_sale)::numeric
          ELSE NULL::numeric
        END AS paid_to_ref_ratio
      FROM purchases_limited pl
      LEFT JOIN LATERAL (
        SELECT avg(sub.cost_num) AS ref_price_at_sale
        FROM (
          SELECT gl.cost_num
          FROM guild_loot_base gl
          WHERE gl.norm_name = pl.norm_name
            AND gl.cost_num > 0
            AND (
              gl.raid_date < pl.raid_date
              OR (
                gl.raid_date IS NOT DISTINCT FROM pl.raid_date
                AND gl.loot_id < pl.loot_id
              )
            )
          ORDER BY gl.raid_date DESC NULLS LAST, gl.loot_id DESC
          LIMIT 3
        ) sub
      ) ref ON true
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
            'character_name', loot_character_name,
            'ref_price_at_sale', ref_price_at_sale,
            'paid_to_ref_ratio', paid_to_ref_ratio
          )
          ORDER BY raid_date ASC NULLS FIRST, loot_id ASC
        ) AS purchases
      FROM purchases_with_ref
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
      'activity_days', v_days,
      'roster', COALESCE((SELECT arr FROM roster_json), '[]'::jsonb),
      'account_profiles', COALESCE((SELECT obj FROM profiles), '{}'::jsonb)
    )
  );
END;
$$;

COMMENT ON FUNCTION public.officer_global_bid_forecast(integer) IS
  'Officers only: active accounts (recent activity or pinned) with roster characters + spend profiles including ref_price_at_sale per purchase.';

REVOKE ALL ON FUNCTION public.normalize_item_name_for_lookup(text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.officer_global_bid_forecast(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.officer_global_bid_forecast(integer) TO authenticated;

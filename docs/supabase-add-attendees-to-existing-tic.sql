-- Append missing attendees onto an existing tic.
-- Leaves the tic row, loot, and prior audit rows unchanged.
-- The attendance insert trigger credits only the new rows for this raid.
-- Not applied by this repository. Run manually against a non-production database when ready.

CREATE OR REPLACE FUNCTION public.add_attendees_to_existing_tic(
  p_raid_id TEXT,
  p_event_id TEXT,
  p_attendees JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  rec RECORD;
  v_account TEXT;
  v_canon TEXT;
  v_name TEXT;
  v_existing_chars TEXT[] := '{}';
  v_existing_accounts TEXT[] := '{}';
  v_existing_names TEXT[] := '{}';
  v_seen_chars TEXT[] := '{}';
  v_seen_accounts TEXT[] := '{}';
  v_seen_names TEXT[] := '{}';
  v_rows JSONB := '[]'::jsonb;
  v_added_names JSONB := '[]'::jsonb;
  v_already_names JSONB := '[]'::jsonb;
  v_same_names JSONB := '[]'::jsonb;
  v_invalid_names JSONB := '[]'::jsonb;
  v_added INT := 0;
  v_already INT := 0;
  v_same INT := 0;
  v_invalid INT := 0;
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can add attendees to tics';
  END IF;

  IF p_raid_id IS NULL OR trim(p_raid_id) = '' THEN
    RAISE EXCEPTION 'raid_id is required';
  END IF;
  IF p_event_id IS NULL OR trim(p_event_id) = '' THEN
    RAISE EXCEPTION 'event_id is required';
  END IF;
  IF p_attendees IS NULL OR jsonb_typeof(p_attendees) <> 'array' THEN
    RAISE EXCEPTION 'attendees must be an array';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM raid_events
    WHERE raid_id = trim(p_raid_id) AND event_id = trim(p_event_id)
  ) THEN
    RAISE EXCEPTION 'Tic not found';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT trim(rea.char_id)), '{}'::text[])
  INTO v_existing_chars
  FROM raid_event_attendance rea
  WHERE rea.raid_id = trim(p_raid_id)
    AND rea.event_id = trim(p_event_id)
    AND rea.char_id IS NOT NULL
    AND trim(rea.char_id) <> '';

  SELECT COALESCE(array_agg(DISTINCT account_id), '{}'::text[])
  INTO v_existing_accounts
  FROM (
    SELECT ca.account_id
    FROM raid_event_attendance rea
    JOIN character_account ca ON ca.char_id = rea.char_id
    WHERE rea.raid_id = trim(p_raid_id)
      AND rea.event_id = trim(p_event_id)
      AND ca.account_id IS NOT NULL
      AND trim(ca.account_id) <> ''
    UNION
    SELECT rea.account_id
    FROM raid_event_attendance rea
    WHERE rea.raid_id = trim(p_raid_id)
      AND rea.event_id = trim(p_event_id)
      AND rea.account_id IS NOT NULL
      AND trim(rea.account_id) <> ''
  ) accounts;

  SELECT COALESCE(array_agg(DISTINCT lower(trim(rea.character_name))), '{}'::text[])
  INTO v_existing_names
  FROM raid_event_attendance rea
  WHERE rea.raid_id = trim(p_raid_id)
    AND rea.event_id = trim(p_event_id)
    AND rea.character_name IS NOT NULL
    AND trim(rea.character_name) <> '';

  FOR rec IN
    SELECT
      NULLIF(trim(x->>'char_id'), '') AS char_id,
      trim(COALESCE(x->>'character_name', '')) AS character_name
    FROM jsonb_array_elements(p_attendees) AS x
  LOOP
    IF rec.char_id IS NULL THEN
      v_invalid := v_invalid + 1;
      v_invalid_names := v_invalid_names || jsonb_build_array(COALESCE(NULLIF(rec.character_name, ''), '(blank)'));
      CONTINUE;
    END IF;
    IF rec.char_id = ANY (v_seen_chars) THEN
      CONTINUE;
    END IF;
    v_seen_chars := array_append(v_seen_chars, rec.char_id);

    IF NOT EXISTS (SELECT 1 FROM characters c WHERE c.char_id = rec.char_id) THEN
      v_invalid := v_invalid + 1;
      v_invalid_names := v_invalid_names || jsonb_build_array(COALESCE(NULLIF(rec.character_name, ''), rec.char_id));
      CONTINUE;
    END IF;

    SELECT NULLIF(trim(c.name), '') INTO v_canon
    FROM characters c
    WHERE c.char_id = rec.char_id
    LIMIT 1;
    v_name := COALESCE(v_canon, NULLIF(rec.character_name, ''), rec.char_id);

    SELECT ca.account_id INTO v_account
    FROM character_account ca
    WHERE ca.char_id = rec.char_id
      AND ca.account_id IS NOT NULL
      AND trim(ca.account_id) <> ''
    LIMIT 1;

    IF rec.char_id = ANY (v_existing_chars) THEN
      v_already := v_already + 1;
      v_already_names := v_already_names || jsonb_build_array(v_name);
      IF v_account IS NOT NULL AND NOT (v_account = ANY (v_seen_accounts)) THEN
        v_seen_accounts := array_append(v_seen_accounts, v_account);
      END IF;
      CONTINUE;
    END IF;

    IF v_account IS NOT NULL AND (
      v_account = ANY (v_existing_accounts) OR v_account = ANY (v_seen_accounts)
    ) THEN
      v_same := v_same + 1;
      v_same_names := v_same_names || jsonb_build_array(v_name);
      CONTINUE;
    END IF;

    IF lower(v_name) = ANY (v_existing_names) OR lower(v_name) = ANY (v_seen_names) THEN
      v_already := v_already + 1;
      v_already_names := v_already_names || jsonb_build_array(v_name);
      CONTINUE;
    END IF;

    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'char_id', rec.char_id,
      'character_name', v_name,
      'account_id', v_account
    ));
    v_added_names := v_added_names || jsonb_build_array(v_name);
    v_seen_names := array_append(v_seen_names, lower(v_name));
    IF v_account IS NOT NULL THEN
      v_seen_accounts := array_append(v_seen_accounts, v_account);
    END IF;
    v_added := v_added + 1;
  END LOOP;

  IF v_added > 0 THEN
    SET LOCAL statement_timeout = '120s';

    INSERT INTO raid_event_attendance (raid_id, event_id, char_id, character_name, account_id)
    SELECT trim(p_raid_id), trim(p_event_id), x->>'char_id', x->>'character_name', NULLIF(x->>'account_id', '')
    FROM jsonb_array_elements(v_rows) AS x;

    INSERT INTO raid_attendance (raid_id, char_id, character_name)
    SELECT trim(p_raid_id), x->>'char_id', x->>'character_name'
    FROM jsonb_array_elements(v_rows) AS x
    WHERE NOT EXISTS (
      SELECT 1 FROM raid_attendance ra
      WHERE ra.raid_id = trim(p_raid_id) AND ra.char_id = x->>'char_id'
    );

    UPDATE raid_events
    SET attendee_count = (
      SELECT count(*)::text FROM raid_event_attendance
      WHERE raid_id = trim(p_raid_id) AND event_id = trim(p_event_id)
    )
    WHERE raid_id = trim(p_raid_id) AND event_id = trim(p_event_id);

    UPDATE raids
    SET attendees = (SELECT count(*)::text FROM raid_attendance WHERE raid_id = trim(p_raid_id))
    WHERE raid_id = trim(p_raid_id);
  END IF;

  RETURN jsonb_build_object(
    'added', v_added,
    'already_present', v_already,
    'skipped_same_account', v_same,
    'invalid', v_invalid,
    'added_names', v_added_names,
    'already_present_names', v_already_names,
    'skipped_same_account_names', v_same_names,
    'invalid_names', v_invalid_names
  );
END;
$$;

REVOKE ALL ON FUNCTION public.add_attendees_to_existing_tic(TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_attendees_to_existing_tic(TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_attendees_to_existing_tic(TEXT, TEXT, JSONB) TO service_role;

COMMENT ON TABLE officer_audit_log IS 'Audit trail for officer actions: add_raid, add_tic, delete_event, raid_deleted, add_loot, add_loot_from_log, delete_loot, add_attendee_to_tic, add_attendees_to_tic, remove_attendee_from_tic, edit_event_dkp, edit_event_time, edit_loot_cost. Delta is minimal (short keys) to limit storage and egress.';

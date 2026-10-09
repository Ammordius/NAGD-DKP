-- Officer raid management: RLS policies for INSERT/UPDATE/DELETE and delete_raid RPC.
-- Run in Supabase SQL Editor after supabase-schema.sql.
--
-- Fix for "infinite recursion in policy for relation profiles": policies on profiles
-- must not SELECT from profiles. We use a SECURITY DEFINER function so the check
-- runs with definer (bypasses RLS) and use it everywhere.

-- Helper: current user is officer (SECURITY DEFINER so reading profiles doesn't trigger RLS).
CREATE OR REPLACE FUNCTION public.is_officer()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'officer');
$$;

-- Profiles: one SELECT (own row or officer), one UPDATE (own row or officer)
DROP POLICY IF EXISTS "Users can read own profile" ON profiles;
DROP POLICY IF EXISTS "Officers can read all profiles" ON profiles;
DROP POLICY IF EXISTS "Profiles select" ON profiles;
CREATE POLICY "Profiles select" ON profiles
  FOR SELECT USING (auth.uid() = id OR public.is_officer());

DROP POLICY IF EXISTS "Users can update own profile (limited)" ON profiles;
DROP POLICY IF EXISTS "Officers can update profiles" ON profiles;
DROP POLICY IF EXISTS "Profiles update" ON profiles;
CREATE POLICY "Profiles update" ON profiles
  FOR UPDATE USING (auth.uid() = id OR public.is_officer())
  WITH CHECK (auth.uid() = id OR public.is_officer());

-- Officer-only write policies (use is_officer() for consistency)
DROP POLICY IF EXISTS "Officers manage raids" ON raids;
CREATE POLICY "Officers manage raids" ON raids FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

DROP POLICY IF EXISTS "Officers manage raid_events" ON raid_events;
CREATE POLICY "Officers manage raid_events" ON raid_events FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

DROP POLICY IF EXISTS "Officers manage raid_loot" ON raid_loot;
CREATE POLICY "Officers manage raid_loot" ON raid_loot FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

DROP POLICY IF EXISTS "Officers manage raid_attendance" ON raid_attendance;
CREATE POLICY "Officers manage raid_attendance" ON raid_attendance FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

DROP POLICY IF EXISTS "Officers manage raid_event_attendance" ON raid_event_attendance;
CREATE POLICY "Officers manage raid_event_attendance" ON raid_event_attendance FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

DROP POLICY IF EXISTS "Officers manage raid_classifications" ON raid_classifications;
CREATE POLICY "Officers manage raid_classifications" ON raid_classifications FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

-- active_raiders in main schema also references profiles; fix it to avoid recursion when evaluating officer.
DROP POLICY IF EXISTS "Officers manage active_raiders" ON active_raiders;
CREATE POLICY "Officers manage active_raiders" ON active_raiders FOR ALL TO authenticated
  USING (public.is_officer())
  WITH CHECK (public.is_officer());

-- Deletes leave the DKP triggers enabled. Each DELETE is one statement, so the triggers
-- subtract that statement's earned or spent and refresh the raid cache once.
CREATE OR REPLACE FUNCTION public.delete_raid(p_raid_id TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can delete raids';
  END IF;

  SET LOCAL statement_timeout = '60s';

  -- Attendance and loot first, while the event rows still exist, so the delete triggers
  -- can see each tic value. Event delete then adjusts the period pool.
  DELETE FROM raid_loot WHERE raid_id = p_raid_id;
  DELETE FROM raid_event_attendance WHERE raid_id = p_raid_id;
  DELETE FROM raid_attendance WHERE raid_id = p_raid_id;
  DELETE FROM raid_events WHERE raid_id = p_raid_id;
  DELETE FROM raid_attendance_dkp WHERE raid_id = p_raid_id;
  DELETE FROM raid_attendance_dkp_by_account WHERE raid_id = p_raid_id;
  DELETE FROM raid_dkp_totals WHERE raid_id = p_raid_id;
  DELETE FROM raid_classifications WHERE raid_id = p_raid_id;
  DELETE FROM raids WHERE raid_id = p_raid_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_tic(p_raid_id TEXT, p_event_id TEXT, p_extra_account_ids TEXT[] DEFAULT '{}')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can delete tics';
  END IF;

  SET LOCAL statement_timeout = '120s';

  DELETE FROM raid_event_attendance WHERE raid_id = p_raid_id AND event_id = p_event_id;
  DELETE FROM raid_events WHERE raid_id = p_raid_id AND event_id = p_event_id;

  DELETE FROM raid_attendance ra
  WHERE ra.raid_id = p_raid_id
    AND NOT EXISTS (
      SELECT 1 FROM raid_event_attendance rea
      WHERE rea.raid_id = ra.raid_id AND rea.char_id = ra.char_id
    );

  UPDATE raids
  SET attendees = (SELECT count(*)::text FROM raid_attendance WHERE raid_id = p_raid_id)
  WHERE raid_id = p_raid_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_tic(TEXT, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_tic(TEXT, TEXT, TEXT[]) TO service_role;

CREATE OR REPLACE FUNCTION public.remove_attendee_from_tic(
  p_raid_id TEXT,
  p_event_id TEXT,
  p_char_id TEXT,
  p_extra_account_ids TEXT[] DEFAULT '{}'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can remove attendees from tics';
  END IF;

  IF p_raid_id IS NULL OR trim(p_raid_id) = '' THEN
    RAISE EXCEPTION 'raid_id is required';
  END IF;
  IF p_event_id IS NULL OR trim(p_event_id) = '' THEN
    RAISE EXCEPTION 'event_id is required';
  END IF;
  IF p_char_id IS NULL OR trim(p_char_id) = '' THEN
    RAISE EXCEPTION 'char_id is required';
  END IF;

  SET LOCAL statement_timeout = '60s';

  DELETE FROM raid_event_attendance
  WHERE raid_id = trim(p_raid_id)
    AND event_id = trim(p_event_id)
    AND char_id = trim(p_char_id);

  DELETE FROM raid_attendance ra
  WHERE ra.raid_id = trim(p_raid_id)
    AND ra.char_id = trim(p_char_id)
    AND NOT EXISTS (
      SELECT 1 FROM raid_event_attendance rea
      WHERE rea.raid_id = ra.raid_id AND rea.char_id = ra.char_id
    );

  UPDATE raids
  SET attendees = (SELECT count(*)::text FROM raid_attendance WHERE raid_id = trim(p_raid_id))
  WHERE raid_id = trim(p_raid_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.remove_attendee_from_tic(TEXT, TEXT, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_attendee_from_tic(TEXT, TEXT, TEXT, TEXT[]) TO service_role;

-- One tic and its attendance. Triggers apply earned DKP and refresh that raid's cache.
CREATE OR REPLACE FUNCTION public.add_officer_tic(
  p_raid_id TEXT,
  p_event_id TEXT,
  p_event_order INTEGER,
  p_event_name TEXT,
  p_dkp_value TEXT,
  p_event_time TEXT,
  p_attendees JSONB
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  rec RECORD;
  v_account TEXT;
  v_seen_chars TEXT[] := '{}';
  v_seen_accounts TEXT[] := '{}';
  v_rows JSONB := '[]'::jsonb;
  v_count INT := 0;
  v_name TEXT;
BEGIN
  IF NOT public.is_officer() THEN
    RAISE EXCEPTION 'Only officers can add tics';
  END IF;

  IF p_raid_id IS NULL OR trim(p_raid_id) = '' THEN
    RAISE EXCEPTION 'raid_id is required';
  END IF;
  IF p_event_id IS NULL OR trim(p_event_id) = '' THEN
    RAISE EXCEPTION 'event_id is required';
  END IF;
  IF p_attendees IS NULL OR jsonb_typeof(p_attendees) <> 'array' OR jsonb_array_length(p_attendees) = 0 THEN
    RAISE EXCEPTION 'No attendees to credit';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM raids WHERE raid_id = trim(p_raid_id)) THEN
    RAISE EXCEPTION 'Raid not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM raid_events
    WHERE raid_id = trim(p_raid_id) AND event_id = trim(p_event_id)
  ) THEN
    RAISE EXCEPTION 'That tic already exists';
  END IF;

  SET LOCAL statement_timeout = '120s';

  FOR rec IN
    SELECT
      trim(x->>'char_id') AS char_id,
      trim(COALESCE(x->>'character_name', '')) AS character_name
    FROM jsonb_array_elements(p_attendees) AS x
  LOOP
    IF rec.char_id IS NULL OR rec.char_id = '' THEN
      RAISE EXCEPTION 'Each attendee needs a char_id';
    END IF;
    IF rec.char_id = ANY (v_seen_chars) THEN
      CONTINUE;
    END IF;

    SELECT ca.account_id INTO v_account
    FROM character_account ca
    WHERE ca.char_id = rec.char_id
    LIMIT 1;

    IF v_account IS NOT NULL AND v_account = ANY (v_seen_accounts) THEN
      RAISE EXCEPTION 'Only one character per account per tic';
    END IF;

    v_name := COALESCE(NULLIF(rec.character_name, ''), rec.char_id);
    v_rows := v_rows || jsonb_build_array(jsonb_build_object(
      'char_id', rec.char_id,
      'character_name', v_name,
      'account_id', v_account
    ));
    v_seen_chars := array_append(v_seen_chars, rec.char_id);
    IF v_account IS NOT NULL THEN
      v_seen_accounts := array_append(v_seen_accounts, v_account);
    END IF;
    v_count := v_count + 1;
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'No attendees to credit';
  END IF;

  INSERT INTO raid_events (
    raid_id, event_id, event_order, event_name, dkp_value, attendee_count, event_time
  ) VALUES (
    trim(p_raid_id),
    trim(p_event_id),
    p_event_order,
    COALESCE(NULLIF(trim(p_event_name), ''), 'DKP tic'),
    COALESCE(NULLIF(trim(p_dkp_value), ''), '1'),
    v_count::text,
    NULLIF(trim(p_event_time), '')
  );

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

  UPDATE raids
  SET attendees = (SELECT count(*)::text FROM raid_attendance WHERE raid_id = trim(p_raid_id))
  WHERE raid_id = trim(p_raid_id);
END;
$$;

REVOKE ALL ON FUNCTION public.add_officer_tic(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_officer_tic(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_officer_tic(TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.add_attendee_to_tic(
  p_raid_id TEXT,
  p_event_id TEXT,
  p_char_id TEXT,
  p_character_name TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '60s'
AS $$
DECLARE
  v_account TEXT;
  v_name TEXT;
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
  IF p_char_id IS NULL OR trim(p_char_id) = '' THEN
    RAISE EXCEPTION 'char_id is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM raid_events
    WHERE raid_id = trim(p_raid_id) AND event_id = trim(p_event_id)
  ) THEN
    RAISE EXCEPTION 'Tic not found';
  END IF;
  IF EXISTS (
    SELECT 1 FROM raid_event_attendance
    WHERE raid_id = trim(p_raid_id)
      AND event_id = trim(p_event_id)
      AND char_id = trim(p_char_id)
  ) THEN
    RAISE EXCEPTION 'That character is already on this tic';
  END IF;

  SELECT ca.account_id INTO v_account
  FROM character_account ca
  WHERE ca.char_id = trim(p_char_id)
  LIMIT 1;

  IF v_account IS NOT NULL AND EXISTS (
    SELECT 1
    FROM raid_event_attendance rea
    JOIN character_account ca ON ca.char_id = rea.char_id
    WHERE rea.raid_id = trim(p_raid_id)
      AND rea.event_id = trim(p_event_id)
      AND ca.account_id = v_account
  ) THEN
    RAISE EXCEPTION 'That account already has a character in this tic';
  END IF;

  SET LOCAL statement_timeout = '60s';

  v_name := COALESCE(NULLIF(trim(p_character_name), ''), trim(p_char_id));

  INSERT INTO raid_event_attendance (raid_id, event_id, char_id, character_name, account_id)
  VALUES (trim(p_raid_id), trim(p_event_id), trim(p_char_id), v_name, v_account);

  INSERT INTO raid_attendance (raid_id, char_id, character_name)
  SELECT trim(p_raid_id), trim(p_char_id), v_name
  WHERE NOT EXISTS (
    SELECT 1 FROM raid_attendance ra
    WHERE ra.raid_id = trim(p_raid_id) AND ra.char_id = trim(p_char_id)
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
END;
$$;

REVOKE ALL ON FUNCTION public.add_attendee_to_tic(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.add_attendee_to_tic(TEXT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_attendee_to_tic(TEXT, TEXT, TEXT, TEXT) TO service_role;

DROP FUNCTION IF EXISTS public.set_officer_tic_write_triggers(boolean);

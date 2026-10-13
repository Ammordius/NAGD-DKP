-- Migration: refresh account DKP after linking a character so historical
-- raid_event_attendance credits the account without re-upload.
-- Deployed via apply_migration; mirrored in docs/supabase-schema-full.sql.

CREATE OR REPLACE FUNCTION public.add_character_to_my_account(p_character_name text, p_char_id_override text DEFAULT NULL, p_account_id text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
DECLARE
  v_account_id text;
  v_my_account_id text;
  v_char_id text;
  v_name_trim text;
  v_char_id_use text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT account_id INTO v_my_account_id FROM public.profiles WHERE id = auth.uid();

  IF p_account_id IS NOT NULL AND trim(p_account_id) <> '' THEN
    IF NOT public.is_officer() AND (v_my_account_id IS NULL OR v_my_account_id <> trim(p_account_id)) THEN
      RAISE EXCEPTION 'You can only add characters to your own claimed account';
    END IF;
    v_account_id := trim(p_account_id);
  ELSE
    v_account_id := v_my_account_id;
  END IF;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'No account claimed. Claim an account first.';
  END IF;

  v_name_trim := trim(coalesce(p_character_name, ''));
  IF v_name_trim = '' THEN
    RAISE EXCEPTION 'Character name is required';
  END IF;

  IF p_char_id_override IS NOT NULL AND trim(p_char_id_override) <> '' THEN
    SELECT c.char_id INTO v_char_id FROM characters c WHERE c.char_id = trim(p_char_id_override) LIMIT 1;
    IF v_char_id IS NOT NULL THEN
      INSERT INTO character_account (char_id, account_id) VALUES (v_char_id, v_account_id)
      ON CONFLICT (char_id, account_id) DO NOTHING;
      IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'refresh_account_dkp_summary_internal') THEN
        SET LOCAL statement_timeout = '120s';
        PERFORM refresh_account_dkp_summary_internal();
      END IF;
      RETURN;
    END IF;
  END IF;

  SELECT c.char_id INTO v_char_id
  FROM characters c
  WHERE trim(coalesce(c.name, '')) = v_name_trim
  LIMIT 1;
  IF v_char_id IS NULL THEN
    SELECT c.char_id INTO v_char_id
    FROM characters c
    WHERE c.name ILIKE v_name_trim
    LIMIT 1;
  END IF;

  IF v_char_id IS NOT NULL THEN
    INSERT INTO character_account (char_id, account_id) VALUES (v_char_id, v_account_id)
    ON CONFLICT (char_id, account_id) DO NOTHING;
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'refresh_account_dkp_summary_internal') THEN
      SET LOCAL statement_timeout = '120s';
      PERFORM refresh_account_dkp_summary_internal();
    END IF;
    RETURN;
  END IF;

  IF (SELECT count(*) FROM characters c WHERE c.name ILIKE v_name_trim) > 1 THEN
    RAISE EXCEPTION 'Multiple characters match; use exact name or char_id';
  END IF;

  v_char_id_use := coalesce(nullif(trim(p_char_id_override), ''), v_name_trim);
  INSERT INTO characters (char_id, name) VALUES (v_char_id_use, v_name_trim);
  INSERT INTO character_account (char_id, account_id) VALUES (v_char_id_use, v_account_id)
  ON CONFLICT (char_id, account_id) DO NOTHING;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'refresh_account_dkp_summary_internal') THEN
    SET LOCAL statement_timeout = '120s';
    PERFORM refresh_account_dkp_summary_internal();
  END IF;
  RETURN;
EXCEPTION
  WHEN unique_violation THEN
    SELECT char_id INTO v_char_id FROM characters WHERE char_id = v_char_id_use LIMIT 1;
    IF v_char_id IS NOT NULL THEN
      INSERT INTO character_account (char_id, account_id) VALUES (v_char_id, v_account_id)
      ON CONFLICT (char_id, account_id) DO NOTHING;
      IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'refresh_account_dkp_summary_internal') THEN
        SET LOCAL statement_timeout = '120s';
        PERFORM refresh_account_dkp_summary_internal();
      END IF;
      RETURN;
    END IF;
    RAISE EXCEPTION 'Character with this ID already exists; use a different name or char_id';
END;
$$;
